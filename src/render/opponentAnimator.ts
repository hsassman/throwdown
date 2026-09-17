import * as THREE from "three";
import {
  applyBoneTarget,
  captureBindPose,
  type BoneBindData,
} from "./retargeting/mediapipeToMhrRig";
import type { DrivenBoneName } from "./retargeting/rigJointMap";
import { applyCrouch, captureCrouch, type CrouchRig } from "./retargeting/crouch";
import type { AiStance } from "../sim/aiOpponent";
import type { Evasion, GuardPosture } from "../sim/fightState";
import { OPPONENT_ANIM } from "../config/tuning";

// Makes the CPU opponent visible.
// WHAT THIS IS FOR
//
// `sim/aiOpponent.ts` already decided everything: where the feet are, whether
// the guard is up, whether a slip is committed, and whether a punch is on its
// way. None of that was visible. A fight against an opponent whose decisions
// you cannot see is a fight against a number going down — the player has no
// way to tell a telegraph from a feint, or a slip from the tracking dropping
// their punch.
//
// So this file contains no decisions at all. It is handed the AI's state and
// turns it into a body. If it ever starts choosing something, that choice has
// escaped the simulation and will not survive being replayed by the netcode.
// HOW IT SHARES THE FIGURE WITH TrainingTarget
//
// The same figure is already driven by `TrainingTarget`, which owns the hit
// REACTION: the neck, head, spine and jaw, plus `root.position` for knockback.
// Two objects writing one bone would fight frame by frame, so the split is by
// bone and it is strict:
//
//   TrainingTarget   c_neck, c_head, c_spine2, c_jaw, root.position
//   this             the four arm bones, and a PIVOT above the root
//
// The pivot is the reason there is no conflict over position. TrainingTarget
// moves the figure within its parent; this moves the parent. Knockback and
// footwork then compose rather than overwrite, which is also physically right
// — being knocked back while stepping in is a real thing that happens.
// FRAMES, AND THE FOUR SIGN FLIPS
//
// This is the part that is easy to get wrong and hard to see. Three separate
// conventions meet here:
//
//   The RIG:    `l_*` bones are at +X, so the figure's own RIGHT is -X, and
//               the figure faces +Z at identity (verified against the asset,
//               see docs/ASSET-PIPELINE.md).
//   The STANCE: `lateral` is positive toward the AI's own RIGHT, and `depth`
//               is positive toward the PLAYER.
//   The SCENE:  the opponent is turned to face the player, so its own frame is
//               the world rotated by pi about Y — x and z both negate.
//
// Every one of those flips is applied in `update` below, each on its own line
// with the reason, and each asserted in the tests by checking where the head
// actually ENDS UP in world space rather than by checking the sign of a field.
// A wrong sign here produces a figure that moves smoothly and confidently in
// exactly the wrong direction, which reads as a physics quirk rather than a
// bug.

/** An arm pose, as unit-ish directions in the FIGURE's own frame. */
interface ArmPose {
  uparm: THREE.Vector3;
  lowarm: THREE.Vector3;
}

/**
 * The three arm poses everything is interpolated between.
 *
 * Expressed for the LEFT arm and mirrored in x for the right, so a change to
 * the guard cannot accidentally be made to one side only — which is precisely
 * the mirrored-handedness class of bug this project has already hit twice.
 */
const POSES: Record<"cocked" | "guard" | "extended", ArmPose> = {
  // Drawn back: elbow behind the ribs, glove up beside the ear. This is the
  // telegraph, and it has to be large — it is the only warning the player
  // gets, and their own input arrives through a webcam at ~15 FPS, so a subtle
  // wind-up is not a wind-up.
  cocked: {
    uparm: new THREE.Vector3(0.22, -0.82, -0.53),
    lowarm: new THREE.Vector3(-0.24, 0.73, -0.64),
  },
  // Hands at the cheekbones, elbows down and tucked against the ribs.
  //
  // The angles are anatomical, not decorative. The upper arm hangs down and
  // slightly FORWARD and the forearm comes up and slightly IN, which leaves
  // about 55 degrees at the elbow — a real guard. The previous values had the
  // upper arm hanging dead vertical with the elbow flared outward and the
  // forearm folded almost back on it, which reads as a shrug rather than a
  // guard and left the gloves out at the sides of the head instead of in
  // front of it.
  guard: {
    uparm: new THREE.Vector3(0.12, -0.93, 0.35),
    lowarm: new THREE.Vector3(-0.18, 0.8, 0.57),
  },
  // Committed: the arm straight out along the punch. The `z` here is nominal —
  // `throw()` replaces the vertical component so the punch actually points at
  // what it is aimed at.
  extended: {
    uparm: new THREE.Vector3(0.1, -0.12, 0.99),
    lowarm: new THREE.Vector3(0.02, -0.02, 1),
  },
};

