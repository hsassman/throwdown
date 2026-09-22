import { midpoint, torsoScaleOf, type PoseFrame } from "../pose/poseTypes";
import { BODY_CONFIG, PERCEPTION_CONFIG } from "../config/tuning";
import type { Stance } from "./punchTypes";

// Whole-body motion: where the player has moved to, and which way they are
// facing.
//
// Separate from dodgeDetector.ts on purpose. That answers a gameplay question
// ("slip or duck?") with thresholds; this is a continuous measurement that
// drives the character. Folded together, either the character would only move
// once a dodge threshold tripped, or the dodge rule would inherit a signal it
// has no thresholds for.
//
// Five channels - lateral, vertical, depth, turn, crouch - all from x/y only.
// MediaPipe's `z` is never read anywhere in perception; it degrades along the
// axis a punch travels.
//
// Depth comes from apparent size. A torso at distance D measuring s measures
// s' = s*D/(D-delta) after stepping delta closer, so delta = D*(1 - s/s').
// Exact, except for D, which an uncalibrated webcam cannot measure. So D is an
// assumption (BODY_CONFIG.cameraDistance) acting purely as this channel's
// gain: wrong by a factor and the step is too big or too small, but never
// backwards and never non-monotonic.
//
// Turn magnitude is measured (apparent shoulder width is W*cos(yaw)); the sign
// is not. A frontal camera sees identical narrowing either way. So the sign
// comes from the stance: an orthodox fighter blades left-shoulder-forward, a
// southpaw mirrors it.

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
  /**
   * Mean height of the two wrists above the hip line, torso units.
   *
   * Absolute, unlike every other channel here, and deliberately so: a guard is
   * a posture rather than a displacement from wherever the player happened to
   * be standing when tracking started. 0 is the belt and 1.0 the shoulder
   * line, the same normalisation `ImpactPoint.height` uses.
   *
   * A wrist the camera cannot see contributes nothing and the other hand is
   * used alone; with neither visible this reads 0. That is a deliberate false
   * Negative - the camera is the only sensor, and hands it cannot see must not
   * earn the player a block. The failure mode is losing a guard you had, never
   * being credited with one you did not.
   */
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

/**
 * Raw per-frame measurements, before any neutral is subtracted.
 *
 * Split out so the neutral-tracking and the geometry can be tested apart from
 * each other - the geometry is the part worth checking against hand-computed
 * numbers.
 */
export interface BodySample {
  /**
   * Position relative to the optical axis, divided by the torso scale.
   *
   * Not raw image position, and the difference matters. Stepping toward a
   * camera magnifies the image about the optical axis, so the shoulders of
   * anyone not standing dead centre visibly rise in frame as they step in. Raw
   * image position reads that as the player standing taller, so a step forward
   * leaked straight into the vertical channel - a test caught it.
   *
   * Dividing the axis-relative offset by the torso scale cancels it exactly:
   * both the offset and the scale are multiplied by the same magnification, so
   * the ratio is invariant to distance. Lateral and vertical then measure
   * genuine translation and nothing else.
   */
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

/**
 * Mean wrist height above the hip line, torso units.
 *
 * Averaged across the two hands rather than taken from the higher or the
 * lower of them. The higher alone would call a fighter guarded with one hand
 * dangling; the lower alone would drop the guard on every punch, since
 * throwing one means extending one. The mean says what a guard actually is -
 * how much of your head the pair of them is covering.
 */
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

/**
 * Tracks whole-body motion against a slowly-drifting neutral.
 *
 * The neutral drifts for the same reason the rig's does: a player who settles
 * into a slightly different stance over a round should not end up with a
 * character permanently leaning, crouched, or stepped back. The drift is slow
 * enough that a held crouch still reads as a crouch for many seconds.
 */
export class BodyMotionTracker {
  private neutral: Neutral | null = null;
  private last: BodyMotion = { ...NEUTRAL_BODY_MOTION };

  reset(): void {
    this.neutral = null;
    this.last = { ...NEUTRAL_BODY_MOTION };
  }

  /** True once a resting reference has been established. */
  get calibrated(): boolean {
    return this.neutral !== null;
  }

  get state(): BodyMotion {
    return this.last;
  }

  /**
   * Feeds one pose.
   *
   * Takes no `dt`: every channel here is a position, not a rate, so nothing in
   * it depends on how long since the last sample. The one thing that does - the
   * neutral's drift - lives in `followNeutral`, which takes the real interval
   * between pose samples rather than render frames.
   */
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
    // Clamped into [0,1] before acos: a player leaning in measures a wider
    // shoulder line than neutral, and acos of anything over 1 is NaN - which
    // would propagate into the character's rotation and freeze it.
    const ratio = n.shoulderWidth > 1e-5 ? clamp(s.shoulderWidth / n.shoulderWidth, 0, 1) : 1;
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

  /**
   * Lets the neutral follow where the player actually settles.
   *
   * Separate from `update` so the caller decides when drift is appropriate -
   * it must not run while the player is mid-slip, or the neutral chases the
   * dodge and the character springs back upright underneath them.
   */
  followNeutral(pose: PoseFrame, dtSeconds: number): void {
    const n = this.neutral;
    if (!n) return;
    const s = sampleBody(pose);
    if (!s) return;
    const a = 1 - Math.exp(-Math.max(0, dtSeconds) / BODY_CONFIG.neutralTau);
    n.px += (s.px - n.px) * a;
    n.py += (s.py - n.py) * a;
    n.scale += (s.scale - n.scale) * a;
    n.shoulderWidth += (s.shoulderWidth - n.shoulderWidth) * a;
  }
}
