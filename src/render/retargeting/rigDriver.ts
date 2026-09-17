import * as THREE from "three";
import {
  torsoScaleOf,
  type AnyPoseKey,
  type PoseFrame,
} from "../../pose/poseTypes";
import { HAND_CONFIG, PERCEPTION_CONFIG, RENDER_CONFIG } from "../../config/tuning";
import { applyClench, captureHandBind, type HandBind } from "./handRig";
import { applyCrouch, captureCrouch, type CrouchRig } from "./crouch";
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

// Owns everything stateful about driving the character: per-player limb-length
// estimates, the neutral body position, and frame-to-frame smoothing. Kept out
// of BoxerModel so the logic is testable without a WebGL context, and out of
// mediapipeToMhrRig so that module stays pure geometry.
//
// Purely cosmetic — see docs/ARCHITECTURE.md. Nothing here feeds back into
// perception, hit resolution or the simulation.

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
  /** Whole-body translation and rotation — see perception/bodyMotion.ts. */
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
  /** Shown crouch, 0-1. Chased so a duck is a movement, not a cut. */
  private shownCrouch = 0;
  private shownRoot = new THREE.Vector2();
  private depth: Record<ArmBoneName, number> = { ...zeroDepth() };
  private tracked = false;

  /**
   * Head pitch carries a per-person anatomical offset — where your nose sits
   * relative to your ear canals is bone structure, not posture — so the raw
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
   * MediaPipe drops individual landmarks constantly — an elbow passing in
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
  }

  /**
   * Advances the character by one rendered frame.
   *
   * `pose` may be null or stale — it updates far slower than rendering does,
   * which is the whole reason the smoothing pass exists. Re-deriving the same
   * target from an unchanged pose is intentional and cheap: it's what lets the
   * character glide between pose samples instead of stepping.
   */
  update(pose: PoseFrame | null, dt: number, mirrored: boolean): void {
    if (pose) this.refineFromPose(pose, mirrored, dt);
    else this.tracked = false;

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
    for (const [name, bind] of this.binds) {
      const q = this.targetQuat.get(name)!;
      q.copy(bind.bone.quaternion);
      // A bone coasting on a held target eases back toward rest as the hold
      // expires, rather than surviving indefinitely on stale data.
      const f = fade.get(name);
      if (f !== undefined && f < 1) q.slerp(bind.bindLocalQuat, 1 - f);
    }

    // 2. Ease the displayed rotation toward that target.
    //
    // The time constant ADAPTS to how far the bone has to travel. A fixed one
    // cannot serve both jobs this smoothing has: long enough to bridge the
    // ~15 FPS pose stream without the character stepping, and short enough not
    // to blunt a punch — which is the one motion the game is about. Large
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

    // 2b. Fists. Not tracked — MediaPipe Pose has no finger articulation — so
    //     clench is inferred from arm extension: a boxer's hands are always
    //     closed, and tighten as the punch lands.
    const clenchAlpha = smoothingAlpha(dt, HAND_CONFIG.tau);
    for (const side of ["l", "r"] as const) {
      this.clench[side] += (this.clenchTarget[side] - this.clench[side]) * clenchAlpha;
      const hand = this.hands.get(side);
      if (hand) applyClench(hand, this.clench[side]);
    }

    // 2c. The duck. Bends the knees and folds the waist, and reports the
    //     height the legs gave up so the root can follow it down — see
    //     crouch.ts on why the drop has to be derived rather than dialled in.
    //     Applied AFTER the bone solve so it composes with a tracked leg
    //     rather than replacing it.
    this.shownCrouch +=
      (this.motion.crouch - this.shownCrouch) *
      smoothingAlpha(dt, RENDER_CONFIG.rootSmoothingTau);
    const drop = this.crouchRig
      ? applyCrouch(this.root, this.crouchRig, this.shownCrouch)
      : 0;

    // 3. Whole-body travel: slipping and stepping move the character, not just
    //    its spine. Without this a dodge reads as a bent torso with the feet
    //    welded in place.
    const rootAlpha = smoothingAlpha(dt, RENDER_CONFIG.rootSmoothingTau);
    this.shownRoot.lerp(this.rootOffset, rootAlpha);
    this.shownDepth += (this.rootDepth - this.shownDepth) * rootAlpha;
    this.shownTurn += (this.torsoTurn - this.shownTurn) * rootAlpha;
    const s = RENDER_CONFIG.rigTorsoWorldLength * RENDER_CONFIG.rootGain;
    // The figure faces +Z, so a step TOWARD the camera moves it along -Z in
    // the behind-view. `depthGain` is separate from rootGain because the depth
    // channel carries the cameraDistance assumption and wants its own dial.
    this.root.rotation.y = this.rootHomeYaw + this.shownTurn * RENDER_CONFIG.turnGain;
    this.root.position.set(
      this.rootHome.x + this.shownRoot.x * s,
      // Only the UPWARD half of the vertical channel translates. Downward is
      // the crouch's job now, and it earns its height by bending the knees —
      // adding both would double the drop and put the feet back under the
      // floor, which is the levitation this replaced.
      this.rootHome.y + Math.max(0, this.shownRoot.y) * s - drop,
      this.rootHome.z -
        this.shownDepth * RENDER_CONFIG.rigTorsoWorldLength * RENDER_CONFIG.depthGain
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

      // A SHORT projection is not a bad reading — it is precisely the signal
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
    // of THIS player's reach rather than a threshold in absolute units that
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

      // On-screen extension, plus credit for the arm pointing at the camera —
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
    // lateral/vertical are measured relative to the OPTICAL AXIS rather than
    // raw image position — which is what stops a step toward the camera
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
   * with one neutral, shared by reference — a second BodyMotionTracker would
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
