// Makes the tracked skeleton behave like a body instead of 33 independent dots.

import {
  ALL_POSE_KEYS,
  type AnyPoseKey,
  type Keypoint,
  type PoseFrame,
} from "./poseTypes";
import { SKELETON_CONFIG } from "../config/tuning";

interface BoneDef {
  a: AnyPoseKey;
  b: AnyPoseKey;
  /** Bones sharing a group share one learned length - left and right limbs
   *  are the same length on a real person, so pooling them doubles the
   *  evidence and removes an entire asymmetry failure mode. */
  group: string;
  /** Bones that foreshorten (limbs pointing at the camera) must not be forced
   *  back to full length, or punches toward the lens would be erased. See
   *  `foreshortens` handling in solve(). */
  foreshortens: boolean;
}

/** The skeleton, as bones. */
const BONES: BoneDef[] = [
  // Torso - the reference frame. These barely foreshorten in a boxing stance
  // and are the most reliable lengths in the whole body, which is why the
  // scale estimate is built from them.
  { a: "leftShoulder", b: "rightShoulder", group: "shoulders", foreshortens: false },
  { a: "leftHip", b: "rightHip", group: "hips", foreshortens: false },
  { a: "leftShoulder", b: "leftHip", group: "side", foreshortens: false },
  { a: "rightShoulder", b: "rightHip", group: "side", foreshortens: false },
  // Cross braces. Without these the torso is a hinge: four rods that can shear
  // into a parallelogram freely, which shows up as the chest sliding sideways
  // off the hips.
  { a: "leftShoulder", b: "rightHip", group: "brace", foreshortens: false },
  { a: "rightShoulder", b: "leftHip", group: "brace", foreshortens: false },

  // Arms. These foreshorten constantly - it is a boxing game.
  { a: "leftShoulder", b: "leftElbow", group: "upperarm", foreshortens: true },
  { a: "rightShoulder", b: "rightElbow", group: "upperarm", foreshortens: true },
  { a: "leftElbow", b: "leftWrist", group: "forearm", foreshortens: true },
  { a: "rightElbow", b: "rightWrist", group: "forearm", foreshortens: true },

  // Head. Small, rigid, and high-confidence - these are the easiest wins.
  { a: "leftEar", b: "rightEar", group: "ears", foreshortens: false },
  { a: "leftEye", b: "rightEye", group: "eyes", foreshortens: false },
  { a: "nose", b: "leftEar", group: "noseEar", foreshortens: false },
  { a: "nose", b: "rightEar", group: "noseEar", foreshortens: false },

  // Legs. Optional - skipped when out of frame.
  { a: "leftHip", b: "leftKnee", group: "thigh", foreshortens: true },
  { a: "rightHip", b: "rightKnee", group: "thigh", foreshortens: true },
  { a: "leftKnee", b: "leftAnkle", group: "shin", foreshortens: true },
  { a: "rightKnee", b: "rightAnkle", group: "shin", foreshortens: true },
];

/** Joints that cannot fold past a limit. Angle at `joint`, in degrees. */
const JOINT_LIMITS: { root: AnyPoseKey; joint: AnyPoseKey; tip: AnyPoseKey; min: number }[] =
  [
    // A fully folded elbow still leaves ~25 degrees - the biceps is in the
    // way. When tracking loses an arm it habitually collapses the wrist onto
    // the elbow, which reads downstream as a maximally foreshortened forearm,
    // i.e. a fully committed punch at the camera. That is the single worst
    // false positive this whole pipeline can produce.
    { root: "leftShoulder", joint: "leftElbow", tip: "leftWrist", min: 22 },
    { root: "rightShoulder", joint: "rightElbow", tip: "rightWrist", min: 22 },
    { root: "leftHip", joint: "leftKnee", tip: "leftAnkle", min: 28 },
    { root: "rightHip", joint: "rightKnee", tip: "rightAnkle", min: 28 },
  ];

/** Robust length estimate: the median of a bounded window of observations. */
class LengthEstimate {
  private samples: number[] = [];
  private cache: number | null = null;

  add(value: number): void {
    if (!(value > 1e-6)) return;
    this.samples.push(value);
    if (this.samples.length > SKELETON_CONFIG.lengthWindow) this.samples.shift();
    this.cache = null;
  }

  /** The median, not the mean. */
  get value(): number | null {
    if (this.samples.length < SKELETON_CONFIG.minSamples) return null;
    if (this.cache !== null) return this.cache;
    const sorted = [...this.samples].sort((p, q) => p - q);
    const mid = sorted.length >> 1;
    this.cache =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return this.cache;
  }

  get count(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples.length = 0;
    this.cache = null;
  }
}

export interface SkeletonDebug {
  /** Bones with a usable learned length, out of those attempted. */
  learned: number;
  attempted: number;
  /** Current body scale relative to the learned reference. */
  scale: number;
  /** Landmarks whose motion was clamped as physically impossible, this frame. */
  rejected: number;
  /** Mean absolute length error before correction, in image units. The number
   *  that says how much the raw skeleton was breathing. */
  meanError: number;
  /** Same, after correction. */
  meanErrorAfter: number;
}

