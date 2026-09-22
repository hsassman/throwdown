// Small 2D geometry helpers for the perception layer.
//
// Works in MediaPipe's normalized image space: x,y in [0,1] with y increasing
// downward (upward motion is negative dy, flipped at point of use). Nothing
// here uses z - punches travel toward the camera, exactly where MediaPipe's
// depth estimate is least reliable.

import type { Keypoint } from "../pose/poseTypes";

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Interior angle at vertex `b` formed by a-b-c, in degrees. Used for elbow
 * extension (shoulder-elbow-wrist); ~180 is a straight arm. Measured on the 2D
 * projection, so a punch thrown at the camera shows less angle change than one
 * across the frame - inherent foreshortening, not a bug.
 */
export function angleDeg(a: Vec2, b: Vec2, c: Vec2): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return 0;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** True when every supplied landmark is tracked confidently enough to trust. */
export function allVisible(minConfidence: number, ...points: Keypoint[]): boolean {
  return points.every((p) => p.confidence >= minConfidence);
}
