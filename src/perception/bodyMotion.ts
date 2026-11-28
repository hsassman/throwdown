import { midpoint, torsoScaleOf, type PoseFrame } from "../pose/poseTypes";
import { BODY_CONFIG, PERCEPTION_CONFIG } from "../config/tuning";
import type { Stance } from "./punchTypes";

// Whole-body motion: where the player has moved to, and which way they are
// facing.

export interface BodyMotion {
  /** False when the frame was unusable; every channel is then 0. */
  tracked: boolean;
  /** Slip, torso units. Positive is toward the player's own right. */
  lateral: number;
  /** Rise and fall, torso units. Negative is crouched. */
  vertical: number;
  /** Stepping, torso units. Positive is toward the camera. */
  depth: number;
  /** Torso yaw, radians. Signed by stance; 0 is square to the camera. */
  turn: number;
  /** 0..1 crouch, from `vertical` against the learned standing height. */
  crouch: number;
  /** Mean height of the two wrists above the hip line, torso units. */
  guardHeight: number;
  /** 0..1, how much of the body the measurement could actually see. */
  confidence: number;
}

export const NEUTRAL_BODY_MOTION: BodyMotion = {
  tracked: false,
  lateral: 0,
  vertical: 0,
  depth: 0,
  turn: 0,
  crouch: 0,
  guardHeight: 0,
  confidence: 0,
};

/** The resting reference every channel is measured against. */
interface Neutral {
  /** Optical-axis-relative, torso-normalised. See `sampleBody`. */
  px: number;
  py: number;
  /** Torso scale when standing square. Drives the depth channel. */
  scale: number;
  /** Shoulder width when square to the camera. Drives the turn channel. */
  shoulderWidth: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Raw per-frame measurements, before any neutral is subtracted. */
export interface BodySample {
  /** Position relative to the optical axis, divided by the torso scale. */
  px: number;
  py: number;
  scale: number;
  shoulderWidth: number;
  confidence: number;
}

export function sampleBody(pose: PoseFrame): BodySample | null {
  const min = PERCEPTION_CONFIG.minLandmarkConfidence;
  const shoulders = midpoint(pose.leftShoulder, pose.rightShoulder);
  if (shoulders.confidence < min) return null;

  const torso = torsoScaleOf(pose, min);
  if (!torso || torso.value <= 1e-4) return null;

  const shoulderWidth = Math.hypot(
    pose.leftShoulder.x - pose.rightShoulder.x,
    pose.leftShoulder.y - pose.rightShoulder.y
  );

  // Confidence is the weakest of the landmarks actually used, not their mean.
  // A mean lets a well-tracked shoulder hide a lost hip, and the hips are what
  // the torso scale - and therefore the whole depth channel - rests on.
  const confidence = Math.min(
    pose.leftShoulder.confidence,
    pose.rightShoulder.confidence,
    Math.max(pose.leftHip.confidence, pose.rightHip.confidence)
  );

  const { principalX, principalY } = BODY_CONFIG;
  return {
    px: (shoulders.x - principalX) / torso.value,
    py: (shoulders.y - principalY) / torso.value,
    scale: torso.value,
    shoulderWidth,
    confidence,
  };
}

/** Mean wrist height above the hip line, torso units. */
export function guardHeightOf(pose: PoseFrame, torsoScale: number): number {
  const min = PERCEPTION_CONFIG.minLandmarkConfidence;
  const hips = midpoint(pose.leftHip, pose.rightHip);
  if (hips.confidence < min || torsoScale <= 1e-4) return 0;

  const heights: number[] = [];
  for (const wrist of [pose.leftWrist, pose.rightWrist]) {
    if (wrist.confidence >= min) heights.push((hips.y - wrist.y) / torsoScale);
  }
  if (heights.length === 0) return 0;
  return heights.reduce((a, b) => a + b, 0) / heights.length;
}

/** Tracks whole-body motion against a slowly-drifting neutral. */
export class BodyMotionTracker {
  private neutral: Neutral | null = null;
  private last: BodyMotion = { ...NEUTRAL_BODY_MOTION };
  /** How long the body has been held away from neutral. See driftHold. */
  private displacedFor = 0;

  reset(): void {
    this.neutral = null;
    this.last = { ...NEUTRAL_BODY_MOTION };
    this.displacedFor = 0;
  }

  /** True once a resting reference has been established. */
  get calibrated(): boolean {
    return this.neutral !== null;
  }

  get state(): BodyMotion {
    return this.last;
  }

