// Perception-layer vocabulary. These are the discrete outputs the rest of the
// game consumes - the simulation and netcode layers see only these, never
// landmarks (docs/ARCHITECTURE.md).

/** Which physical arm moved. Independent of stance. */
export type HandSide = "left" | "right";

/**
 * Stance sets which hand is lead vs rear, separating a jab from a cross.
 * Orthodox = left hand leads. Captured during calibration, not inferred, since
 * inferring it would lean on the unreliable shoulder-z axis.
 */
export type Stance = "orthodox" | "southpaw";

export type PunchType = "jab" | "cross" | "hook" | "uppercut";

/**
 * Coarser grouping. Straight-vs-curved is the fallback distinction worth
 * keeping if the full four-way split fails, so it's a first-class concept.
 */
export type PunchFamily = "straight" | "curved";

export const PUNCH_FAMILY: Record<PunchType, PunchFamily> = {
  jab: "straight",
  cross: "straight",
  hook: "curved",
  uppercut: "curved",
};

/** Features measured over a single punch, from launch to peak extension. */
export interface PunchFeatures {
  /** Peak distance the fist travelled from its calibrated guard, torso units.
   *  This is the signal detection gates on - see Sample.excursion. */
  peakExcursion: number;
  /** Horizontal wrist travel, torso-normalized. Positive = toward body midline. */
  inwardTravel: number;
  /** Vertical wrist travel, torso-normalized. Positive = upward. */
  upwardTravel: number;
  /** Gain in wrist-to-shoulder distance, torso-normalized. */
  extensionGain: number;
  /** Peak wrist-to-shoulder distance, torso-normalized. */
  peakExtension: number;
  /** Elbow angle at launch and at peak, degrees. */
  elbowAngleStart: number;
  elbowAnglePeak: number;
  /** Peak wrist speed, torso-widths per second. */
  peakSpeed: number;
  /** Path length / straight-line distance. 1 = perfectly straight. */
  curvature: number;
  /** Lowest wrist height reached during the punch, relative to the shoulder
   *  line, torso-normalized. Negative = dropped below the shoulders, which is
   *  what an uppercut's chamber does and a straight punch's does not. */
  lowestHeight: number;
  /** Milliseconds from launch to peak. */
  durationMs: number;
  /** Frames sampled during the punch - low counts mean the pose rate starved
   *  the classifier, which matters when interpreting a misclassification. */
  sampleCount: number;
}

export interface PunchEvent {
  type: PunchType;
  family: PunchFamily;
  hand: HandSide;
  /** "lead" or "rear" given the calibrated stance. */
  role: "lead" | "rear";
  /** [0,1] - margin between the winning score and the runner-up. */
  confidence: number;
  /** Per-type scores, for debugging why a call was made. */
  scores: Record<PunchType, number>;
  features: PunchFeatures;
  /** performance.now() at peak extension. */
  timestamp: number;
}

export function punchTypeFor(
  family: "straight" | "hook" | "uppercut",
  role: "lead" | "rear"
): PunchType {
  if (family === "hook") return "hook";
  if (family === "uppercut") return "uppercut";
  return role === "lead" ? "jab" : "cross";
}

/** Which hand is the lead hand for a stance. */
export function leadHand(stance: Stance): HandSide {
  return stance === "orthodox" ? "left" : "right";
}