export class SkeletonSolver {
  private lengths = new Map<string, LengthEstimate>();
  /** Slow-moving estimate of each bone's current projected length, per bone. */
  private currentLen = new Map<string, number>();
  private lastTimestamp = 0;
  /** Reference torso span the learned lengths are expressed against. */
  private reference: LengthEstimate = new LengthEstimate();
  private prev: PoseFrame | null = null;
  private debugState: SkeletonDebug = {
    learned: 0,
    attempted: 0,
    scale: 1,
    rejected: 0,
    meanError: 0,
    meanErrorAfter: 0,
  };

  get debug(): SkeletonDebug {
    return this.debugState;
  }

  reset(): void {
    for (const e of this.lengths.values()) e.reset();
    this.reference.reset();
    this.currentLen.clear();
    this.lastTimestamp = 0;
    this.prev = null;
  }

  private estimate(group: string): LengthEstimate {
    let e = this.lengths.get(group);
    if (!e) {
      e = new LengthEstimate();
      this.lengths.set(group, e);
    }
    return e;
  }

  /** Current body size in the image, from the torso only. */
  private scaleFrom(pose: PoseFrame): number | null {
    const sx = (pose.leftShoulder.x + pose.rightShoulder.x) / 2;
    const sy = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;
    const hx = (pose.leftHip.x + pose.rightHip.x) / 2;
    const hy = (pose.leftHip.y + pose.rightHip.y) / 2;
    const span = Math.hypot(sx - hx, sy - hy);
    const width = Math.hypot(
      pose.leftShoulder.x - pose.rightShoulder.x,
      pose.leftShoulder.y - pose.rightShoulder.y
    );
    // Combining height and width makes the estimate survive a player turning
    // side-on, which collapses shoulder width but not torso height.
    const combined = Math.hypot(span, width * 0.65);
    return combined > 1e-4 ? combined : null;
  }

