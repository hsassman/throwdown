import * as THREE from "three";
import {
  torsoScaleOf,
  type AnyPoseKey,
  type PoseFrame,
} from "../../pose/poseTypes";
import {
  FOOTWORK_CONFIG,
  HAND_CONFIG,
  KNOCKDOWN_ANIM,
  PERCEPTION_CONFIG,
  RENDER_CONFIG,
  TARGET_CONFIG,
} from "../../config/tuning";
import { applyClench, captureHandBind, type HandBind } from "./handRig";
import {
  applyCrouch,
  captureCrouch,
  composeWorldRotation,
  type CrouchRig,
} from "./crouch";
import {
  captureLeg,
  figureForward,
  figureLeft,
  solveLegIk,
  type LegRig,
} from "./legIk";
import { Footwork, boxingStance } from "../footwork";
import { ARM_CHAIN, applyGuard, applyGuardArm } from "../guardPoses";
import {
  BodyMotionTracker,
  NEUTRAL_BODY_MOTION,
  type BodyMotion,
} from "../../perception/bodyMotion";
import {
  applyPoseToRig,
  captureBindPose,
  computeBoneTargets,
  measureHeadSignals,
  measureLimbs,
  ARM_BONES,
  type ArmBoneName,
  type BoneBindData,
  type LimbLengths,
} from "./mediapipeToMhrRig";
import {
  BONE_SOURCES,
  DRIVEN_BONES,
  LIMB_TORSO_LENGTH,
  type DrivenBoneName,
} from "./rigJointMap";
import type { BoneTarget } from "./mediapipeToMhrRig";
import type { StrikeEvent } from "../../perception/strikeResolver";

// Owns everything stateful about driving the character: per-player limb-length
// estimates, the neutral body position, and frame-to-frame smoothing. Kept out
// of BoxerModel so the logic is testable without a WebGL context, and out of
// mediapipeToMhrRig so that module stays pure geometry.
//
// Purely cosmetic - see docs/ARCHITECTURE.md. Nothing here feeds back into
// perception, hit resolution or the simulation.

/** Scratch vectors for the per-frame foot solve. Allocating these inside the
 *  update would hand the collector a few hundred short-lived vectors a second
 *  for values that never leave the frame they were computed in. */
const _ground = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _left = new THREE.Vector3();
const _footTarget = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _hipFoot = new THREE.Vector3();
const _flinchDir = new THREE.Vector3();
const _flinchAxis = new THREE.Vector3();
const _flinchUp = new THREE.Vector3(0, 1, 0);
const _flinchFwd = new THREE.Vector3();
const _flinchLeft = new THREE.Vector3();

/** Exponential smoothing factor for a given time constant and frame delta.
 * Frame-rate independent: the same tau converges at the same wall-clock rate
 * whether rendering at 30 or 144 FPS. */
function smoothingAlpha(dt: number, tau: number): number {
  if (!(dt > 0)) return 0;
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/**
 * Angle between two rotations, radians.
 *
 * Deliberately not Quaternion.angleTo(): the exported asset's quaternions are
 * marginally non-unit, and acos near 1 turns a 1e-8 dot deficit into ~4e-4
 * radians even against an exact copy. That noise floor is small in absolute
 * terms but it sits right where this function is used to decide "is the bone
 * basically still", so it is clamped explicitly instead.
 */
function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  const dot = THREE.MathUtils.clamp(Math.abs(a.dot(b)), 0, 1);
  return 2 * Math.acos(dot);
}

export interface RigDebugState {
  tracked: boolean;
  /** Recovered out-of-plane component per arm bone, 0 (flat to camera) to 1
   * (pointing straight at it). */
  depth: Record<ArmBoneName, number>;
  /** Current per-player limb length estimates, torso units. */
  limbFull: LimbLengths;
  /** Whole-body offset from neutral, torso units. */
  root: { x: number; y: number };
  /** Whole-body channels: slip, crouch, step and blade. */
  body: BodyMotion;
  /** Calibrated head angles actually applied, degrees. */
  head: { yaw: number; pitch: number };
  /** How closed each fist is, 0-1. */
  clench: { l: number; r: number };
  /** Bones currently coasting on a held target because their landmarks
   * dropped out, and how far through the fade each is. Empty is healthy. */
  stale: string[];
}

export class RigDriver {
  private binds: Map<DrivenBoneName, BoneBindData>;
  private root: THREE.Object3D;
  private rootHome = new THREE.Vector3();
  private rootHomeYaw = 0;

  /** Smoothed rotation actually shown, per bone. */
  private shown = new Map<DrivenBoneName, THREE.Quaternion>();
  /** Raw target rotation for this frame, per bone. */
  private targetQuat = new Map<DrivenBoneName, THREE.Quaternion>();