  /** Feeds one pose. */
  update(pose: PoseFrame, stance: Stance = "orthodox"): BodyMotion {
    const s = sampleBody(pose);
    if (!s) {
      // Tracking lost. Report untracked rather than holding the last value:
      // a stale crouch that never lifts is worse than no crouch, because the
      // character stays folded over with nothing driving it.
      this.last = { ...NEUTRAL_BODY_MOTION };
      return this.last;
    }

    if (!this.neutral) {
      this.neutral = {
        px: s.px,
        py: s.py,
        scale: s.scale,
        shoulderWidth: s.shoulderWidth,
      };
      this.last = {
        ...NEUTRAL_BODY_MOTION,
        tracked: true,
        guardHeight: guardHeightOf(pose, s.scale),
        confidence: s.confidence,
      };
      return this.last;
    }

    const n = this.neutral;

    // --- Lateral and vertical: displacement, in torso units. ---
    // Already torso-normalised and axis-relative (see BodySample), so these are
    // a plain subtraction and are invariant to how far away the player stands.
    // Image y grows downward, so a negative delta is a rise - flipped here so
    // `vertical` reads the way a person would describe it.
    const lateral = clamp(s.px - n.px, -BODY_CONFIG.travelClamp, BODY_CONFIG.travelClamp);
    const vertical = clamp(-(s.py - n.py), -BODY_CONFIG.travelClamp, BODY_CONFIG.travelClamp);

    // --- Depth: Δ = D·(1 − s_neutral/s_now). See the header. ---
    const depth = clamp(
      BODY_CONFIG.cameraDistance * (1 - n.scale / s.scale),
      -BODY_CONFIG.depthClamp,
      BODY_CONFIG.depthClamp
    );

    // --- Turn: |yaw| = acos(width/neutralWidth), signed by stance. ---
    // Both widths are divided by their own torso scale. Raw image widths
    // grow as the player steps in, so a neutral that drifted while they were
    // close read every later frame as narrow - and stepping back registered
    // as a 17-degree turn nobody made. Width over torso length is invariant to
    // distance and still falls with yaw, since turning does not change the
    // shoulder-to-hip length.
    // Clamped into [0,1] before acos: a player leaning in measures a wider
    // shoulder line than neutral, and acos of anything over 1 is NaN - which
    // would propagate into the character's rotation and freeze it.
    const neutralWidth = n.shoulderWidth / n.scale;
    const ratio = neutralWidth > 1e-5 ? clamp(s.shoulderWidth / s.scale / neutralWidth, 0, 1) : 1;
    const magnitude = Math.acos(ratio);
    // Ignore the first few degrees outright. Shoulder width is noisy at 15 Hz,
    // and acos is steepest exactly where the signal is smallest, so raw noise
    // near square-on turns into a visibly twitching torso.
    const turnMagnitude = magnitude < BODY_CONFIG.turnDeadZone ? 0 : magnitude - BODY_CONFIG.turnDeadZone;
    // Orthodox leads with the left shoulder forward, so the torso opens to the
    // player's right as they rotate into a right hand. Southpaw mirrors it.
    const sign = stance === "southpaw" ? -1 : 1;
    const turn = clamp(turnMagnitude * sign, -BODY_CONFIG.turnClamp, BODY_CONFIG.turnClamp);

    // --- Crouch: how far down, as a fraction of a full crouch. ---
    const crouch = clamp(-vertical / BODY_CONFIG.fullCrouch, 0, 1);

    this.last = {
      tracked: true,
      lateral,
      vertical,
      depth,
      turn,
      crouch,
      guardHeight: guardHeightOf(pose, s.scale),
      confidence: s.confidence,
    };
    return this.last;
  }

  /** Lets the neutral follow where the player actually settles. */
  followNeutral(pose: PoseFrame, dtSeconds: number): void {
    const n = this.neutral;
    if (!n) return;
    const s = sampleBody(pose);
    if (!s) return;
    const dt = Math.max(0, dtSeconds);

    // Hold still through a dodge or a step - see BODY_CONFIG.driftHold.
    const hold = BODY_CONFIG.driftHold;
    const depth = BODY_CONFIG.cameraDistance * (1 - n.scale / s.scale);
    const crouch = (s.py - n.py) / BODY_CONFIG.fullCrouch;
    const displaced =
      Math.abs(depth) > hold.depth || Math.abs(s.px - n.px) > hold.lateral || crouch > hold.crouch;
    if (displaced) {
      this.displacedFor += dt;
      if (this.displacedFor < hold.seconds) return;
    } else {
      this.displacedFor = 0;
    }

    const a = 1 - Math.exp(-dt / BODY_CONFIG.neutralTau);
    n.px += (s.px - n.px) * a;
    n.py += (s.py - n.py) * a;
    n.scale += (s.scale - n.scale) * a;
    n.shoulderWidth += (s.shoulderWidth - n.shoulderWidth) * a;
  }
}