  /** One pass. Returns a corrected copy; the input is never mutated. */
  update(pose: PoseFrame): PoseFrame {
    const out = clone(pose);
    const conf = SKELETON_CONFIG;

    // --- 1. Reject teleports --------------------------------------------
    let rejected = 0;
    if (this.prev) {
      const dt = Math.max(1e-3, (pose.timestamp - this.prev.timestamp) / 1000);
      const scale = this.scaleFrom(pose) ?? 0.3;
      // A fist at the top of a professional punch reaches roughly 9 m/s, and a
      // torso is about half a metre, so ~18 torso-spans per second is a
      // generous physical ceiling. Anything above it is the tracker jumping to
      // a different object, not a person moving.
      const maxStep = conf.maxSpeedTorsoPerSec * scale * dt;
      for (const key of ALL_POSE_KEYS) {
        const now = out[key];
        const was = this.prev[key];
        if (!now || !was) continue;
        const dx = now.x - was.x;
        const dy = now.y - was.y;
        const d = Math.hypot(dx, dy);
        if (d > maxStep && d > 1e-9) {
          // Clamped toward the observation rather than discarded. Discarding
          // would freeze a landmark that has genuinely moved a long way - such
          // as a hand re-entering frame - and it would never catch up.
          const k = maxStep / d;
          now.x = was.x + dx * k;
          now.y = was.y + dy * k;
          // The reading was not trusted, and downstream confidence gates
          // should know that rather than being handed a clamped value at full
          // confidence.
          now.confidence = Math.min(now.confidence, conf.rejectedConfidence);
          rejected++;
        }
      }
    }

    // --- 2. Learn the body ----------------------------------------------
    const scale = this.scaleFrom(out);
    if (scale !== null) this.reference.add(scale);
    const reference = this.reference.value;
    const ratio = reference !== null && scale !== null ? scale / reference : 1;

    let attempted = 0;
    for (const bone of BONES) {
      const a = out[bone.a];
      const b = out[bone.b];
      if (!a || !b) continue;
      attempted++;
      if (
        a.confidence < conf.learnConfidence ||
        b.confidence < conf.learnConfidence ||
        scale === null
      ) {
        continue;
      }
      const observed = Math.hypot(a.x - b.x, a.y - b.y) / scale;
      // A foreshortened limb reads short, never long. So for limbs the true
      // length is the upper end of the distribution, not the middle - and
      // feeding every observation to a median would learn a length somewhere
      // in the middle of "arm out" and "arm at the camera", which is a length
      // the arm never actually has.
      if (bone.foreshortens) {
        const current = this.estimate(bone.group).value;
        if (current === null || observed > current * conf.growThreshold) {
          this.estimate(bone.group).add(observed);
        }
      } else {
        this.estimate(bone.group).add(observed);
      }
    }

    // --- 3. Enforce rigidity --------------------------------------------
    let errorBefore = 0;
    let errorAfter = 0;
    let counted = 0;
    let learned = 0;

    const dt =
      this.lastTimestamp > 0
        ? Math.max(1e-3, (pose.timestamp - this.lastTimestamp) / 1000)
        : 1 / 15;
    this.lastTimestamp = pose.timestamp;
    // Framed as a time constant so the behaviour does not change when the pose
    // rate does - and the pose rate on this project is about to nearly double.
    const emaAlpha = 1 - Math.exp(-dt / conf.currentLengthTau);

    const active: { bone: BoneDef; target: number }[] = [];
    for (const bone of BONES) {
      const a = out[bone.a];
      const b = out[bone.b];
      if (!a || !b || scale === null) continue;
      const rest = this.estimate(bone.group).value;
      if (rest === null) continue;
      learned++;

      const full = rest * scale;
      const observed = Math.hypot(a.x - b.x, a.y - b.y);

      let target: number;
      if (bone.foreshortens && full > 1e-7) {
        // Track the observed length, using the pre-correction value so the
        // estimate cannot chase its own output.
        const key = `${bone.a}|${bone.b}`;
        const prev = this.currentLen.get(key);
        const ema = prev === undefined ? observed : prev + (observed - prev) * emaAlpha;
        this.currentLen.set(key, ema);

        // The discriminator: magnitude.
        const shortfall = Math.max(0, 1 - observed / full);
        const w = Math.min(
          1,
          Math.max(0, (shortfall - conf.noiseBand) / conf.relaxBand)
        );
        target = full * (1 - w) + Math.min(ema, full) * w;
      } else {
        target = full;
      }

      active.push({ bone, target });
      errorBefore += Math.abs(observed - full);
      counted++;
    }

    for (let iter = 0; iter < conf.iterations; iter++) {
      for (const { bone, target } of active) {
        const a = out[bone.a]!;
        const b = out[bone.b]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-7) continue;

        // Two-sided against `target`, which for a foreshortening limb is its
        // own slow-moving current length rather than its full extension. So a
        // sustained foreshortening is preserved (the target follows it) while
        // frame-to-frame noise in both directions is removed.
        const error = (d - target) / d;
        // Confidence decides who moves. A landmark the model is sure about
        // resists correction; an uncertain one absorbs it. Without this the
        // correction is split evenly and a confident shoulder gets dragged
        // around by a guessed wrist.
        const wa = 1 - Math.min(a.confidence, 0.99) + 0.05;
        const wb = 1 - Math.min(b.confidence, 0.99) + 0.05;
        const total = wa + wb;
        const stiff = conf.stiffness;
        dx *= error * stiff;
        dy *= error * stiff;
        a.x += (dx * wa) / total;
        a.y += (dy * wa) / total;
        b.x -= (dx * wb) / total;
        b.y -= (dy * wb) / total;
      }

      // --- 4. Enforce anatomy -------------------------------------------
      for (const limit of JOINT_LIMITS) {
        const root = out[limit.root];
        const joint = out[limit.joint];
        const tip = out[limit.tip];
        if (!root || !joint || !tip) continue;

        const ux = root.x - joint.x;
        const uy = root.y - joint.y;
        const vx = tip.x - joint.x;
        const vy = tip.y - joint.y;
        const lu = Math.hypot(ux, uy);
        const lv = Math.hypot(vx, vy);
        if (lu < 1e-7 || lv < 1e-7) continue;

        const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)));
        const angle = (Math.acos(cos) * 180) / Math.PI;
        if (angle >= limit.min) continue;

        // Rotate the tip away from the root about the joint, to the limit.
        const need = ((limit.min - angle) * Math.PI) / 180;
        // Sign from the 2D cross product, so the tip is pushed open rather
        // than folded further through the joint.
        const cross = ux * vy - uy * vx;
        const s = Math.sin(cross >= 0 ? need : -need);
        const c = Math.cos(need);
        const rx = vx * c - vy * s;
        const ry = vx * s + vy * c;
        tip.x = joint.x + rx;
        tip.y = joint.y + ry;
      }
    }

    for (const { bone, target } of active) {
      const a = out[bone.a]!;
      const b = out[bone.b]!;
      errorAfter += Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - target);
    }

    this.debugState = {
      learned,
      attempted,
      scale: ratio,
      rejected,
      meanError: counted ? errorBefore / counted : 0,
      meanErrorAfter: counted ? errorAfter / counted : 0,
    };

    this.prev = clone(out);
    return out;
  }
}

function clone(pose: PoseFrame): PoseFrame {
  const out = { timestamp: pose.timestamp } as PoseFrame;
  for (const key of ALL_POSE_KEYS) {
    const kp = pose[key] as Keypoint | undefined;
    if (!kp) continue;
    out[key] = { x: kp.x, y: kp.y, z: kp.z, confidence: kp.confidence };
  }
  return out;
}
