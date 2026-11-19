import type { Keypoint, PoseFrame } from "../pose/poseTypes";
import { DEPTH_CONFIG as C } from "../config/tuning";
import type { CropRect } from "../pose/roiCrop";
import type { HandSide } from "../perception/punchTypes";

// The pure half of the depth pipeline: what goes into the model, and what is
// read back out of it. No ONNX, no DOM - so it is tested without a GPU.
//
// What a depth map from a single webcam can and cannot say. Depth Anything
// produces relative inverse depth ("disparity"): larger is nearer, but each
// frame has its own unknown scale and offset, so a raw value is meaningless
// and two frames cannot be compared directly. Ratios of differences within one
// frame cancel both unknowns, which is what everything below is built on.

/** One depth inference, as handed to consumers. */
export interface DepthFrame {
  /** Relative inverse depth, row-major, `size` x `size`. Larger is nearer. */
  map: Float32Array;
  size: number;
  /** The region of the video the map covers, source pixels. */
  crop: CropRect;
  videoW: number;
  videoH: number;
  /** performance.now() when the frame was captured. */
  timestamp: number;
  /**
   * The pose as it was when this frame was captured. Landmarks must be read
   * against the map from the same instant: depth arrives hundreds of ms
   * after capture, and pairing it with the current pose put a moving wrist
   * on a patch of wall in the old map - readings swung to -0.9 mid-punch.
   */
  pose: PoseFrame | null;
  inferenceMs: number;
}

/**
 * RGBA pixels to the model's input: planar RGB, rescaled to 0-1 and
 * normalised with the ImageNet mean and std, as its preprocessor does.
 */
export function toModelInput(rgba: Uint8ClampedArray, size: number): Float32Array {
  const n = size * size;
  const out = new Float32Array(3 * n);
  const [mr, mg, mb] = C.mean;
  const [sr, sg, sb] = C.std;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = (rgba[o] / 255 - mr) / sr;
    out[n + i] = (rgba[o + 1] / 255 - mg) / sg;
    out[2 * n + i] = (rgba[o + 2] / 255 - mb) / sb;
  }
  return out;
}

/**
 * The square region of the video to run depth on: the body, with a margin
 * wide enough for an extended arm, or the centre of the frame when nobody is
 * tracked. Square because the model input is, and a stretched person is a
 * person the model has never seen.
 */
export function cropFromPose(pose: PoseFrame | null, videoW: number, videoH: number): CropRect {
  const side0 = Math.min(videoW, videoH);
  const centre: CropRect = { x: (videoW - side0) / 2, y: (videoH - side0) / 2, w: side0, h: side0 };
  if (!pose) return centre;
  const pts = [
    pose.nose,
    pose.leftShoulder,
    pose.rightShoulder,
    pose.leftHip,
    pose.rightHip,
    pose.leftWrist,
    pose.rightWrist,
  ].filter((k): k is Keypoint => !!k && k.confidence >= 0.5);
  if (pts.length < 3) return centre;
  const xs = pts.map((k) => k.x * videoW);
  const ys = pts.map((k) => k.y * videoH);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const raw = Math.max(maxX - minX, maxY - minY);
  const side = Math.min(side0, Math.max(raw * (1 + 2 * C.cropMargin), side0 * 0.35));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: Math.min(Math.max(0, cx - side / 2), videoW - side),
    y: Math.min(Math.max(0, cy - side / 2), videoH - side),
    w: side,
    h: side,
  };
}

/**
 * Disparity at a landmark: the median over a small window, since a single
 * map pixel at a limb's edge can belong to the wall behind it. Null when the
 * landmark is unseen or outside the mapped region.
 */
