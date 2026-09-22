// Synthetic punch trajectories, for testing the perception layer without a
// webcam or a human.
//
// What this can and cannot tell us - read before trusting a passing test:
//
// These are idealised, noise-free, unambiguous motions. A synthetic "hook"
// travels laterally by an amount no foreshortened real hook necessarily would.
// So passing tests prove the plumbing is right: the FSM fires, feature signs
// point the way they should, and a clean example of each class lands in the
// right bucket.
//
// They prove nothing whatsoever about real-world accuracy. The whole reason
// Milestone 1 exists is that toward-camera geometry compresses exactly the
// signals these synthetic paths express cleanly. Only the measured confusion
// matrix from real thrown punches can answer that question.
//
// The value here is narrow but real: it separates "Approach a is defeated by
// the geometry" (an expected, documented outcome) from "Approach a has a sign
// error" (a bug), which a real run alone cannot distinguish.

import type { Keypoint, PoseFrame } from "../pose/poseTypes";

const kp = (x: number, y: number, confidence = 1): Keypoint => ({
  x,
  y,
  z: 0,
  confidence,
});

/** Body layout, in normalized image coordinates (y grows downward). */
const BODY = {
  shoulderY: 0.35,
  hipY: 0.65, // torso scale = 0.30
  leftShoulderX: 0.62, // subject's left appears on image right
  rightShoulderX: 0.38,
  midlineX: 0.5,
  headY: 0.2,
};

export const SYNTHETIC_TORSO_SCALE = BODY.hipY - BODY.shoulderY;

export interface SyntheticOptions {
  /** Which arm throws. */
  hand: "left" | "right";
  /** Frames in the punch, and the sample interval. */
  frames?: number;
  frameIntervalMs?: number;
  /** Frames of guard held before and after the punch. */
  guardFrames?: number;
}

interface WristPath {
  /** Guard position of the wrist. */
  start: { x: number; y: number };
  /** Peak-extension position of the wrist. */
  end: { x: number; y: number };
  /** Perpendicular bow of the path, as a fraction of torso scale. 0 = straight. */
  bow?: number;
  /**
   * Optional midpoint the fist passes through. Needed for the uppercut, which
   * drops toward the ribs before driving upward - a shape a start/end pair
   * plus a perpendicular bow cannot express.
   *
   * Without this the synthetic uppercut began at the ribs, so the fist was
   * already far from guard on the first frame and the detector never armed.
   * Real uppercuts start at guard like every other punch.
   */
  via?: { x: number; y: number };
}

function buildFrame(
  wrist: { x: number; y: number },
  hand: "left" | "right",
  extensionFraction: number,
  t: number
): PoseFrame {
  const shoulderX =
    hand === "left" ? BODY.leftShoulderX : BODY.rightShoulderX;
  const shoulder = { x: shoulderX, y: BODY.shoulderY };

  // Place the elbow between shoulder and wrist, bowed perpendicular by an
  // amount that shrinks as the arm extends. That makes the shoulder-elbow-
  // wrist angle open from bent toward straight, which is the signal the
  // detector keys on.
  const dx = wrist.x - shoulder.x;
  const dy = wrist.y - shoulder.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  const bend = (1 - extensionFraction) * 0.5 * SYNTHETIC_TORSO_SCALE;
  const perpX = -dy / len;
  const perpY = dx / len;
  const elbow = {
    x: shoulder.x + dx * 0.5 + perpX * bend,
    y: shoulder.y + dy * 0.5 + perpY * bend,
  };

  const otherShoulderX =
    hand === "left" ? BODY.rightShoulderX : BODY.leftShoulderX;
  const otherShoulder = { x: otherShoulderX, y: BODY.shoulderY };
  // The idle arm stays parked in guard.
  const otherWrist = {
    x: otherShoulderX + (hand === "left" ? -0.04 : 0.04),
    y: BODY.shoulderY - 0.04,
  };
  const otherElbow = {
    x: otherShoulderX,
    y: BODY.shoulderY + 0.1,
  };

  const leftIsThrower = hand === "left";
  return {
    timestamp: t,
    leftShoulder: kp(leftIsThrower ? shoulder.x : otherShoulder.x, BODY.shoulderY),
    rightShoulder: kp(leftIsThrower ? otherShoulder.x : shoulder.x, BODY.shoulderY),
    leftElbow: kp(
      leftIsThrower ? elbow.x : otherElbow.x,
      leftIsThrower ? elbow.y : otherElbow.y
    ),
    rightElbow: kp(
      leftIsThrower ? otherElbow.x : elbow.x,
      leftIsThrower ? otherElbow.y : elbow.y
    ),
    leftWrist: kp(
      leftIsThrower ? wrist.x : otherWrist.x,
      leftIsThrower ? wrist.y : otherWrist.y
    ),
    rightWrist: kp(
      leftIsThrower ? otherWrist.x : wrist.x,
      leftIsThrower ? otherWrist.y : wrist.y
    ),
    leftHip: kp(BODY.leftShoulderX, BODY.hipY),
    rightHip: kp(BODY.rightShoulderX, BODY.hipY),
    nose: kp(BODY.midlineX, BODY.headY),
    leftEye: kp(BODY.midlineX + 0.03, BODY.headY - 0.01),
    rightEye: kp(BODY.midlineX - 0.03, BODY.headY - 0.01),
    leftEar: kp(BODY.midlineX + 0.06, BODY.headY),
    rightEar: kp(BODY.midlineX - 0.06, BODY.headY),
  };
}

