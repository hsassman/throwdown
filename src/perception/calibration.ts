// Per-player calibration.
//
// Every classifier threshold is expressed relative to the player's own body
// (torso scale) rather than raw image units, so one set of constants works
// across builds and camera distances. Captures neutral pose, guard position,
// torso scale and stance - stance is captured, not inferred, because inferring
// which hand leads would lean on the unreliable z axis.

import {
  midpoint,
  torsoScaleOf,
  type PoseFrame,
  type TorsoScaleSource,
} from "../pose/poseTypes";
import { PERCEPTION_CONFIG } from "../config/tuning";
import { allVisible, angleDeg, dist } from "./geometry";
import type { HandSide, Stance } from "./punchTypes";

export interface CalibrationData {
  stance: Stance;
  /** Shoulder-to-hip distance in normalized units. The unit for all thresholds. */
  torsoScale: number;
  /** Mean y of the shoulder line - the reference for "below shoulder height". */
  shoulderY: number;
  /** Mean x of the shoulder midpoint - the body midline, for inward travel. */
  midlineX: number;
  /** Mean wrist-to-shoulder distance at guard, torso-normalized, per hand. */
  guardExtension: Record<HandSide, number>;

  /**
   * Guard position of each wrist as a shoulder-relative offset, torso units -
   * the origin punches are measured as excursions from. Shoulder-relative so it
   * survives the player moving around the frame, and a vector (not the scalar
   * `guardExtension`) because a punch at the camera barely changes distance
   * from the shoulder while clearly leaving this position.
   */
  guardWrist: Record<HandSide, { x: number; y: number }>;

  /**
   * How far each fist wandered while holding guard, torso units (90th
   * percentile of distance from the median guard position). Makes the punch
   * threshold partly self-calibrating - it scales to this player's stance and
   * camera noise instead of a constant guessed in advance.
   */
  guardJitter: Record<HandSide, number>;
  /** Mean elbow angle at guard, degrees, per hand. */
  guardElbowAngle: Record<HandSide, number>;

  /**
   * Neutral head position for dodge/duck detection (Milestone 2), measured
   * relative to the current shoulder line so a plain sidestep (shoulders moving
   * with the head) is not read as a dodge.
   */
  neutralHead: {
    /** Nose offset from the shoulder midpoint, torso units, +x = image right. */
    lateral: number;
    /** Nose height above the shoulder line, torso units. */
    aboveShoulders: number;
    /** Absolute shoulder-line y at neutral, for detecting a whole-body crouch. */
    shoulderY: number;
  };
  sampleCount: number;
  /**
   * Which reference the scale came from. A session calibrated on shoulder width
   * (hips out of frame) isn't directly comparable to one on shoulder-hip
   * distance - worth knowing when comparing matrices across sessions.
   */
  scaleSource: TorsoScaleSource;
}

interface Accum {
  torso: number[];
  shoulderY: number[];
  midlineX: number[];
  extension: Record<HandSide, number[]>;
  elbowAngle: Record<HandSide, number[]>;
  guardX: Record<HandSide, number[]>;
  guardY: Record<HandSide, number[]>;
  headLateral: number[];
  headAbove: number[];
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Median, so a stray frame where a landmark snaps away can't shift the reference. */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 90th-percentile distance of a point series from its own median position.
 * The percentile rather than the max so one bad tracking frame during
 * calibration cannot inflate every downstream threshold.
 */
function jitter(xs: number[], ys: number[]): number {
  if (xs.length === 0) return 0;
  const mx = median(xs);
  const my = median(ys);
  const d = xs.map((x, i) => Math.hypot(x - mx, ys[i] - my)).sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.floor(d.length * 0.9))];
}

export class CalibrationCollector {
  private scaleSource: TorsoScaleSource = "shoulder-hip";
  private acc: Accum = {
    torso: [],
    shoulderY: [],
    midlineX: [],
    extension: { left: [], right: [] },
    elbowAngle: { left: [], right: [] },
    guardX: { left: [], right: [] },
    guardY: { left: [], right: [] },
    headLateral: [],
    headAbove: [],
  };

