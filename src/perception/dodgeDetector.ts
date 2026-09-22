// Head-based dodge and duck detection - Milestone 2.
//
// Outputs continuous head state, not discrete events: a dodge is a held
// position, and the simulation reads the opponent's current state at the
// instant a punch resolves to decide hit or miss. Everything is measured
// relative to the current shoulder line and normalized by torso scale, so a
// plain sidestep (shoulders travelling with the head) does not read as a dodge
// - avoiding those false triggers is Milestone 2's actual bar.

import { midpoint, torsoScaleOf, type PoseFrame } from "../pose/poseTypes";
import { PERCEPTION_CONFIG as C } from "../config/tuning";
import type { CalibrationData } from "./calibration";

export interface HeadState {
  /** Whether the head landmarks are tracked well enough to trust this reading. */
  tracked: boolean;
  /**
   * Lateral dodge, -1 (fully to image left) .. +1 (fully to image right).
   * Note this is image space; the UI mirrors it for display.
   */
  lean: number;
  /** Duck, 0 (upright) .. 1 (fully ducked). */
  duck: number;
  /** Raw torso-normalized measurements, before dead zone and clamping. */
  raw: {
    /** Nose offset from shoulder midpoint, relative to the calibrated neutral. */
    lateral: number;
    /** Loss of nose height above the shoulder line vs neutral. Positive = head lowered. */
    headDrop: number;
    /** Drop of the shoulder line itself vs neutral. Positive = whole body lowered. */
    bodyDrop: number;
  };
}

export const NEUTRAL_HEAD_STATE: HeadState = {
  tracked: false,
  lean: 0,
  duck: 0,
  raw: { lateral: 0, headDrop: 0, bodyDrop: 0 },
};

/**
 * Maps a raw offset to a 0..1 magnitude, ignoring everything inside a dead
 * zone. The dead zone absorbs natural sway and breathing.
 */
function ramp(value: number, deadZone: number, fullRange: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadZone) return 0;
  const span = Math.max(fullRange - deadZone, 1e-6);
  return Math.min(1, (magnitude - deadZone) / span);
}

export class DodgeDetector {
  private state: HeadState = NEUTRAL_HEAD_STATE;

  reset(): void {
    this.state = NEUTRAL_HEAD_STATE;
  }

  get current(): HeadState {
    return this.state;
  }

  update(pose: PoseFrame, cal: CalibrationData): HeadState {
    const minConf = C.minLandmarkConfidence;
    const shoulders = midpoint(pose.leftShoulder, pose.rightShoulder);

    if (pose.nose.confidence < minConf || shoulders.confidence < minConf) {
      // Hold the last state rather than snapping to neutral: a dropped frame
      // mid-dodge would otherwise read as an instant return upright.
      this.state = { ...this.state, tracked: false };
      return this.state;
    }

    const scale = torsoScaleOf(pose, minConf);
    if (scale === null) {
      this.state = { ...this.state, tracked: false };
      return this.state;
    }

    const lateral =
      (pose.nose.x - shoulders.x) / scale.value - cal.neutralHead.lateral;

    // Head lowered toward the shoulders (a slip or bob).
    const headAbove = (shoulders.y - pose.nose.y) / scale.value;
    const headDrop = cal.neutralHead.aboveShoulders - headAbove;

    // Whole body lowered (bending the knees). Caught separately because a squat
    // lowers head and shoulders together, so head-drop alone would miss it.
    const bodyDrop = (shoulders.y - cal.neutralHead.shoulderY) / scale.value;

    const lean =
      Math.sign(lateral) * ramp(lateral, C.dodgeDeadZone, C.dodgeFullRange);

    // Either way of getting lower counts; take whichever reads stronger.
    const duck = Math.max(
      ramp(Math.max(0, headDrop), C.duckDeadZone, C.duckFullRange),
      ramp(Math.max(0, bodyDrop), C.bodyDropDeadZone, C.bodyDropFullRange)
    );

    this.state = {
      tracked: true,
      lean,
      duck,
      raw: { lateral, headDrop, bodyDrop },
    };
    return this.state;
  }
}