export function disparityAt(
  frame: DepthFrame,
  kp: Keypoint | undefined,
  radius: number = C.sampleRadius,
  quantile = 0.5
): number | null {
  if (!kp || kp.confidence < 0.5) return null;
  const { crop, size, map } = frame;
  const u = ((kp.x * frame.videoW - crop.x) / crop.w) * size;
  const v = ((kp.y * frame.videoH - crop.y) / crop.h) * size;
  if (!(u >= 0 && u < size && v >= 0 && v < size)) return null;
  const r = Math.max(0, Math.round(radius));
  const vals: number[] = [];
  for (let y = Math.max(0, Math.floor(v) - r); y <= Math.min(size - 1, Math.floor(v) + r); y++) {
    for (let x = Math.max(0, Math.floor(u) - r); x <= Math.min(size - 1, Math.floor(u) + r); x++) {
      vals.push(map[y * size + x]);
    }
  }
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * quantile))];
}

/**
 * Disparity of the fist: the near end of what is around the wrist landmark,
 * rather than the value exactly under it.
 *
 * A pose sample and a depth frame are never from quite the same instant -
 * pose arrives every ~50-80ms and a punching fist covers a glove-width in
 * that time - and a point sample a glove-width off reads the wall behind.
 * Measured on the fake player, that put about half of all readings at the
 * background. The glove is the nearest thing in its own neighbourhood in a
 * guard and mid-punch alike, so a high percentile over a window finds it
 * without needing the two to line up exactly.
 */
export function fistDisparity(frame: DepthFrame, wrist: Keypoint | undefined): number | null {
  return disparityAt(frame, wrist, frame.size * C.fistWindow, C.fistQuantile);
}

/** The map's background level: a low percentile, i.e. the far wall. */
export function backgroundOf(map: Float32Array): number {
  // A strided sample is plenty for a percentile and keeps this cheap.
  const step = Math.max(1, Math.floor(map.length / 2048));
  const vals: number[] = [];
  for (let i = 0; i < map.length; i += step) vals.push(map[i]);
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * C.backgroundPercentile)];
}

/**
 * A point on the chest, on the midline between the shoulder and hip lines.
 *
 * The depth reference for the body. Not the shoulders themselves: in a guard
 * the gloves sit in front of them, so a depth sample at the shoulder landmark
 * reads the glove (seen on the rendered fake player, where it made a raised
 * guard read as a fist *behind* the body). The chest between the arms stays
 * visible.
 */
export function chestPoint(pose: PoseFrame): Keypoint | null {
  const s = [pose.leftShoulder, pose.rightShoulder];
  const h = [pose.leftHip, pose.rightHip];
  if ([...s, ...h].some((k) => !k || k.confidence < 0.5)) return null;
  const sx = (s[0].x + s[1].x) / 2;
  const sy = (s[0].y + s[1].y) / 2;
  const hx = (h[0].x + h[1].x) / 2;
  const hy = (h[0].y + h[1].y) / 2;
  const f = C.chestFraction;
  return { x: sx + (hx - sx) * f, y: sy + (hy - sy) * f, confidence: 1 };
}

/**
 * How far a fist is in front of the chest, relative to how far the chest is
 * in front of the wall:
 *
 *     (d_wrist - d_chest) / (d_chest - d_background)
 *
 * With disparity d = a/z + b, both the unknown scale `a` and offset `b`
 * cancel, so the number is comparable across frames. About 0 with the fist at
 * the chest's depth, positive as it comes toward the camera; how large a
 * full punch reads depends on how far the player stands from the wall, so it
 * is a direction-and-timing signal rather than a distance.
 *
 * This is the out-of-plane measurement foreshortening can only infer: a
 * straight punch down the lens barely moves on screen, but it changes depth.
 */
export function armForward(frame: DepthFrame, pose: PoseFrame, hand: HandSide): number | null {
  const chestKp = chestPoint(pose);
  const chest = chestKp ? disparityAt(frame, chestKp) : null;
  const wrist = fistDisparity(frame, hand === "left" ? pose.leftWrist : pose.rightWrist);
  if (chest === null || wrist === null) return null;
  const sep = chest - backgroundOf(frame.map);
  if (!(sep > C.minSeparation)) return null;
  return (wrist - chest) / sep;
}