/**
 * Positions the wrist relative to its own shoulder, in torso units.
 *
 * `lateral` is positive away from the body midline (outward) and negative
 * across the body (inward); `vertical` is positive upward. Expressing paths
 * this way rather than in raw image coordinates is what makes them checkable
 * by hand - the first version of this file used raw offsets and silently
 * produced "punches" that displaced the wrist by 0.018 units, i.e. no punch
 * at all, and every detection test failed for that reason rather than any
 * fault in the classifier.
 */
function pos(hand: "left" | "right", lateral: number, vertical: number) {
  const s = SYNTHETIC_TORSO_SCALE;
  const shoulderX = hand === "left" ? BODY.leftShoulderX : BODY.rightShoulderX;
  // The subject's left shoulder sits to the image right of the midline, so
  // "outward" is +x for the left hand and -x for the right.
  const outwardSign = hand === "left" ? 1 : -1;
  return {
    x: shoulderX + outwardSign * lateral * s,
    y: BODY.shoulderY - vertical * s,
  };
}

/** Guard position: fist up near the cheek, slightly inside the shoulder. */
function guardWrist(hand: "left" | "right") {
  return pos(hand, -0.167, 0.167);
}

export type PunchShape =
  | "straight"
  | "straightForeshortened"
  | "hook"
  | "uppercut";

function pathFor(kind: PunchShape, hand: "left" | "right"): WristPath {
  const start = guardWrist(hand);

  if (kind === "hook") {
    // Travels across the body, past the midline, bowing on the way round.
    return { start, end: pos(hand, -0.733, 0), bow: 0.25 };
  }
  if (kind === "uppercut") {
    // Starts at guard, chambers down toward the ribs, then drives up the
    // Centre line - laterally inward, not straight up beside the shoulder.
    //
    // Two constraints this shape has to satisfy, both learned the hard way:
    // the drive must end further from guard than the chamber does, or the
    // detector peaks on the chamber instead of the strike; and the path must
    // stay laterally clear of the guard position throughout, or the fist
    // passes back within the re-arm radius mid-punch and the uppercut
    // fragments into two separate candidate punches.
    // Note `via` is a Bezier control point, which the curve is pulled toward
    // but never reaches - at t=0.5 the curve sits at (start + 2*via + end)/4.
    // So the control point must be placed roughly twice as deep as the dip
    // actually wanted. A control point at the intended chamber depth produced
    // a curve that never dropped below the shoulder line at all.
    return {
      start,
      via: pos(hand, -0.3, -0.93),
      end: pos(hand, -0.45, 0.7),
    };
  }
  if (kind === "straightForeshortened") {
    // A punch thrown along the optical axis, at the lens.
    //
    // This is the case the first real measured run actually consisted of, and
    // the one the earlier synthetic paths completely failed to represent. The
    // fist travels from beside the cheek to in front of the face: in the 2D
    // projection it moves only a short distance and toward the body midline,
    // while the arm's apparent length barely grows because it is pointing at
    // the camera.
    //
    // Critically, wrist-to-shoulder 2D distance grows only slightly here - and
    // can even shrink. Any detector gated on that distance is unreachable for
    // this punch no matter how hard it is thrown, which is why the geometry is
    // modelled explicitly rather than assumed away.
    return { start, end: pos(hand, -0.30, 0.07), bow: 0 };
  }

  // Straight thrown across an off-axis camera: extends outward and slightly
  // down, with minimal travel across the body. Retained as the "easy" case -
  // a player standing at an angle to the webcam produces something like this.
  return { start, end: pos(hand, 0.55, -0.25), bow: 0 };
}