  private limbFull: LimbLengths = { ...seedLimbs() };
  /** Arms whose length has been observed at least once. Until then limbFull
   * holds only the anthropometric seed, which is a guess. */
  private calibrated = new Set<ArmBoneName>();
  /** Whole-body translation and rotation - see perception/bodyMotion.ts. */
  private readonly body = new BodyMotionTracker();
  private motion: BodyMotion = NEUTRAL_BODY_MOTION;
  /** Step toward/away from the camera, torso units. */
  private rootDepth = 0;
  private shownDepth = 0;
  /** Torso yaw, radians. */
  private torsoTurn = 0;
  private shownTurn = 0;
  private rootOffset = new THREE.Vector2();
  /** Legs and waist for the duck. Null if the rig has no legs. */
  private crouchRig: CrouchRig | null = null;
  /**
   * The player's feet, and the legs that reach them.
   *
   * At a desk webcam the legs are almost never in frame, so the retargeting has
   * nothing to drive them with and they sat at bind pose - dead straight -
   * while the body slid sideways to render a slip. The character moved like a
   * chess piece for the same reason the opponent did.
   *
   * This fills that gap and only that gap: the moment the camera can actually
   * see the player's legs, the measured pose wins and this stands down. A
   * procedural guess must never override a real measurement.
   */
  private legs: { left: LegRig | null; right: LegRig | null } = {
    left: null,
    right: null,
  };
  private footwork: Footwork | null = null;
  /** Arm bones the rest guard is currently driving. See applyRestGuard. */
  private readonly guarded = new Set<DrivenBoneName>();
  /**
   * Knockdown and hurt, as the fight sees them and as the body shows them.
   *
   * The player's figure had no expression of either. A clean right hand put
   * them on the canvas, the simulation started a count, the round resumed -
   * and the character on screen boxed on throughout, mirroring a player who
   * was still standing in their room. The opponent has had a full bone-driven
   * reaction since it existed; this is the other half of it.
   */
  private down = 0;
  private hurt = 0;
  private shownDown = 0;
  private shownHurt = 0;
  private wobbleT = 0;
  private groundY = 0;
  /**
   * The player's reaction to being hit.
   *
   * The opponent has had a full bone-driven hit reaction since it existed -
   * head snap, jaw, spine fold, knockback. The player got bruises and nothing
   * else: the CPU could land a clean right hand and the character would not so
   * much as blink. That asymmetry was the most conspicuous thing left in the
   * fight, and it is the same reaction, scaled down and composed on top of the
   * tracked pose rather than replacing it - see TARGET_CONFIG.playerReactionShare.
   */
  private impulse = 0;
  private shownImpulse = 0;
  private flinchHeadShare = 1;
  private readonly flinchDir = new THREE.Vector3(0, 0, 1);
  /** World units per torso unit, measured off the rig. */
  private torsoWorld = RENDER_CONFIG.rigTorsoWorldLength;
  /** Shown crouch, 0-1. Chased so a duck is a movement, not a cut. */
  private shownCrouch = 0;
  private shownRoot = new THREE.Vector2();
  private depth: Record<ArmBoneName, number> = { ...zeroDepth() };
  private tracked = false;

  /**
   * Head pitch carries a per-person anatomical offset - where your nose sits
   * relative to your ear canals is bone structure, not posture - so the raw
   * signal is useless until a neutral is subtracted. Yaw is nominally
   * symmetric, but face asymmetry and an off-centre camera bias it too, so
   * both are calibrated the same way: adopt the first reading, then drift
   * slowly toward wherever the player actually holds their head.
   */
  private headNeutral: { yaw: number; pitch: number } | null = null;
  /** Angles applied this frame, radians. */
  private headAngles = { yaw: 0, pitch: 0 };

  /**
   * The last good target for each bone, and how long ago it was measured.
   *
   * MediaPipe drops individual landmarks constantly - an elbow passing in
   * front of the torso, a wrist leaving frame at the end of a hook. Snapping
   * the bone straight back to its rest pose on the frame that happens, and
   * back out again when tracking recovers, is a visible twitch, and it lands
   * on precisely the fast motions the game is about. Holding the last target
   * and fading it out over `holdSeconds` turns a twitch into a settle.
   */
  private held = new Map<DrivenBoneName, { target: BoneTarget; age: number }>();

  /** Fists, if the mesh has finger chains. Cosmetic and optional. */
  private hands = new Map<"l" | "r", HandBind>();
  /** Smoothed clench per hand, 0-1. */
  private clench: Record<"l" | "r", number> = {
    l: HAND_CONFIG.guardClench,
    r: HAND_CONFIG.guardClench,
  };
  /** Target clench this frame. */
  private clenchTarget: Record<"l" | "r", number> = {
    l: HAND_CONFIG.guardClench,
    r: HAND_CONFIG.guardClench,
  };

  constructor(root: THREE.Object3D) {
    this.root = root;
    this.binds = captureBindPose(root);
    this.rootHome.copy(root.position);
    this.rootHomeYaw = root.rotation.y;
    for (const [name, bind] of this.binds) {
      this.shown.set(name, bind.bindLocalQuat.clone());
      this.targetQuat.set(name, bind.bindLocalQuat.clone());
    }
    for (const side of ["l", "r"] as const) {
      const hand = captureHandBind(root, side);
      if (hand) this.hands.set(side, hand);
    }
    this.crouchRig = captureCrouch(root, this.binds);
    this.legs = { left: captureLeg(this.binds, "l"), right: captureLeg(this.binds, "r") };

    // Measured off the rig rather than trusting RENDER_CONFIG's nominal figure:
    // the step thresholds are statements about this skeleton's proportions, so
    // they have to scale with the skeleton actually loaded.
    const shoulder = root.getObjectByName("l_uparm");
    const hip = root.getObjectByName("l_upleg");
    if (shoulder && hip) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      shoulder.getWorldPosition(a);
      hip.getWorldPosition(b);
      this.torsoWorld = Math.max(0.05, a.distanceTo(b));
    }

