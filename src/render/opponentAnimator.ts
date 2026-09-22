import * as THREE from "three";
import {
  applyBoneTarget,
  captureBindPose,
  type BoneBindData,
} from "./retargeting/mediapipeToMhrRig";
import type { DrivenBoneName } from "./retargeting/rigJointMap";
import { applyCrouch, captureCrouch, type CrouchRig } from "./retargeting/crouch";
import {
  captureLeg,
  figureForward,
  figureLeft,
  solveLegIk,
  type LegRig,
} from "./retargeting/legIk";
import { Footwork, boxingStance } from "./footwork";
import type { CpuStance } from "../sim/cpuOpponent";
import type { Evasion, GuardPosture } from "../sim/fightState";
import { FOOTWORK_CONFIG, KNOCKDOWN_ANIM, OPPONENT_ANIM } from "../config/tuning";
import { ARM_CHAIN, LOW_GUARD, NO_GUARD, POSES } from "./guardPoses";

// Makes the CPU opponent visible.
//
// sim/cpuOpponent.ts has already decided everything: where the feet are,
// whether the guard is up, whether a slip is committed, whether a punch is on
// its way. This file contains no decisions of its own - it is handed that
// state and turns it into a body. If it ever starts choosing something, the
// choice has escaped the simulation and will not survive being replayed.
//
// The figure is shared with TrainingTarget, which owns the hit reaction. Two
// objects writing one bone would fight every frame, so the split is strict:
//
//   TrainingTarget   c_neck, c_head, c_spine2, c_jaw, root.position
//   this             the four arm bones, and a pivot above the root
//
// TrainingTarget moves the figure within its parent; this moves the parent, so
// knockback and footwork compose instead of overwriting. Which is also right:
// being knocked back while stepping in happens.
//
// Three frame conventions meet here, and a wrong sign produces a figure that
// moves smoothly and confidently in the wrong direction:
//
//   Rig     `l_*` bones are at +X, so the figure's own right is -X, and it
//           faces +Z at identity (see docs/asset-pipeline.md).
//   Stance  `lateral` is positive toward the CPU's own right; `depth` is
//           positive toward the player.
//   Scene   the opponent is turned to face the player, so its frame is the
//           world rotated by pi about Y: x and z both negate.
//
// Each flip is applied on its own line in `update` with its reason, and the
// tests check where the head ends UP in world space, never the sign of a
// field - a sign test passes for code that negates twice.

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
  // swing a slerp does when two directions straddle the back of the sphere -
  // which on an arm is the elbow passing through the ribs.
  out.copy(a).lerp(b, t);
  return out.lengthSq() < 1e-9 ? out.copy(b) : out.normalize();
}

/** The state of the fight, as far as the body is concerned. */
export interface OpponentVisualState {
  stance: CpuStance;
  guard: GuardPosture;
  evasion: Evasion;
  /** 0-1 wind-up progress. Non-zero only while telegraphing. */
  windup: number;
  /**
   * 1 while this fighter is on the canvas, 0 while they are on their feet.
   *
   * A target, not a progress value: the fall and the rise are shaped here, in
   * the render layer, because how long a body takes to go over is not a rule.
   * What the simulation decides is when it starts and when the fighter is back
   * up, and that is what this carries.
   */
  down: number;
  /** 0-1: how hurt they are. Drives the sway and the sagging guard. */
  hurt: number;
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
  down: 0,
  hurt: 0,
}) as OpponentVisualState;

const _pose = { uparm: new THREE.Vector3(), lowarm: new THREE.Vector3() };
const _aimed = { uparm: new THREE.Vector3(), lowarm: new THREE.Vector3() };
const _world = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _ground = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _left = new THREE.Vector3();
const _footTarget = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _hipFoot = new THREE.Vector3();

export class OpponentAnimator {
  /**
   * The group the figure hangs under. Footwork moves this; the figure's own
   * position stays owned by TrainingTarget's knockback.
   */
  readonly pivot: THREE.Group;

  private binds: Map<DrivenBoneName, BoneBindData>;
  private figure: THREE.Object3D;
  /** Legs and waist, for a duck that bends rather than sinks. Shared with
   *  the player's own rig driver - one duck, one implementation. */
  private crouchRig: CrouchRig | null;

