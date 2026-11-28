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
  /** 1 while this fighter is on the canvas, 0 while they are on their feet. */
  down: number;
  /** 0-1: how hurt they are. Drives the sway and the sagging guard. */
  hurt: number;
}

/** What the body does with no live opponent driving it: stand on guard. */
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

  /** World units per torso unit, measured off the rig rather than typed in. */
  private readonly torsoWorld: number;

  /** Per-hand extension, -1 fully cocked, 0 on guard, +1 fully extended. */
  private extension = { left: 0, right: 0 };
  /** Seconds left of the release animation, per hand. */
  private releasing = { left: 0, right: 0 };
  /**
   * Vertical aim of the punch in flight, per hand: +1 is a head shot, -1 a dig
   * to the body.
   */
  private aim = { left: 0, right: 0 };
  /** Lateral aim of the punch in flight, per hand, in the figure's own frame. */
  private cross = { left: 0, right: 0 };

  /** The feet, and the legs that reach them. */
  private legs: { left: LegRig | null; right: LegRig | null };
  private footwork: Footwork | null = null;
  /** Canvas height, in the frame the feet are tracked in. */
  private groundY = 0;

  /** Smoothed knockdown and hurt, 0-1. */
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

  /** A punch has been released by this hand. */
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

  /** Plants the feet, steps them, and bends the legs to reach them. */
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

  /** Builds one arm's pose and applies it. */
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
    // A punch is thrown with the body: the shoulders turn into it, the chest
    // leans after it, and a dig to the body sits down into the legs.
    const out = (hand: "left" | "right") => Math.max(0, this.extension[hand]);
    const dip = Math.max(out("left") * Math.max(0, -this.aim.left), out("right") * Math.max(0, -this.aim.right));
    const crouch = Math.min(
      1,
      stance.crouch +
        FOOTWORK_CONFIG.standingBend +
        dip * OPPONENT_ANIM.bodyDip +
        this.shownDown * KNOCKDOWN_ANIM.hipFold
    );
    const drop = this.crouchRig
      ? applyCrouch(this.figure, this.crouchRig, crouch, { fromBind: true })
      : 0;
    this.pivot.position.y = -drop;

    // The lean, plus the hurt sway.
    const sway =
      this.shownHurt > 0.01
        ? Math.sin(this.wobbleT * KNOCKDOWN_ANIM.wobbleHz * Math.PI * 2) *
          KNOCKDOWN_ANIM.wobble *
          this.shownHurt
        : 0;
    this.pivot.rotation.z = -stance.lean + sway;
    // Cocking a hand loads the turn the other way, so the extension can be signed.
    this.pivot.rotation.y =
      this.extension.right * OPPONENT_ANIM.twistRear - this.extension.left * OPPONENT_ANIM.twistLead;

    // The fall, and the lean into a punch.
    this.pivot.rotation.x =
      this.shownDown * KNOCKDOWN_ANIM.fallAngle - Math.max(out("left"), out("right")) * OPPONENT_ANIM.punchLean;

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