    this.restPose();
  }

  /**
   * Puts the figure on guard with its knees soft, immediately.
   *
   * Not on the first update. The mesh's bind pose is a T-pose with dead
   * straight legs, and a driver that only posed on its first frame would put
   * the player's own fighter on screen with its arms out sideways - then ease
   * out of it over the next few frames, which measures as a 0.30-unit jump of
   * the wrist on frame one. That is the same mistake OpponentAnimator's
   * constructor already avoids by calling reset(), and it lands at exactly the
   * moment the player is looking at their fighter for the first time.
   *
   * `shown` and `targetQuat` are seeded from the result rather than from bind,
   * so the smoothing pass starts from the guard instead of easing away from a
   * T-pose nobody ever sees.
   */
  private restPose(): void {
    applyGuard(this.root, this.binds);
    // Seeded before the crouch, not after. `update` composes the standing bend
    // on top of the smoothed rotations every frame, so a `shown` that already
    // contained it would be bent twice - which shows up as the whole figure
    // sinking over the first few frames.
    for (const [name, bind] of this.binds) {
      this.shown.get(name)!.copy(bind.bone.quaternion);
      this.targetQuat.get(name)!.copy(bind.bone.quaternion);
    }
    if (this.crouchRig) {
      const drop = applyCrouch(
        this.root,
        this.crouchRig,
        FOOTWORK_CONFIG.standingBend
      );
      this.root.position.y = this.rootHome.y - drop;
    }
  }

  /**
   * Advances the character by one rendered frame.
   *
   * `pose` may be null or stale - it updates far slower than rendering does,
   * which is the whole reason the smoothing pass exists. Re-deriving the same
   * target from an unchanged pose is intentional and cheap: it's what lets the
   * character glide between pose samples instead of stepping.
   */
  update(pose: PoseFrame | null, dt: number, mirrored: boolean): void {
    if (pose) this.refineFromPose(pose, mirrored, dt);
    else this.tracked = false;

    // Condition first: everything below reads the smoothed values. Linear
    // rather than an exponential chase, so "down" is actually reached - an
    // exponential never arrives, and a fighter permanently at 0.98 of the way
    // down never quite lies on the canvas. Different rates each way, because a
    // fighter goes over in about half a second and takes the best part of one
    // to get back up; one time constant for both makes getting up look like
    // falling in reverse, which is the one thing it is not.
    {
      const want = this.down > 0.5 ? 1 : 0;
      const seconds =
        want > this.shownDown
          ? KNOCKDOWN_ANIM.fallSeconds
          : KNOCKDOWN_ANIM.riseSeconds;
      const step = dt / seconds;
      this.shownDown += THREE.MathUtils.clamp(want - this.shownDown, -step, step);
      this.shownHurt += (this.hurt - this.shownHurt) * smoothingAlpha(dt, 0.18);
      this.wobbleT += dt;
    }

    // 1. Write raw targets onto the bones, then read them back. Targets have
    //    to be applied to the live hierarchy because each bone is solved
    //    against its parent's current orientation.
    const torso = pose ? torsoOf(pose) : null;
    const live = this.tracked && pose && torso !== null;
    const measuredTargets = live
      ? computeBoneTargets(pose, mirrored, this.limbFull, torso)
      : {};
    const fade = this.holdMissingTargets(measuredTargets, dt);

    applyPoseToRig(this.binds, measuredTargets, live ? this.headAngles : null);

    // 1b. An arm the camera cannot see holds a guard.
    //
    //     The rig's bind pose is a T-pose, so before this the rest pose of a
    //     player's own fighter was a man standing with his arms out sideways -
    //     which is what everyone saw for the seconds before they stepped into
    //     frame, and every time tracking dropped mid-round. The CPU opponent
    //     has held a guard at rest since it existed; this is the same table,
    //     now shared by both. See guardPoses.ts.
    const guarded = this.applyRestGuard(measuredTargets);

    for (const [name, bind] of this.binds) {
      const q = this.targetQuat.get(name)!;
      q.copy(bind.bone.quaternion);
      // A bone coasting on a held target eases back toward rest as the hold
      // expires, rather than surviving indefinitely on stale data. Bones the
      // guard has taken over are excluded: the guard is their rest, and
      // dragging them back toward bind would undo it a frame later.
      const f = fade.get(name);
      if (f !== undefined && f < 1 && !guarded.has(name)) {
        q.slerp(bind.bindLocalQuat, 1 - f);
      }
    }

    // 2. Ease the displayed rotation toward that target.
    //
    // The time constant adapts to how far the bone has to travel. A fixed one
    // cannot serve both jobs this smoothing has: long enough to bridge the
    // ~15 FPS pose stream without the character stepping, and short enough not
    // to blunt a punch - which is the one motion the game is about. Large
    // discrepancies are real motion and get chased hard; small ones are
    // landmark jitter and get damped.
    for (const [name, bind] of this.binds) {
      const shown = this.shown.get(name)!;
      const target = this.targetQuat.get(name)!;
      const travel = angleBetween(shown, target);
      const t = THREE.MathUtils.clamp(travel / RENDER_CONFIG.fastMotionAngle, 0, 1);
      const tau = THREE.MathUtils.lerp(
        RENDER_CONFIG.boneSmoothingTau,
        RENDER_CONFIG.boneSmoothingTauFast,
        t
      );
      shown.slerp(target, smoothingAlpha(dt, tau));
      bind.bone.quaternion.copy(shown);
    }

    // 2b. Fists. Not tracked - MediaPipe Pose has no finger articulation - so
    //     clench is inferred from arm extension: a boxer's hands are always
    //     closed, and tighten as the punch lands.
    const clenchAlpha = smoothingAlpha(dt, HAND_CONFIG.tau);
    for (const side of ["l", "r"] as const) {
      this.clench[side] += (this.clenchTarget[side] - this.clench[side]) * clenchAlpha;
      const hand = this.hands.get(side);
      if (hand) applyClench(hand, this.clench[side]);
    }

    // 2c. The duck. Bends the knees and folds the waist, and reports the
    //     height the legs gave up so the root can follow it down - see
    //     crouch.ts on why the drop has to be derived rather than dialled in.
    //     Applied after the bone solve so it composes with a tracked leg
    //     rather than replacing it.
    this.shownCrouch +=
      (this.motion.crouch - this.shownCrouch) *
      smoothingAlpha(dt, RENDER_CONFIG.rootSmoothingTau);
    // A boxer's knees are never locked, and here that is structural rather than
    // stylistic: the rig's bind pose has the legs dead straight, so a leg
    // reaching out to a planted foot has no slack and the IK below cannot put
    // the ankle on the canvas. See FOOTWORK_CONFIG.standingBend.
    const drop = this.crouchRig
      ? applyCrouch(
          this.root,
          this.crouchRig,
          // Going down folds the knees on top of whatever the player is doing.
          // A body pitching over with straight legs reads as a falling plank.
          Math.min(
            1,
            this.shownCrouch +
              FOOTWORK_CONFIG.standingBend +
              this.shownDown * KNOCKDOWN_ANIM.hipFold
          )
        )
      : 0;

    // 3. Whole-body travel: slipping and stepping move the character, not just
    //    its spine. Without this a dodge reads as a bent torso with the feet
    //    welded in place.
    const rootAlpha = smoothingAlpha(dt, RENDER_CONFIG.rootSmoothingTau);
    this.shownRoot.lerp(this.rootOffset, rootAlpha);
    this.shownDepth += (this.rootDepth - this.shownDepth) * rootAlpha;
    this.shownTurn += (this.torsoTurn - this.shownTurn) * rootAlpha;
    const s = RENDER_CONFIG.rigTorsoWorldLength * RENDER_CONFIG.rootGain;
    // The figure faces +Z, so a step toward the camera moves it along -Z in
    // the behind-view. `depthGain` is separate from rootGain because the depth
    // channel carries the cameraDistance assumption and wants its own dial.
    this.root.rotation.y = this.rootHomeYaw + this.shownTurn * RENDER_CONFIG.turnGain;
    // The fall, about the root - which sits at the feet, so the body pitches
    // over from the ground rather than sinking through it. The player's figure
    // faces +Z with the opponent in front of it, and a negative rotation about
    // X carries a point above the root toward -Z: backwards, away from the
    // fighter who just hit them.
    this.root.rotation.x = -this.shownDown * KNOCKDOWN_ANIM.fallAngle;
    // And the hurt sway. A stunned fighter that stood perfectly still was
    // indistinguishable from a fresh one - `stunned` drove the rules and
    // nothing else.
    this.root.rotation.z =
      this.shownHurt > 0.01
        ? Math.sin(this.wobbleT * KNOCKDOWN_ANIM.wobbleHz * Math.PI * 2) *
          KNOCKDOWN_ANIM.wobble *
          this.shownHurt
        : 0;
    this.root.position.set(
      this.rootHome.x + this.shownRoot.x * s,
      // Only the upward half of the vertical channel translates. Downward is
      // the crouch's job now, and it earns its height by bending the knees -
      // adding both would double the drop and put the feet back under the
      // floor, which is the levitation this replaced.
      this.rootHome.y + Math.max(0, this.shownRoot.y) * s - drop,
      this.rootHome.z -
        this.shownDepth * RENDER_CONFIG.rigTorsoWorldLength * RENDER_CONFIG.depthGain
    );

    // 4. The feet. Runs last, because it solves the legs against where the body
    //    actually ended up this frame - see updateFeet.
    this.updateFeet(dt, !!(measuredTargets.l_upleg || measuredTargets.r_upleg));

    // 5. The flinch, composed on top of everything above.
    this.updateFlinch(dt);
  }

  /**
   * The fight's verdict on this fighter's condition.
   *
   * `down` is a target, not a progress value: how long a body takes to go over
   * is not a rule, and shaping it belongs here. What the simulation decides is
   * when it starts and when the fighter is back on their feet.
   */
  setCondition(down: number, hurt: number): void {
    this.down = down;
    this.hurt = hurt;
  }

  /** Smoothed knockdown progress, 0-1. For tests and the diagnostics. */
  get downAmount(): number {
    return this.shownDown;
  }

  /**
   * Registers a punch landing on the player.
   *
   * Mirrors TrainingTarget.hit - same direction rules, same accumulation - so
   * the two fighters react to the same punch the same way. The direction is
   * derived from the zone rather than from geometry because the zone is all
   * the resolver can honestly report; see strikeResolver.ts.
   */
  flinch(event: StrikeEvent): void {
    // The player's character faces +Z. A lane on the puncher's right arrives on
    // the player's own left, which sits at world +X for a figure facing +Z -
    // so the head is driven the other way.
    // Both axes are read off the rig rather than assumed.
    //
    // This used to hardcode "+Z is forward, +X is this fighter's left", which
    // was true of the local player's figure and of nothing else. The same
    // driver now also draws a networked opponent, and that figure is turned to
    // face the other way - an assumed +Z would snap their head away from the
    // punch on a body shot and into it on a head shot, which reads as the
    // rules having got the hit backwards.
    figureForward(this.root, _flinchFwd);
    figureLeft(this.root, _flinchLeft);

    const lateral =
      event.zone.lane === "right" ? -0.85 : event.zone.lane === "left" ? 0.85 : 0;

    if (event.zone.height === "head") {
      // Driven back and up. "Back" for the player is away from the opponent,
      // who stands at +Z, so the head goes toward -Z - the opposite sign from
      // the opponent's own reaction, because they are facing each other.
      this.flinchDir
        .set(0, 0.35, 0)
        .addScaledVector(_flinchLeft, lateral)
        .addScaledVector(_flinchFwd, -1)
        .normalize();
      this.flinchHeadShare = 1;
    } else {
      this.flinchDir
        .set(0, -0.2, 0)
        .addScaledVector(_flinchLeft, lateral * 0.5)
        .addScaledVector(_flinchFwd, 1)
        .normalize();
      this.flinchHeadShare = 0;
    }
    this.impulse = Math.min(1, this.impulse + event.power);
  }

  /** Advances and applies the flinch. */
  private updateFlinch(dt: number): void {
    if (this.impulse <= 0 && this.shownImpulse <= 1e-4) return;

    this.impulse *= Math.exp(-dt / TARGET_CONFIG.recoverTau);
    if (this.impulse < 1e-4) this.impulse = 0;
    const tau =
      this.shownImpulse < this.impulse
        ? TARGET_CONFIG.impactTau
        : TARGET_CONFIG.recoverTau;
    this.shownImpulse +=
      (this.impulse - this.shownImpulse) * (1 - Math.exp(-dt / tau));
    if (this.shownImpulse < 1e-4) {
      this.shownImpulse = 0;
      return;
    }

    const strength = this.shownImpulse * TARGET_CONFIG.playerReactionShare;
    const headAngle = TARGET_CONFIG.headSnap * strength * this.flinchHeadShare;
    const bodyAngle = TARGET_CONFIG.bodyFold * strength * (1 - this.flinchHeadShare);

    // Rotating `up` about cross(up, direction) tips it toward the horizontal
    // part of the direction - which is exactly "get knocked that way".
    _flinchDir.copy(this.flinchDir);
    _flinchAxis.copy(_flinchUp).cross(_flinchDir);
    if (_flinchAxis.lengthSq() < 1e-9) return;
    _flinchAxis.normalize();

    // Composed, not written. These bones are already holding the pose solved
    // from the camera this frame, and overwriting them would drop the player's
    // real head position for the duration of the flinch - the character would
    // stop following them at the exact moment they are most likely to be
    // moving. The neck carries most of a snap and the head the rest; a
    // rotation applied only to the skull reads as detached.
    const neck = this.binds.get("c_neck");
    const head = this.binds.get("c_head");
    const spine = this.binds.get("c_spine2");
    if (neck) composeWorldRotation(neck, _flinchAxis, headAngle * 0.6);
    if (head) composeWorldRotation(head, _flinchAxis, headAngle * 0.4);
    if (spine) composeWorldRotation(spine, _flinchAxis, bodyAngle);
  }

  /**
   * Plants the player's feet and bends the legs to reach them.
   *
   * `legsTracked` is the whole safety rule. The camera is the authority on the
   * player's body, and whenever it can see the legs this stands aside
   * completely - the measured pose has already been written onto the bones by
   * the solve above and must not be overwritten by a guess. The footwork state
   * is still advanced in that case, so that if tracking drops mid-round the
   * feet are already somewhere sensible rather than snapping in from wherever
   * they were last left.
   */
  private updateFeet(dt: number, legsTracked: boolean): void {
    const { left, right } = this.legs;
    if (!left || !right) return;

    this.root.updateMatrixWorld(true);
    this.root.getWorldPosition(_ground);

    if (!this.footwork) {
      const lFoot = this.root.getObjectByName("l_foot");
      const rFoot = this.root.getObjectByName("r_foot");
      if (!lFoot || !rFoot) return;
      lFoot.getWorldPosition(_ankle);
      rFoot.getWorldPosition(_footTarget);
      this.groundY = (_ankle.y + _footTarget.y) / 2;
      this.footwork = new Footwork(
        this.stanceOffsets(),
        { x: _ground.x, z: _ground.z },
        this.torsoWorld
      );
      this.footwork.plantAt(
        { x: _ankle.x, z: _ankle.z },
        { x: _footTarget.x, z: _footTarget.z }
      );
    }

    this.footwork.update(dt, { x: _ground.x, z: _ground.z });
    // The camera wins over the planted stance - except while the fighter is on
    // the canvas, when it must not. The player is still standing in their
    // room, and a tracked leg would hold the figure's knee up in the air
    // underneath a body that has gone over.
    if (legsTracked && this.shownDown < 0.01) return;

    figureForward(this.root, _forward);
    for (const side of ["left", "right"] as const) {
      const leg = this.legs[side]!;
      const foot = side === "left" ? this.footwork.left : this.footwork.right;
      _footTarget.set(foot.x, this.groundY + foot.lift, foot.z);
      // Going over, the feet come in under the hips.
      //
      // Not a flourish - it is what keeps the solve reachable. The hips swing
      // back and down through most of a right angle during a fall, and a foot
      // left planted where the fighter was standing ends up further from the
      // hip than the leg is long. The IK would then straighten and haul the
      // ankle off the canvas: the "fighter on tiptoe" failure the standing
      // bend was added to prevent, arriving by another route.
      if (this.shownDown > 0.001) {
        leg.thigh.bone.getWorldPosition(_ankle);
        _hipFoot.set(_ankle.x, this.groundY, _ankle.z);
        _footTarget.lerp(_hipFoot, this.shownDown);
      }
      solveLegIk(leg, _footTarget, _forward);
    }
  }

  /** The stance the feet hold, in the world frame they are tracked in. */
  private stanceOffsets() {
    figureForward(this.root, _forward);
    figureLeft(this.root, _left);
    return boxingStance(
      "left",
      FOOTWORK_CONFIG.stanceWidth * this.torsoWorld,
      FOOTWORK_CONFIG.stanceStagger * this.torsoWorld,
      { x: _left.x, z: _left.z },
      { x: _forward.x, z: _forward.z }
    );
  }

  /**
   * Fills in bones whose landmarks dropped out this frame from the last good
   * reading, and reports how much of that held value still counts.
   *
   * Mutates `targets` in place. Returns a fade factor per held bone: 1 while
   * the reading is fresh, falling to 0 as the hold expires, at which point the
   * bone is simply undriven again.
   */
  /**
   * Poses any arm the camera is not driving, and reports which bones it took.
   *
   * Per arm, not per bone. If the upper arm is measured and the forearm is
   * not, forcing a guard forearm onto a tracked upper arm produces an elbow
   * bending the wrong way - worse than the held-and-faded target, which at
   * least agrees with the limb above it.
   */
  private applyRestGuard(
    targets: Record<string, BoneTarget | undefined>
  ): Set<DrivenBoneName> {
    // Reused rather than allocated: this runs every frame and holds at most
    // four entries.
    this.guarded.clear();
    // A fighter on the canvas is not boxing. The player is still standing in
    // their room with their hands up, and mirroring that onto a figure that
    // has just been dropped is the single most obviously wrong thing the
    // character could do - so while they are down, the camera does not get a
    // vote on the arms.
    const down = this.shownDown > 0.5;
    for (const hand of ["left", "right"] as const) {
      const bones = ARM_CHAIN[hand];
      if (!down && (targets[bones.uparm] || targets[bones.lowarm])) continue;
      applyGuardArm(this.root, this.binds, hand, down ? "none" : "high");
      this.guarded.add(bones.uparm);
      this.guarded.add(bones.lowarm);
    }
    return this.guarded;
  }

  private holdMissingTargets(
    targets: Record<string, BoneTarget | undefined>,
    dt: number
  ): Map<DrivenBoneName, number> {
    const fade = new Map<DrivenBoneName, number>();
    const hold = RENDER_CONFIG.landmarkHoldSeconds;

    for (const name of DRIVEN_BONES) {
      const bind = this.binds.get(name);
      if (!bind?.aimed) continue;

      const fresh = targets[name];
      if (fresh) {
        this.held.set(name, { target: { ...fresh }, age: 0 });
        continue;
      }

      const prev = this.held.get(name);
      if (!prev) continue;
      prev.age += dt;
      if (prev.age >= hold) {
        this.held.delete(name);
        continue;
      }
      targets[name] = prev.target;
      fade.set(name, 1 - prev.age / hold);
    }
    return fade;
  }

  /** Updates per-player estimates from a fresh pose. */
  private refineFromPose(pose: PoseFrame, mirrored: boolean, dt: number): void {
    const torso = torsoOf(pose);
    if (torso === null) {
      this.tracked = false;
      return;
    }
    this.tracked = true;

    // Limb lengths: track the longest projection seen, decaying slowly so a
    // single over-long frame can't inflate the reference permanently.
    const measured = measureLimbs(pose, mirrored, torso);
    const decay = RENDER_CONFIG.limbLengthDecayPerSec * dt;
    for (const bone of ARM_BONES) {
      const p = measured[bone];
      if (p === undefined) continue;

      // A short projection is not a bad reading - it is precisely the signal
      // depth recovery runs on, so it must never be filtered out here. Only an
      // implausibly long one is rejected, since that is what would corrupt the
      // reference. (Rejecting short readings silently disabled depth recovery
      // for exactly the punches it exists to capture.)
      if (p <= RENDER_CONFIG.limbLengthMax) {
        if (!this.calibrated.has(bone)) {
          // Adopt the first real observation rather than trusting the seed.
          // Limb-to-torso proportion varies enough between people that a fixed
          // seed reads as permanent foreshortening for anyone shorter-limbed
          // than it, which shows up as the character punching forward while
          // the player stands still.
          this.limbFull[bone] = p;
          this.calibrated.add(bone);
        } else {
          // Grow instantly, shrink slowly: a longer reading is evidence of
          // true extension, a shorter one is usually just foreshortening.
          this.limbFull[bone] = Math.max(p, this.limbFull[bone] - decay);
        }
        this.limbFull[bone] = THREE.MathUtils.clamp(
          this.limbFull[bone],
          RENDER_CONFIG.limbLengthMin,
          RENDER_CONFIG.limbLengthMax
        );
      }
      this.depth[bone] = depthOf(p, this.limbFull[bone]);
    }

    // Fist clench, from how far each arm is extended.
    //
    // Extension is measured against the arm length this driver has already
    // learned (upper + forearm, torso units), so it is a genuine 0-1 fraction
    // of this player's reach rather than a threshold in absolute units that
    // would mean something different for every body.
    const table = BONE_SOURCES[mirrored ? "mirrored" : "direct"];
    for (const side of ["l", "r"] as const) {
      const shoulderKey = table[`${side}_uparm`]?.from as AnyPoseKey | undefined;
      const wristKey = table[`${side}_lowarm`]?.to as AnyPoseKey | undefined;
      if (!shoulderKey || !wristKey) continue;
      const shoulder = pose[shoulderKey];
      const wrist = pose[wristKey];
      if (
        !shoulder ||
        !wrist ||
        shoulder.confidence < PERCEPTION_CONFIG.minLandmarkConfidence ||
        wrist.confidence < PERCEPTION_CONFIG.minLandmarkConfidence
      ) {
        continue;
      }
      const armLength = this.limbFull[`${side}_uparm`] + this.limbFull[`${side}_lowarm`];
      if (!(armLength > 1e-6)) continue;

      // On-screen extension, plus credit for the arm pointing at the camera -
      // a straight punch down the lens barely moves the wrist on screen, which
      // is the whole reason depth recovery exists.
      const planar = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y) / torso;
      const depth = this.depth[`${side}_lowarm`];
      const extension = THREE.MathUtils.clamp(
        planar / armLength + depth * HAND_CONFIG.depthWeight,
        0,
        1
      );

      const t = THREE.MathUtils.smoothstep(extension, HAND_CONFIG.tightenFrom, 1);
      this.clenchTarget[side] = THREE.MathUtils.lerp(
        HAND_CONFIG.guardClench,
        HAND_CONFIG.strikeClench,
        t
      );
    }

    // Head yaw/pitch, relative to how this player actually holds their head.
    const head = measureHeadSignals(pose, mirrored, torso);
    if (head) {
      if (!this.headNeutral) this.headNeutral = { ...head };
      const yawGain = RENDER_CONFIG.headYawGain;
      const pitchGain = RENDER_CONFIG.headPitchGain;
      const maxYaw = RENDER_CONFIG.headYawMax;
      const maxPitch = RENDER_CONFIG.headPitchMax;
      this.headAngles.yaw = THREE.MathUtils.clamp(
        (head.yaw - this.headNeutral.yaw) * yawGain,
        -maxYaw,
        maxYaw
      );
      this.headAngles.pitch = THREE.MathUtils.clamp(
        (head.pitch - this.headNeutral.pitch) * pitchGain,
        -maxPitch,
        maxPitch
      );
    }

    // Whole-body motion: slip, crouch, step and blade.
    //
    // This used to be derived inline from raw shoulder-midpoint displacement.
    // It is now delegated to BodyMotionTracker for two reasons: it adds the
    // depth and turn channels the character had no way to express, and its
    // lateral/vertical are measured relative to the optical axis rather than
    // raw image position - which is what stops a step toward the camera
    // leaking into the vertical channel and making the character grow.
    const body = this.body.update(pose);
    if (!body.tracked) return;
    this.motion = body;

    const clamp = RENDER_CONFIG.rootClamp;
    this.rootOffset.set(
      THREE.MathUtils.clamp(body.lateral * (mirrored ? -1 : 1), -clamp, clamp),
      THREE.MathUtils.clamp(body.vertical, -clamp, clamp)
    );
    this.rootDepth = THREE.MathUtils.clamp(body.depth, -clamp, clamp);
    // Turn is mirrored with the view, exactly like lateral: in the reflected
    // view the character's near shoulder is the other one, and a turn that did
    // not mirror would rotate the body away from the arm driving it.
    this.torsoTurn = body.turn * (mirrored ? -1 : 1);
  }

  /**
   * Lets the neutral reference drift toward where the player actually is.
   * Called on pose updates only, with the real elapsed time, so the long time
   * constant means what it says regardless of render rate.
   */
  followNeutral(pose: PoseFrame, dtSeconds: number, mirrored = false): void {
    const a = smoothingAlpha(dtSeconds, RENDER_CONFIG.neutralFollowTau);

    // The head's neutral drifts too, and for the same reason: a player who
    // settles into a slightly different head carriage should not end up with
    // a permanently cocked character.
    if (this.headNeutral) {
      const torso = torsoOf(pose);
      const head = torso === null ? null : measureHeadSignals(pose, mirrored, torso);
      if (head) {
        this.headNeutral.yaw += (head.yaw - this.headNeutral.yaw) * a;
        this.headNeutral.pitch += (head.pitch - this.headNeutral.pitch) * a;
      }
    }

    // The body's neutral drifts on its own time constant, inside the tracker
    // that owns it. Keeping a second copy here was how the root ended up with
    // a reference that could disagree with the one the channels were measured
    // against.
    this.body.followNeutral(pose, dtSeconds);
  }

  /** Re-centres the character on wherever the player is standing now, and
   * re-learns their limb lengths from scratch. */
  recentre(): void {
    this.body.reset();
    this.motion = NEUTRAL_BODY_MOTION;
    this.rootDepth = 0;
    this.torsoTurn = 0;
    this.headNeutral = null;
    this.held.clear();
    this.headAngles.yaw = 0;
    this.headAngles.pitch = 0;
    this.rootOffset.set(0, 0);
    this.calibrated.clear();
    this.limbFull = { ...seedLimbs() };
  }

  /**
   * The live whole-body channels.
   *
   * Exposed separately from `debug` because `debug` builds a snapshot object
   * and is called four times a second for a readout; this is read every frame
   * by the fight loop, which needs the gap between the fighters. One tracker
   * with one neutral, shared by reference - a second BodyMotionTracker would
   * have its own idea of where the player is resting, and the two would
   * disagree about how far the player had stepped in.
   */
  get bodyMotion(): BodyMotion {
    return this.motion;
  }

  get debug(): RigDebugState {
    return {
      tracked: this.tracked,
      depth: { ...this.depth },
      limbFull: { ...this.limbFull },
      root: { x: this.rootOffset.x, y: this.rootOffset.y },
      body: this.motion,
      clench: { l: this.clench.l, r: this.clench.r },
      stale: [...this.held]
        .filter(([, h]) => h.age > 0)
        .map(([name]) => name),
      head: {
        yaw: THREE.MathUtils.radToDeg(this.headAngles.yaw),
        pitch: THREE.MathUtils.radToDeg(this.headAngles.pitch),
      },
    };
  }

  /** Returns every driven bone to its exported rest rotation. */
  reset(): void {
    this.held.clear();
    for (const [name, bind] of this.binds) {
      bind.bone.quaternion.copy(bind.bindLocalQuat);
      this.shown.get(name)!.copy(bind.bindLocalQuat);
    }
    for (const [side, hand] of this.hands) {
      this.clench[side] = HAND_CONFIG.guardClench;
      this.clenchTarget[side] = HAND_CONFIG.guardClench;
      applyClench(hand, HAND_CONFIG.guardClench);
    }
    this.shownRoot.set(0, 0);
    this.root.position.copy(this.rootHome);
  }

  get boneCount(): number {
    return this.binds.size;
  }
}

function seedLimbs(): LimbLengths {
  return {
    l_uparm: LIMB_TORSO_LENGTH.uparm,
    r_uparm: LIMB_TORSO_LENGTH.uparm,
    l_lowarm: LIMB_TORSO_LENGTH.lowarm,
    r_lowarm: LIMB_TORSO_LENGTH.lowarm,
  };
}

function zeroDepth(): Record<ArmBoneName, number> {
  return { l_uparm: 0, r_uparm: 0, l_lowarm: 0, r_lowarm: 0 };
}

function depthOf(projected: number, full: number): number {
  if (!(full > 1e-6)) return 0;
  const r = THREE.MathUtils.clamp(projected / full, 0, 1);
  return Math.sqrt(Math.max(0, 1 - r * r));
}

function torsoOf(pose: PoseFrame): number | null {
  return torsoScaleOf(pose, PERCEPTION_CONFIG.minLandmarkConfidence)?.value ?? null;
}

export { DRIVEN_BONES };
