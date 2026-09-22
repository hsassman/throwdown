import { SYNTHETIC_TORSO_SCALE } from "./synthetic";
import type { CalibrationData } from "./calibration";

/**
 * Calibration matching the synthetic body in synthetic.ts, shared by the
 * perception tests so the fixture cannot drift between them.
 *
 * guardWrist mirrors synthetic.ts's guard position: the fist rests slightly
 * inside and above the shoulder, expressed as a shoulder-relative offset in
 * torso units. For the left hand that is (-0.167 outward, +0.167 up), which in
 * image coordinates - where +x is outward for the left hand and y grows
 * downward - becomes (-0.167, -0.167).
 */
export const TEST_CALIBRATION: CalibrationData = {
  stance: "orthodox",
  torsoScale: SYNTHETIC_TORSO_SCALE,
  shoulderY: 0.35,
  midlineX: 0.5,
  guardExtension: { left: 0.236, right: 0.236 },
  guardWrist: {
    left: { x: -0.167, y: -0.167 },
    right: { x: 0.167, y: -0.167 },
  },
  // Synthetic idle jitter is ~0.002 normalized units; expressed in torso units
  // that is well under the configured floor, so the floor governs in tests.
  guardJitter: { left: 0.01, right: 0.01 },
  guardElbowAngle: { left: 60, right: 60 },
  neutralHead: { lateral: 0, aboveShoulders: 0.5, shoulderY: 0.35 },
  sampleCount: 30,
  scaleSource: "shoulder-hip",
};
