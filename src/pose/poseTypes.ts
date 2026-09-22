// Internal keypoint types, kept deliberately independent of MediaPipe's own
// shapes so the underlying pose model can be swapped (e.g. to MoveNet, one of
// the fallbacks in the risk log) without touching the
// perception, simulation or render layers.
//
// Ported from the Flap project's pose/poseTypes.ts and extended with the head
// landmarks Shadow Box needs for dodge/duck detection (Milestone 2).

export interface Keypoint {
  x: number; // normalized [0,1], relative to video width
  y: number; // normalized [0,1], relative to video height
  /**
   * Normalized depth. Treat as the least reliable axis - see
   * the gesture-classification notes. Punches travel toward the camera, which is
   * exactly where this signal degrades, so the punch classifier must not lean
   * on z magnitude. Kept here for debug inspection, not for classification.
   */
  z?: number;
  confidence: number; // visibility / presence score [0,1]
}

/**
 * The subset of the 33 BlazePose landmarks this project actually consumes.
 *
 * Arm chain (shoulder/elbow/wrist) drives punch classification; head landmarks
 * drive dodge/duck; hips give a torso reference for scale normalization so
 * thresholds work at different distances from the camera.
 */
export interface PoseFrame {
  timestamp: number;

  // Arm chain - punch classification (Milestone 1).
  leftShoulder: Keypoint;
  rightShoulder: Keypoint;
  leftElbow: Keypoint;
  rightElbow: Keypoint;
  leftWrist: Keypoint;
  rightWrist: Keypoint;

  // Torso reference - scale normalization and guard-height reference.
  leftHip: Keypoint;
  rightHip: Keypoint;

  // Head - dodge/duck detection (Milestone 2).
  nose: Keypoint;
  leftEye: Keypoint;
  rightEye: Keypoint;
  leftEar: Keypoint;
  rightEar: Keypoint;

  // --- Extended landmarks, optional by design. ---
  //
  // Only the cosmetic retargeting layer (Track B) reads these: legs give the
  // character a stance, hand points give its fists an orientation. They are
  // optional for two reasons, and both are deliberate:
  //
  //  - Perception must not quietly grow a dependency on a landmark whose
  //    thresholds have never been calibrated. Anything under perception/ that
  //    wants one has to handle its absence explicitly.
  //  - At a desk webcam the legs are frequently out of frame entirely, so
  //    "absent" is the normal case, not an error. Consumers leave the
  //    corresponding bones at rest rather than guessing.
  leftKnee?: Keypoint;
  rightKnee?: Keypoint;
  leftAnkle?: Keypoint;
  rightAnkle?: Keypoint;
  leftIndex?: Keypoint;
  rightIndex?: Keypoint;
  leftPinky?: Keypoint;
  rightPinky?: Keypoint;
}

/** Every landmark key on PoseFrame, for iteration in overlays/smoothing. */
export const POSE_KEYS = [
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "nose",
  "leftEye",
  "rightEye",
  "leftEar",
  "rightEar",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];

/**
 * The optional landmarks, kept in their own list so the required set above
 * stays exactly what perception is calibrated against. Transport, smoothing
 * and unpacking iterate ALL_POSE_KEYS; perception iterates POSE_KEYS.
 */
export const EXTRA_POSE_KEYS = [
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftIndex",
  "rightIndex",
  "leftPinky",
  "rightPinky",
] as const;

export type ExtraPoseKey = (typeof EXTRA_POSE_KEYS)[number];

/** Every landmark carried across the worker boundary, in transport order. */
export const ALL_POSE_KEYS = [...POSE_KEYS, ...EXTRA_POSE_KEYS] as const;

export type AnyPoseKey = PoseKey | ExtraPoseKey;

/**
 * MediaPipe BlazePose 33-landmark indices.
 * Reference: the pose landmarker model card's landmark ordering. Indices 1-6
 * are the six eye points (inner/center/outer per eye); we take the two centers.
 */
export const MP_LANDMARKS: Record<AnyPoseKey, number> = {
  nose: 0,
  leftEye: 2, // left eye center (1=inner, 2=center, 3=outer)
  rightEye: 5, // right eye center (4=inner, 5=center, 6=outer)
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  // Hand points, for fist orientation. 17/18 pinky MCP, 19/20 index MCP.
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  // Legs, for stance and footwork.
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

/**
 * Midpoint of two keypoints, confidence taken as the weaker of the two so a
 * half-tracked pair never reads as trustworthy.
 */
export function midpoint(a: Keypoint, b: Keypoint): Keypoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    confidence: Math.min(a.confidence, b.confidence),
  };
}

/**
 * Approximate shoulder-hip distance as a multiple of shoulder width, used when
 * the hips aren't visible. Rough anthropometric ratio - shoulder breadth and
 * shoulder-to-hip height are broadly comparable, with the torso slightly the
 * longer of the two. Only a scale reference, so being a few percent off shifts
 * all thresholds together rather than distorting any one feature.
 */
const SHOULDER_WIDTH_TO_TORSO = 1.2;

export type TorsoScaleSource = "shoulder-hip" | "shoulder-width";

export interface TorsoScale {
  value: number;
  source: TorsoScaleSource;
}

/**
 * Body-scale reference that normalizes every perception threshold, so the same
 * tuning holds at any distance or body size. Prefers shoulder-to-hip distance
 * (invariant to a bladed boxing stance, unlike shoulder width, which shrinks
 * side-on) and falls back to shoulder width when the hips aren't tracked - as
 * they often aren't at a desk webcam.
 */
export function torsoScaleOf(
  pose: PoseFrame,
  minConfidence: number
): TorsoScale | null {
  const shoulders = midpoint(pose.leftShoulder, pose.rightShoulder);
  if (shoulders.confidence < minConfidence) return null;

  const hips = midpoint(pose.leftHip, pose.rightHip);
  if (hips.confidence >= minConfidence) {
    const v = Math.hypot(shoulders.x - hips.x, shoulders.y - hips.y);
    if (v > 1e-3) return { value: v, source: "shoulder-hip" };
  }

  const width = Math.hypot(
    pose.leftShoulder.x - pose.rightShoulder.x,
    pose.leftShoulder.y - pose.rightShoulder.y
  );
  if (width > 1e-3) {
    return { value: width * SHOULDER_WIDTH_TO_TORSO, source: "shoulder-width" };
  }
  return null;
}