/** Forearms across the belly. The low guard, which the AI really uses. */
const LOW_GUARD: ArmPose = {
  uparm: new THREE.Vector3(0.1, -0.96, 0.26),
  lowarm: new THREE.Vector3(-0.55, 0.3, 0.78),
};

/** Hands down. What the AI drops into when it commits to a punch, and what
 *  makes counter-punching work. */
const NO_GUARD: ArmPose = {
  uparm: new THREE.Vector3(0.14, -0.97, 0.18),
  lowarm: new THREE.Vector3(0.05, -0.75, 0.66),
};

const ARM_BONES: Record<"left" | "right", { uparm: DrivenBoneName; lowarm: DrivenBoneName }> =
  {
    left: { uparm: "l_uparm", lowarm: "l_lowarm" },
    right: { uparm: "r_uparm", lowarm: "r_lowarm" },
  };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerpDir(
  out: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number
): THREE.Vector3 {
  // Lerp then normalise, rather than slerp. The poses are never antipodal, so
  // the two agree closely, and a plain lerp cannot produce the long-way-round
  // swing a slerp does when two directions straddle the back of the sphere —
  // which on an arm is the elbow passing through the ribs.
  out.copy(a).lerp(b, t);
  return out.lengthSq() < 1e-9 ? out.copy(b) : out.normalize();
}

/** The state of the fight, as far as the body is concerned. */
export interface OpponentVisualState {
  stance: AiStance;
  guard: GuardPosture;
  evasion: Evasion;
  /** 0-1 wind-up progress. Non-zero only while telegraphing. */
  windup: number;
}

/**
 * What the body does with no live opponent driving it: stand on guard.
 *
 * Frozen and shared. The render loop reads this on every frame where the fight
 * is not running, and a fresh object per frame would allocate 60 times a
 * second for a value that never changes.
 */
export const IDLE_OPPONENT: OpponentVisualState = Object.freeze({
  stance: Object.freeze({ lateral: 0, depth: 0, crouch: 0, lean: 0 }),
  guard: "high",
  evasion: "none",
  windup: 0,
}) as OpponentVisualState;

const _pose = { uparm: new THREE.Vector3(), lowarm: new THREE.Vector3() };
const _aimed = { uparm: new THREE.Vector3(), lowarm: new THREE.Vector3() };
const _world = new THREE.Vector3();
const _quat = new THREE.Quaternion();

export class OpponentAnimator {
  /**
   * The group the figure hangs under. Footwork moves THIS; the figure's own
   * position stays owned by TrainingTarget's knockback.
   */
  readonly pivot: THREE.Group;

  private binds: Map<DrivenBoneName, BoneBindData>;
  private figure: THREE.Object3D;
  /** Legs and waist, for a duck that bends rather than sinks. Shared with
   *  the player's own rig driver — one duck, one implementation. */
  private crouchRig: CrouchRig | null;

  /**
   * World units per torso unit, measured off the rig rather than typed in.
   *
   * The stance is in torso units because that is the unit perception produces
   * and the unit the AI reasons in. Turning it into metres needs the figure's
   * own shoulder-to-hip distance, and measuring it here means a re-export at a
   * different scale moves the opponent correctly without anyone remembering to
   * update a constant.
   */
  private readonly torsoWorld: number;

  /** Per-hand extension, -1 fully cocked, 0 on guard, +1 fully extended. */
  private extension = { left: 0, right: 0 };
  /** Seconds left of the release animation, per hand. */
  private releasing = { left: 0, right: 0 };
  /**
   * Vertical aim of the punch in flight, per hand: +1 is a head shot, -1 a dig
   * to the body.
   *
   * Without this every punch left along the same line regardless of where it
   * was aimed, so a liver shot and a shot at the chin were the same animation
   * and the only way to tell them apart was to read the damage feed. The AI
   * already picks a target height; this is the render layer finally using it.
   */
  private aim = { left: 0, right: 0 };