  reset(): void {
    this.acc = {
      torso: [],
      shoulderY: [],
      midlineX: [],
      extension: { left: [], right: [] },
      elbowAngle: { left: [], right: [] },
      guardX: { left: [], right: [] },
      guardY: { left: [], right: [] },
      headLateral: [],
      headAbove: [],
    };
  }

  get count(): number {
    return this.acc.torso.length;
  }

  /**
   * Feeds one frame of the player standing in a neutral guard.
   * Returns false when the frame was rejected for poor landmark confidence.
   */
  sample(pose: PoseFrame): boolean {
    const minConf = PERCEPTION_CONFIG.minLandmarkConfidence;
    // Hips are not required - torsoScaleOf falls back to shoulder width, so
    // calibration still works at a desk where a webcam sees only head and torso.
    if (
      !allVisible(
        minConf,
        pose.leftShoulder,
        pose.rightShoulder,
        pose.leftElbow,
        pose.rightElbow,
        pose.leftWrist,
        pose.rightWrist
      )
    ) {
      return false;
    }

    const scale = torsoScaleOf(pose, minConf);
    if (scale === null) return false;
    this.scaleSource = scale.source;

    const shoulders = midpoint(pose.leftShoulder, pose.rightShoulder);
    this.acc.torso.push(scale.value);
    this.acc.shoulderY.push(shoulders.y);
    this.acc.midlineX.push(shoulders.x);

    this.acc.extension.left.push(
      dist(pose.leftWrist, pose.leftShoulder) / scale.value
    );
    this.acc.extension.right.push(
      dist(pose.rightWrist, pose.rightShoulder) / scale.value
    );
    this.acc.guardX.left.push(
      (pose.leftWrist.x - pose.leftShoulder.x) / scale.value
    );
    this.acc.guardY.left.push(
      (pose.leftWrist.y - pose.leftShoulder.y) / scale.value
    );
    this.acc.guardX.right.push(
      (pose.rightWrist.x - pose.rightShoulder.x) / scale.value
    );
    this.acc.guardY.right.push(
      (pose.rightWrist.y - pose.rightShoulder.y) / scale.value
    );

    this.acc.elbowAngle.left.push(
      angleDeg(pose.leftShoulder, pose.leftElbow, pose.leftWrist)
    );
    this.acc.elbowAngle.right.push(
      angleDeg(pose.rightShoulder, pose.rightElbow, pose.rightWrist)
    );

    // Head reference, against the shoulder line. Needs the nose specifically -
    // the arm landmarks checked above say nothing about whether the face tracks.
    if (pose.nose.confidence >= minConf) {
      this.acc.headLateral.push((pose.nose.x - shoulders.x) / scale.value);
      this.acc.headAbove.push((shoulders.y - pose.nose.y) / scale.value);
    }
    return true;
  }

  /** Null until enough good frames have been collected. */
  finish(stance: Stance): CalibrationData | null {
    if (this.count < PERCEPTION_CONFIG.calibrationMinSamples) return null;
    return {
      stance,
      torsoScale: median(this.acc.torso),
      shoulderY: median(this.acc.shoulderY),
      midlineX: median(this.acc.midlineX),
      guardExtension: {
        left: median(this.acc.extension.left),
        right: median(this.acc.extension.right),
      },
      guardElbowAngle: {
        left: median(this.acc.elbowAngle.left),
        right: median(this.acc.elbowAngle.right),
      },
      guardWrist: {
        left: {
          x: median(this.acc.guardX.left),
          y: median(this.acc.guardY.left),
        },
        right: {
          x: median(this.acc.guardX.right),
          y: median(this.acc.guardY.right),
        },
      },
      guardJitter: {
        left: jitter(this.acc.guardX.left, this.acc.guardY.left),
        right: jitter(this.acc.guardX.right, this.acc.guardY.right),
      },
      neutralHead: {
        lateral: median(this.acc.headLateral),
        aboveShoulders: median(this.acc.headAbove),
        shoulderY: median(this.acc.shoulderY),
      },
      sampleCount: this.count,
      scaleSource: this.scaleSource,
    };
  }

  /** Mean torso scale so far - used for live calibration feedback. */
  get liveTorsoScale(): number {
    return mean(this.acc.torso);
  }
}