  /**
   * World units per torso unit, measured off the rig rather than typed in.
   *
   * The stance is in torso units because that is the unit perception produces
   * and the unit the CPU reasons in. Turning it into metres needs the figure's
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
   * and the only way to tell them apart was to read the damage feed. The CPU
   * already picks a target height; this is the render layer finally using it.
   */
  private aim = { left: 0, right: 0 };
  /**
   * Lateral aim of the punch in flight, per hand, in the figure's own frame.
   *
   * The CPU has always picked a named target - chin, jaw, temple, liver, ribs -
   * and every one of them carries a lateral offset. Only the height was ever
   * animated, so a dig to the liver and a shot at the temple left along the
   * same centre line and arrived at opposite corners of the body. The punch
   * now travels to the side it was actually aimed at.
   */
  private cross = { left: 0, right: 0 };

  /**
   * The feet, and the legs that reach them.
   *
   * Before this existed the opponent travelled by translating its whole body
   * with its legs held at bind pose - it glided around the ring like a chess
   * piece. The stance the simulation commands is unchanged; what changed is
   * that the feet now stay on the canvas and the knees bend to account for it.
   */
  private legs: { left: LegRig | null; right: LegRig | null };
  private footwork: Footwork | null = null;
  /**
   * Canvas height, in the frame the feet are tracked in.
   *
   * Measured from the rig's own ankles on the first update rather than at
   * construction, because the figure is not yet parented into the scene when
   * the constructor runs - reading a world position there would measure the
   * figure's own local space and plant the feet at the wrong height.
   */
  private groundY = 0;

  /**
   * Smoothed knockdown and hurt, 0-1.
   *
   * Chased here rather than taken straight from the state, with a different
   * rate each way: a fighter goes over in about a third of a second and takes
   * the best part of one to get back up. A single time constant for both makes
   * getting up look like falling in reverse, which is the one thing it is not.
   */
  private shownDown = 0;
  private shownHurt = 0;
  /** Phase of the hurt sway, seconds. Advanced by dt so it is frame-rate
   *  independent rather than keyed off a wall clock. */
  private wobbleT = 0;

