import { describe, it, expect } from "vitest";
import {
  armForward,
  backgroundOf,
  chestPoint,
  cropFromPose,
  disparityAt,
  fistDisparity,
  toModelInput,
  type DepthFrame,
} from "./depthMath";
import { nearestPose } from "./useDepthMap";
import { DEPTH_CONFIG } from "../config/tuning";
import type { Keypoint, PoseFrame } from "../pose/poseTypes";

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/** A frontal player in a 640x480 frame, hands in guard. */
function pose(o: { leftWrist?: [number, number]; t?: number } = {}): PoseFrame {
  const [lwx, lwy] = o.leftWrist ?? [0.56, 0.36];
  return {
    timestamp: o.t ?? 0,
    nose: kp(0.5, 0.22),
    leftEye: kp(0.53, 0.2),
    rightEye: kp(0.47, 0.2),
    leftEar: kp(0.56, 0.21),
    rightEar: kp(0.44, 0.21),
    leftShoulder: kp(0.6, 0.38),
    rightShoulder: kp(0.4, 0.38),
    leftElbow: kp(0.63, 0.52),
    rightElbow: kp(0.37, 0.52),
    leftWrist: kp(lwx, lwy),
    rightWrist: kp(0.44, 0.36),
    leftHip: kp(0.57, 0.68),
    rightHip: kp(0.43, 0.68),
  };
}

/**
 * A synthetic disparity map over the whole frame: wall at 1, body at 3, and
 * a glove disc at `glove` around each wrist. Larger is nearer, as the model's.
 */
function scene(p: PoseFrame, glove: { left: number; right: number }): DepthFrame {
  const size = 64;
  const videoW = 640;
  const videoH = 480;
  const crop = { x: 80, y: 0, w: 480, h: 480 };
  const map = new Float32Array(size * size);
  const toMap = (k: Keypoint) => [
    ((k.x * videoW - crop.x) / crop.w) * size,
    ((k.y * videoH - crop.y) / crop.h) * size,
  ];
  const [slx] = toMap(p.leftShoulder);
  const [srx, sy] = toMap(p.rightShoulder);
  const [, hy] = toMap(p.leftHip);
  const [lwx, lwy] = toMap(p.leftWrist);
  const [rwx, rwy] = toMap(p.rightWrist);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d = 1;
      if (x >= Math.min(slx, srx) && x <= Math.max(slx, srx) && y >= sy - 4 && y <= hy) d = 3;
      if (Math.hypot(x - lwx, y - lwy) < 3) d = glove.left;
      if (Math.hypot(x - rwx, y - rwy) < 3) d = glove.right;
      map[y * size + x] = d;
    }
  }
  return { map, size, crop, videoW, videoH, timestamp: 0, inferenceMs: 0, pose: p };
}

describe("toModelInput", () => {
  it("is planar RGB, normalised as the model's preprocessor does", () => {
    // A 2x2 image: red, green, blue, white.
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const out = toModelInput(rgba, 2);
    const [mr, mg, mb] = DEPTH_CONFIG.mean;
    const [sr, sg, sb] = DEPTH_CONFIG.std;
    const n = (v: number, m: number, sd: number) => (v - m) / sd;
    // R plane, then G plane, then B plane - not interleaved.
    expect(Array.from(out.slice(0, 4))).toEqual(
      [1, 0, 0, 1].map((v) => expect.closeTo(n(v, mr, sr), 5))
    );
    expect(Array.from(out.slice(4, 8))).toEqual(
      [0, 1, 0, 1].map((v) => expect.closeTo(n(v, mg, sg), 5))
    );
    expect(Array.from(out.slice(8, 12))).toEqual(
      [0, 0, 1, 1].map((v) => expect.closeTo(n(v, mb, sb), 5))
    );
  });
});

describe("cropFromPose", () => {
  it("is square and inside the frame", () => {
    const c = cropFromPose(pose(), 640, 480);
    expect(c.w).toBe(c.h);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.x + c.w).toBeLessThanOrEqual(640);
    expect(c.y + c.h).toBeLessThanOrEqual(480);
  });

  it("keeps an extended fist inside the crop", () => {
    const p = pose({ leftWrist: [0.82, 0.38] });
    const c = cropFromPose(p, 640, 480);
    expect(p.leftWrist.x * 640).toBeLessThan(c.x + c.w);
  });

  it("falls back to the centre of the frame with nobody tracked", () => {
    expect(cropFromPose(null, 640, 480)).toEqual({ x: 80, y: 0, w: 480, h: 480 });
  });
});

describe("depth signals", () => {
  it("puts the body reference on the chest, below raised gloves", () => {
    const p = pose();
    const c = chestPoint(p)!;
    expect(c.y).toBeGreaterThan(p.leftWrist.y);
    expect(c.y).toBeLessThan(p.leftHip.y);
  });

  it("takes the far wall as background", () => {
    const f = scene(pose(), { left: 4, right: 4 });
    expect(backgroundOf(f.map)).toBe(1);
  });

  it("reads a fist in front of the chest as positive, and more so when it comes forward", () => {
    const guard = armForward(scene(pose(), { left: 4, right: 4 }), pose(), "left")!;
    const punch = armForward(scene(pose(), { left: 7, right: 4 }), pose(), "left")!;
    expect(guard).toBeGreaterThan(0);
    expect(punch).toBeGreaterThan(guard * 2);
  });

  it("is unchanged by the model's unknown per-frame scale and offset", () => {
    const f = scene(pose(), { left: 6, right: 4 });
    const scaled = { ...f, map: f.map.map((d) => 3.7 * d + 12) };
    expect(armForward(scaled, pose(), "left")).toBeCloseTo(armForward(f, pose(), "left")!, 6);
  });

  it("still finds the glove when the landmark is a little off it", () => {
    // A pose from a frame or two away: a point sample here reads the wall.
    const f = scene(pose(), { left: 7, right: 4 });
    // Just above the glove, where only the wall is.
    const offPose = pose({ leftWrist: [0.56, 0.3] });
    expect(disparityAt(f, offPose.leftWrist)).toBe(1);
    expect(fistDisparity(f, offPose.leftWrist)).toBe(7);
  });

  it("says nothing about a wrist it cannot see", () => {
    const p = pose();
    p.leftWrist = { ...p.leftWrist, confidence: 0.1 };
    expect(armForward(scene(pose(), { left: 4, right: 4 }), p, "left")).toBeNull();
  });
});

describe("nearestPose", () => {
  it("picks the sample closest in time, within a frame or two", () => {
    const h = [pose({ t: 0 }), pose({ t: 50 }), pose({ t: 100 })];
    expect(nearestPose(h, 60)?.timestamp).toBe(50);
    expect(nearestPose(h, 400)).toBeNull();
  });
});