/**
 * Builds a full frame sequence: guard, punch out to peak, then back to guard.
 * Extension is eased so speed peaks mid-punch, like a real one.
 */
export function syntheticPunch(
  kind: PunchShape,
  opts: SyntheticOptions
): PoseFrame[] {
  const {
    hand,
    frames = 8,
    frameIntervalMs = 33,
    guardFrames = 6,
  } = opts;
  const path = pathFor(kind, hand);
  const out: PoseFrame[] = [];
  let t = 1000;

  const at = (f: number) => {
    // Ease-in-out so the wrist accelerates then decelerates.
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * f);

    // Quadratic Bezier through `via` when present, straight lerp otherwise.
    let x: number;
    let y: number;
    if (path.via) {
      const u = 1 - eased;
      x = u * u * path.start.x + 2 * u * eased * path.via.x + eased * eased * path.end.x;
      y = u * u * path.start.y + 2 * u * eased * path.via.y + eased * eased * path.end.y;
    } else {
      x = path.start.x + (path.end.x - path.start.x) * eased;
      y = path.start.y + (path.end.y - path.start.y) * eased;
    }
    // Perpendicular bow, peaking mid-path.
    const dx = path.end.x - path.start.x;
    const dy = path.end.y - path.start.y;
    const len = Math.hypot(dx, dy) || 1e-6;
    const bowAmount =
      (path.bow ?? 0) * SYNTHETIC_TORSO_SCALE * Math.sin(Math.PI * eased);
    return {
      x: x + (-dy / len) * bowAmount,
      y: y + (dx / len) * bowAmount,
      eased,
    };
  };

  for (let i = 0; i < guardFrames; i++) {
    out.push(buildFrame(path.start, hand, 0, t));
    t += frameIntervalMs;
  }
  for (let i = 1; i <= frames; i++) {
    const p = at(i / frames);
    out.push(buildFrame({ x: p.x, y: p.y }, hand, p.eased, t));
    t += frameIntervalMs;
  }
  // Retract straight back to guard, rather than re-tracing the outward path.
  //
  // This matters for the uppercut: its outward path passes via the ribs, and
  // re-tracing that in reverse produced a second excursion peak, which the
  // detector correctly counted as another punch. Real punches are recovered
  // directly to guard, so the retract is a straight return.
  const peak = at(1);
  for (let i = frames - 1; i >= 0; i--) {
    const f = i / frames;
    out.push(
      buildFrame(
        {
          x: path.start.x + (peak.x - path.start.x) * f,
          y: path.start.y + (peak.y - path.start.y) * f,
        },
        hand,
        f,
        t
      )
    );
    t += frameIntervalMs;
  }
  for (let i = 0; i < guardFrames; i++) {
    out.push(buildFrame(path.start, hand, 0, t));
    t += frameIntervalMs;
  }
  return out;
}

/** A player standing still in guard - used to check for false positives. */
export function syntheticIdle(frames: number, jitter = 0.002): PoseFrame[] {
  const out: PoseFrame[] = [];
  let t = 1000;
  for (let i = 0; i < frames; i++) {
    const w = guardWrist("left");
    // Deterministic pseudo-jitter, so the test can't flake.
    const n = Math.sin(i * 12.9898) * jitter;
    out.push(buildFrame({ x: w.x + n, y: w.y + n }, "left", 0, t));
    t += 33;
  }
  return out;
}