  constructor(figure: THREE.Object3D) {
    this.figure = figure;
    this.binds = captureBindPose(figure);
    this.crouchRig = captureCrouch(figure, this.binds);
    this.legs = { left: captureLeg(this.binds, "l"), right: captureLeg(this.binds, "r") };

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

    // Posed on guard immediately, not on the first update.
    //
    // The mesh's bind pose is a T-pose. An animator that only posed the arms
    // once `update` was first called would put the opponent on screen with its
    // arms straight out sideways for a frame - and a frame is plenty, since
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
   * Separate from `update` because a strike is an instant - the CPU emits it on
   * one tick and never mentions it again - whereas the arm coming out and
   * going back is most of a second. Folding it into the per-frame state would
   * have meant either the punch was invisible or the animator had to infer it
   * from a state transition it might miss on a long frame.
   */
  throw(hand: "left" | "right", height = 1.2, lateral = 0): void {
    this.releasing[hand] = OPPONENT_ANIM.punchSeconds;
    // `height` is in the torso-normalised body frame the whole game resolves
    // strikes in: 0 is the belt, 1.0 the shoulder line, and the head sits
    // above ~1.15. Mapped to a signed aim so the punch visibly travels to
    // where it was actually thrown.
    const shoulders = 1;
    this.aim[hand] = clamp((height - shoulders) / 0.5, -1, 1);
    // `lateral` is an ImpactPoint offset: positive is the puncher's own right.
    // The rig's `l_*` bones sit at +X, so the figure's right is -X, and the
    // sign flips exactly once, here. Stored in the figure's frame so `poseArm`
    // can apply it after its left/right mirror - folding it in before would
    // negate it for one hand and send that hand's punches to the wrong side.
    this.cross[hand] = -clamp(lateral / OPPONENT_ANIM.aimFullLateral, -1, 1);
  }

  update(dt: number, s: OpponentVisualState): void {
    this.updateCondition(dt, s);
    this.updateArms(dt, s);
    this.updateBody(s);
    this.updateFeet(dt);
  }

  /** How far down and how hurt the body currently is. Runs first, because
   *  everything below reads the smoothed values. */
  private updateCondition(dt: number, s: OpponentVisualState): void {
    const want = s.down > 0.5 ? 1 : 0;
    const seconds = want > this.shownDown
      ? KNOCKDOWN_ANIM.fallSeconds
      : KNOCKDOWN_ANIM.riseSeconds;
    // Linear rather than an exponential chase, so "down" is actually reached.
    // An exponential never arrives, and a fighter permanently at 0.98 of the
    // way down never quite lies on the canvas.
    const step = dt / seconds;
    this.shownDown += clamp(want - this.shownDown, -step, step);
    this.shownHurt += (s.hurt - this.shownHurt) * (1 - Math.exp(-dt / 0.18));
    this.wobbleT += dt;
  }

  /** Smoothed knockdown progress, 0-1. Exposed for the tests and the HUD. */
  get downAmount(): number {
    return this.shownDown;
  }

  /**
   * Plants the feet, steps them, and bends the legs to reach them.
   *
   * Runs after `updateBody`, and that order is the whole point: the body has
   * already been moved to where the simulation says it should be, so what the
   * legs solve against is the real, current gap between the hips and the
   * canvas. Solving first would bend the knees for last frame's position.
   */
  private updateFeet(dt: number): void {
    const { left, right } = this.legs;
    if (!left || !right) return;

    // The figure's transform has just been changed by `updateBody`, and the
    // feet live in the pivot's parent frame - so the matrices have to be
    // current before anything is read out of them.
    this.pivot.updateMatrixWorld(true);
    this.figure.getWorldPosition(_ground);

    if (!this.footwork) {
      // First frame with the figure actually in the scene: measure the canvas
      // off the rig's own ankles and set the stance around where it stands.
      const lFoot = this.figure.getObjectByName("l_foot");
      const rFoot = this.figure.getObjectByName("r_foot");
      if (!lFoot || !rFoot) return;
      lFoot.getWorldPosition(_ankle);
      rFoot.getWorldPosition(_footTarget);
      this.groundY = (_ankle.y + _footTarget.y) / 2;

      this.footwork = new Footwork(
        this.stanceOffsets(),
        { x: _ground.x, z: _ground.z },
        // FOOTWORK_CONFIG is in torso units; the feet are tracked in world
        // units. Without this the step trigger is about twice what it reads as
        // and the feet drag visibly before picking themselves up.
        this.torsoWorld
      );
      // Started from where the rig actually has its feet, then allowed to step
      // into the stance over the next half second. Planting straight onto the
      // stance offsets teleports both ankles on the first visible frame.
      this.footwork.plantAt(
        { x: _ankle.x, z: _ankle.z },
        { x: _footTarget.x, z: _footTarget.z }
      );
    }

    this.footwork.update(dt, { x: _ground.x, z: _ground.z });

    figureForward(this.figure, _forward);
    for (const side of ["left", "right"] as const) {
      const leg = this.legs[side]!;
      const foot = side === "left" ? this.footwork.left : this.footwork.right;
      // `lift` is already in world units - Footwork was handed the torso scale.
      _footTarget.set(foot.x, this.groundY + foot.lift, foot.z);
      // Going over, the feet come in under the hips.
      //
      // Not a flourish - it is what keeps the solve reachable. The hips swing
      // back and down through most of a right angle during a fall, and a foot
      // left planted where the fighter was standing ends up further from the
      // hip than the leg is long. The IK would then straighten and haul the
      // ankle off the canvas, which is the "fighter on tiptoe" failure the
      // standing bend was added to prevent, arriving by another route.
      if (this.shownDown > 0.001) {
        leg.thigh.bone.getWorldPosition(_ankle);
        _footTarget.lerp(
          _hipFoot.set(_ankle.x, this.groundY, _ankle.z),
          this.shownDown
        );
      }
      solveLegIk(leg, _footTarget, _forward);
    }
  }

  /** The stance the feet hold, in the frame they are tracked in. */
  private stanceOffsets() {
    figureForward(this.figure, _forward);
    figureLeft(this.figure, _left);
    return boxingStance(
      // Orthodox. The simulation has no notion of the opponent's stance, and
      // inventing one here would be this layer making a decision - which is
      // exactly what its header forbids. Orthodox is the honest default: it is
      // what most fighters are, and it is a pose, not a rule.
      "left",
      FOOTWORK_CONFIG.stanceWidth * this.torsoWorld,
      FOOTWORK_CONFIG.stanceStagger * this.torsoWorld,
      { x: _left.x, z: _left.z },
      { x: _forward.x, z: _forward.z }
    );
  }

  private updateArms(dt: number, s: OpponentVisualState): void {
    for (const hand of ["left", "right"] as const) {
      // Where this arm wants to be, before the release animation.
      //
      // The wind-up drives it negative - toward `cocked` - which is the whole
      // telegraph. `windup` runs 0 to 1 over the CPU's wind-up window, so the
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

      // Chased, and rate-limited. The two do different jobs and both are
      // needed. The exponential chase shapes the motion; the rate cap bounds
      // it. A chase alone still covers most of a large step in one frame - at
      // a 45ms time constant that is about a third of the swing per frame, and
      // for an arm that is a glove jumping through the player's head. The cap
      // is the one that holds when the input steps or a frame is dropped,
      // which is precisely when it matters.
      const a = 1 - Math.exp(-dt / OPPONENT_ANIM.armTau);
      const wanted = (target - this.extension[hand]) * a;
      const limit = OPPONENT_ANIM.maxExtendRate * dt;
      this.extension[hand] +=
        wanted > limit ? limit : wanted < -limit ? -limit : wanted;

      // A hurt fighter's hands come down, and a fighter on the canvas has no
      // guard at all. The sim already refuses a guard from a stunned fighter -
      // this is that rule finally being visible instead of only scored.
      const sag = Math.max(this.shownHurt * KNOCKDOWN_ANIM.guardSag, this.shownDown);
      const guard: GuardPosture = sag > 0.5 ? "none" : s.guard;
      this.poseArm(
        hand,
        this.extension[hand],
        guard,
        this.aim[hand],
        this.cross[hand]
      );
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
    aim = 0,
    cross = 0
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
    // left arm with x negated - done here, once, rather than by authoring two
    // pose tables that could drift apart.
    const mirror = hand === "right" ? -1 : 1;

    // Swing across the body toward the target's lateral offset, but only on
    // the way out - a punch being drawn back has no target to aim at, and a
    // guard certainly does not. Added after the mirror below, in the figure's
    // own frame, because it is a direction in space rather than a handed pose.
    const across = extend > 0 ? cross * OPPONENT_ANIM.aimCross * extend : 0;

    const bones = ARM_CHAIN[hand];
    for (const part of ["uparm", "lowarm"] as const) {
      const bind = this.binds.get(bones[part]);
      if (!bind) continue;
      const local = _pose[part];
      // Figure frame -> world. The figure is turned to face the player, so its
      // own axes are the world's rotated; asking the rig for the rotation
      // rather than assuming pi means a stage that places the opponent at some
      // other angle still poses correctly.
      this.figure.getWorldQuaternion(_quat);
      _world
        .set(local.x * mirror + across, local.y, local.z)
        .applyQuaternion(_quat);
      applyBoneTarget(bind, { x: _world.x, y: _world.y, z: _world.z });
    }
  }

  private updateBody(s: OpponentVisualState): void {
    const { stance, evasion } = s;
    const scale = this.torsoWorld;

    // --- The three frame conversions, one per line. ---
    // `lateral` is toward the CPU's own right; the figure's own right is -X;
    // the figure is turned to face the player, so its -X is the world's +X.
    // The two negations cancel: world x = +lateral.
    this.pivot.position.x = stance.lateral * scale;
    // `depth` is toward the player, who stands at smaller z than the opponent.
    this.pivot.position.z = -stance.depth * scale;
    // A crouch folds the waist and drops the hips by the height a bent leg
    // gives up - the same module the player's duck uses, so the two fighters
    // duck the same way. Translating the body downward instead, which is what
    // this used to do, reads as the figure sinking through the canvas with its
    // legs straight.
    //
    // Its leg rotations are then superseded by the IK in `updateFeet`, and
    // deliberately so: `crouchDrop` still decides how far the hips fall, but
    // once the feet are planted the knee angle that reaches them is no longer a
    // free choice - it is whatever the hip height and the foot position imply.
    // Keeping the drop formula here is what keeps the duck exactly as deep as
    // it has always been while the legs become correct underneath it.
    // The standing bend is added to whatever the fight asked for, so a fighter
    // at rest already has its knees soft and a duck deepens an existing bend
    // rather than starting from a locked leg. See FOOTWORK_CONFIG.standingBend
    // for why this is load-bearing and not a flourish.
    // Going down folds the knees on top of whatever the fight asked for. A
    // body pitching over with straight legs reads as a falling plank.
    const crouch = Math.min(
      1,
      stance.crouch +
        FOOTWORK_CONFIG.standingBend +
        this.shownDown * KNOCKDOWN_ANIM.hipFold
    );
    const drop = this.crouchRig
      ? applyCrouch(this.figure, this.crouchRig, crouch, { fromBind: true })
      : 0;
    this.pivot.position.y = -drop;

    // The lean, plus the hurt sway.
    //
    // Rotating about world +Z carries the head toward -X, so the sign is
    // inverted to move it the way the stance says. The pivot sits at the feet,
    // so this rotation displaces the head and leaves the feet - an accurate
    // description of both a slip and a fighter who cannot hold their own
    // weight steady.
    const sway =
      this.shownHurt > 0.01
        ? Math.sin(this.wobbleT * KNOCKDOWN_ANIM.wobbleHz * Math.PI * 2) *
          KNOCKDOWN_ANIM.wobble *
          this.shownHurt
        : 0;
    this.pivot.rotation.z = -stance.lean + sway;

    // The fall.
    //
    // About the pivot, which sits at the feet, so the body pitches over from
    // the ground rather than sinking through it. The opponent stands at +Z
    // with the player at the origin, and a positive rotation about world +X
    // carries a point above the pivot toward +Z - away from the player, which
    // is the direction a fighter goes when they are hit from the front.
    this.pivot.rotation.x = this.shownDown * KNOCKDOWN_ANIM.fallAngle;

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
    // A fighter put back on their mark is on their feet. Leaving these set
    // would start the next round with the figure still folded over.
    this.shownDown = 0;
    this.shownHurt = 0;
    this.pivot.position.set(0, 0, 0);
    this.pivot.rotation.set(0, 0, 0);
    this.poseArm("left", 0, "high");
    this.poseArm("right", 0, "high");
    // Knees already soft, on the mark. The standing bend sinks the hips a few
    // centimetres, and arriving at it on the first update instead of here moved
    // the whole figure - gloves included - in a single frame, which is exactly
    // what the arm's own no-snapping test is there to catch.
    if (this.crouchRig) {
      this.pivot.position.y = -applyCrouch(
        this.figure,
        this.crouchRig,
        FOOTWORK_CONFIG.standingBend,
        { fromBind: true }
      );
    }
    // Feet back under the body, planted, with no step in flight. A reset is a
    // fighter being placed on their mark between rounds, not one scrambling
    // across the canvas to reach it.
    if (this.footwork) {
      this.pivot.updateMatrixWorld(true);
      this.figure.getWorldPosition(_ground);
      this.footwork.setOffsets(this.stanceOffsets());
      this.footwork.plantBoth({ x: _ground.x, z: _ground.z });
    }
  }

  /** World position of the figure's head, for tests and camera framing. */
  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const head = this.figure.getObjectByName("c_head");
    if (!head) return out.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    return head.getWorldPosition(out);
  }

  /** World position of one ankle, for tests and for footfall effects. */
  footWorld(side: "left" | "right", out = new THREE.Vector3()): THREE.Vector3 {
    const node = this.figure.getObjectByName(side === "left" ? "l_foot" : "r_foot");
    if (!node) return out.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    return node.getWorldPosition(out);
  }

  /** Which foot is mid-step, or null when both are planted. For the debug HUD
   *  and for tests that need to know a step is in flight rather than guess. */
  get steppingFoot(): "left" | "right" | null {
    return this.footwork?.steppingFoot ?? null;
  }

  /** World position of one glove, for tests and for aiming impact effects. */
  handWorld(hand: "left" | "right", out = new THREE.Vector3()): THREE.Vector3 {
    const node = this.figure.getObjectByName(hand === "left" ? "l_wrist" : "r_wrist");
    if (!node) return out.set(0, 0, 0);
    this.pivot.updateMatrixWorld(true);
    return node.getWorldPosition(out);
  }
}