  constructor(figure: THREE.Object3D) {
    this.figure = figure;
    this.binds = captureBindPose(figure);
    this.crouchRig = captureCrouch(figure, this.binds);

    this.pivot = new THREE.Group();
    this.pivot.name = "opponentPivot";

    const shoulder = figure.getObjectByName("l_uparm");
    const hip = figure.getObjectByName("l_upleg");
    if (shoulder && hip) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      shoulder.getWorldPosition(a);
      hip.getWorldPosition(b);
      this.torsoWorld = Math.max(0.05, a.distanceTo(b));
    } else {
      // A figure missing the bones this whole layer drives is already broken;
      // a sane fallback keeps the opponent on the stage rather than at the
      // origin while that is diagnosed.
      this.torsoWorld = OPPONENT_ANIM.fallbackTorsoWorld;
    }

    // Posed on guard immediately, NOT on the first update.
    //
    // The mesh's bind pose is a T-pose. An animator that only posed the arms
    // once `update` was first called would put the opponent on screen with its
    // arms straight out sideways for a frame — and a frame is plenty, since
    // the figure is spawned at the start of a round, which is exactly when the
    // player is looking at it. A test caught this by measuring the glove's
    // largest single-frame travel: the jump from T-pose to guard was four
    // times anything the fight itself produces.
    this.reset();
  }

  /** Torso-to-world scale, exposed so tests can check against the real rig. */
  get torsoScale(): number {
    return this.torsoWorld;
  }

  /** Current arm extension, for tests and the debug HUD. */
  get armExtension(): { left: number; right: number } {
    return { ...this.extension };
  }

  /**
   * A punch has been released by this hand.
   *
   * Separate from `update` because a strike is an INSTANT — the AI emits it on
   * one tick and never mentions it again — whereas the arm coming out and
   * going back is most of a second. Folding it into the per-frame state would
   * have meant either the punch was invisible or the animator had to infer it
   * from a state transition it might miss on a long frame.
   */
  throw(hand: "left" | "right", height = 1.2): void {
    this.releasing[hand] = OPPONENT_ANIM.punchSeconds;
    // `height` is in the torso-normalised body frame the whole game resolves
    // strikes in: 0 is the belt, 1.0 the shoulder line, and the head sits
    // above ~1.15. Mapped to a signed aim so the punch visibly travels to
    // where it was actually thrown.
    const shoulders = 1;
    this.aim[hand] = clamp((height - shoulders) / 0.5, -1, 1);
  }

  update(dt: number, s: OpponentVisualState): void {
    this.updateArms(dt, s);
    this.updateBody(s);
  }

  private updateArms(dt: number, s: OpponentVisualState): void {
    for (const hand of ["left", "right"] as const) {
      // Where this arm wants to be, before the release animation.
      //
      // The wind-up drives it NEGATIVE — toward `cocked` — which is the whole
      // telegraph. `windup` runs 0 to 1 over the AI's wind-up window, so the
      // arm draws back progressively rather than snapping into a pose.
      let target = 0;
      if (this.releasing[hand] > 0) {
        this.releasing[hand] = Math.max(0, this.releasing[hand] - dt);
        // Out fast, back slower: the punch is the fast half and the recovery
        // is the half that leaves you open. A symmetric animation reads as a
        // piston rather than a person.
        const progress = 1 - this.releasing[hand] / OPPONENT_ANIM.punchSeconds;
        target =
          progress < OPPONENT_ANIM.punchOutShare
            ? progress / OPPONENT_ANIM.punchOutShare
            : 1 - (progress - OPPONENT_ANIM.punchOutShare) / (1 - OPPONENT_ANIM.punchOutShare);
      } else if (s.windup > 0) {
        target = -s.windup;
      }

      // Chased, AND rate-limited. The two do different jobs and both are
      // needed. The exponential chase shapes the motion; the rate cap bounds
      // it. A chase alone still covers most of a large step in one frame — at
      // a 45ms time constant that is about a third of the swing per frame, and
      // for an arm that is a glove jumping through the player's head. The cap
      // is the one that holds when the input steps or a frame is dropped,
      // which is precisely when it matters.
      const a = 1 - Math.exp(-dt / OPPONENT_ANIM.armTau);
      const wanted = (target - this.extension[hand]) * a;
      const limit = OPPONENT_ANIM.maxExtendRate * dt;
      this.extension[hand] +=
        wanted > limit ? limit : wanted < -limit ? -limit : wanted;

      this.poseArm(hand, this.extension[hand], s.guard, this.aim[hand]);
    }
  }

  /**
   * Builds one arm's pose and applies it.
   *
   * `extend` is the axis everything rides on: negative interpolates toward the
   * cocked pose, positive toward the extended one, and the guard sits at zero.
   * One axis rather than a set of states means there is no frame in which the
   * arm is between two animations with nothing driving it.
   */
  private poseArm(
    hand: "left" | "right",
    extend: number,
    guard: GuardPosture,
    aim = 0
  ): void {
    const rest =
      guard === "low" ? LOW_GUARD : guard === "none" ? NO_GUARD : POSES.guard;

    if (extend >= 0) {
      // The punch's own line. A body shot drops the whole arm and a head shot
      // lifts it, rather than every punch leaving along one rail.
      _aimed.uparm
        .copy(POSES.extended.uparm)
        .setY(POSES.extended.uparm.y + aim * OPPONENT_ANIM.aimRise)
        .normalize();
      _aimed.lowarm
        .copy(POSES.extended.lowarm)
        .setY(POSES.extended.lowarm.y + aim * OPPONENT_ANIM.aimRise)
        .normalize();
      lerpDir(_pose.uparm, rest.uparm, _aimed.uparm, extend);
      lerpDir(_pose.lowarm, rest.lowarm, _aimed.lowarm, extend);
    } else {
      lerpDir(_pose.uparm, rest.uparm, POSES.cocked.uparm, -extend);
      lerpDir(_pose.lowarm, rest.lowarm, POSES.cocked.lowarm, -extend);
    }

    // The mirror. The rig's `l_*` bones are at +X, so the right arm is the
    // left arm with x negated — done HERE, once, rather than by authoring two
    // pose tables that could drift apart.
    const mirror = hand === "right" ? -1 : 1;

    const bones = ARM_BONES[hand];
    for (const part of ["uparm", "lowarm"] as const) {
      const bind = this.binds.get(bones[part]);
      if (!bind) continue;
      const local = _pose[part];
      // Figure frame -> world. The figure is turned to face the player, so its
      // own axes are the world's rotated; asking the rig for the rotation
      // rather than assuming pi means a stage that places the opponent at some
      // other angle still poses correctly.
      this.figure.getWorldQuaternion(_quat);
      _world.set(local.x * mirror, local.y, local.z).applyQuaternion(_quat);
      applyBoneTarget(bind, { x: _world.x, y: _world.y, z: _world.z });
    }
  }

  private updateBody(s: OpponentVisualState): void {
    const { stance, evasion } = s;
    const scale = this.torsoWorld;

    // --- The three frame conversions, one per line. ---
    // `lateral` is toward the AI's own right; the figure's own right is -X;
    // the figure is turned to face the player, so its -X is the world's +X.
    // The two negations cancel: world x = +lateral.
    this.pivot.position.x = stance.lateral * scale;
    // `depth` is toward the PLAYER, who stands at smaller z than the opponent.
    this.pivot.position.z = -stance.depth * scale;
    // A crouch BENDS the legs and folds the waist, and the pivot follows the
    // hips down by exactly the height the knees gave up — the same module the
    // player's duck uses, so the two fighters duck the same way. Translating
    // the body downward instead, which is what this used to do, reads as the
    // figure sinking through the canvas with its legs straight.
    const drop = this.crouchRig
      ? applyCrouch(this.figure, this.crouchRig, stance.crouch, {
          fromBind: true,
        })
      : 0;
    this.pivot.position.y = -drop;

    // The lean. Rotating about world +Z carries the head toward -X, so the
    // sign is inverted to move it the way the stance says. The pivot sits at
    // the feet, so this rotation displaces the head and leaves the feet — an
    // accurate description of what a slip is.
    this.pivot.rotation.z = -stance.lean;

    // The waist fold lives in the crouch now, so there is nothing left for the
    // pivot to pitch. `evasion` is still read because a duck and a plain low
    // stance are different things to the fight, even though they now look the
    // same from the hips down.
    void evasion;
  }

  /** Puts the arms back on guard and the body back on its mark. */
  reset(): void {
    this.extension.left = 0;
    this.extension.right = 0;
    this.releasing.left = 0;
    this.releasing.right = 0;
    this.pivot.position.set(0, 0, 0);
    this.pivot.rotation.set(0, 0, 0);
    this.poseArm("left", 0, "high");
    this.poseArm("right", 0, "high");
  }

  /** World position of the figure's head, for tests and camera framing. */
  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const head = this.figure.getObjectByName("c_head");
    if (!head) return out.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    return head.getWorldPosition(out);
  }

  /** World position of one glove, for tests and for aiming impact effects. */
  handWorld(hand: "left" | "right", out = new THREE.Vector3()): THREE.Vector3 {
    const node = this.figure.getObjectByName(hand === "left" ? "l_wrist" : "r_wrist");
    if (!node) return out.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    return node.getWorldPosition(out);
  }
}
