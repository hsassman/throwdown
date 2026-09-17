// Latency compensation: draws the character where you ARE, not where you were.
// THE LAG, ACCOUNTED FOR HONESTLY
//
// A landmark reaching the screen has already accumulated, on this machine:
//
//   camera exposure + transfer      ~16 ms   (one frame at 60 FPS capture)
//   inference                       ~36 ms   (measured)
//   waiting for the next whole
//     video frame callback          ~16-33 ms (the quantisation that pins the
//                                              pose rate to ~15 FPS)
//   one-euro filter group delay     ~20-40 ms (it is a low-pass; that is what
//                                              a low-pass does)
//   render + present                ~16 ms
//                                   ~105-140 ms
//
// A hundred milliseconds is roughly a fifth of a jab. It is not subtle: the
// character visibly trails the player, and every previous attempt to fix that
// feeling by loosening the smoothing traded it for jitter, because lag and
// jitter are the two ends of one filter and you cannot win both by tuning it.
//
// Prediction is the way out, because it is not on that axis at all. Estimate
// velocity, extrapolate forward by the measured age of the sample, and the
// smoothing can stay as strong as it needs to be.
//
// WHY THIS IS SAFE HERE AND OFTEN IS NOT
//
// Naive extrapolation is notorious for overshoot — it turns a direction change
// into a visible flick past the target. Four things keep that in check, and
// all four matter:
//
//   1. The velocity is filtered far harder than the position. Velocity from
//      two samples 66 ms apart is extremely noisy and prediction multiplies
//      that noise by the lead time, so the derivative gets its own heavy
//      low-pass.
//   2. A deadband. A stationary hand is not predicted at all, so resting
//      jitter is never amplified.
//   3. A hard cap on lead time, so a latency spike cannot become a lunge.
//   4. A cap on total displacement relative to the body, so no landmark can
//      be flung off the figure by a bad velocity estimate.
//
// STANDING RULE: `z` is never read. Prediction is applied to x/y only.

import { ALL_POSE_KEYS, type Keypoint, type PoseFrame } from "./poseTypes";
import { PREDICT_CONFIG } from "../config/tuning";

interface Track {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

export interface PredictorDebug {
  /** Smoothed age of the newest pose sample when last read, ms. */
  latencyMs: number;
  /** Lead time actually applied on the last prediction, ms. */
  leadMs: number;
  /** Landmarks predicted on the last call, out of those available. */
  predicted: number;
  available: number;
  /** Largest predicted displacement last call, in torso spans. */
  maxShift: number;
}

export class PosePredictor {
  /**
   * Multiplier from the tracking monitor, 0..1. Pulled DOWN when the signal is
   * gappy.
   *
   * Prediction extrapolates from a velocity estimate, and a velocity estimate
   * built from a stream with holes in it is mostly noise. Leading on that noise
   * flings landmarks around far more visibly than the latency it was correcting
   * for — so when dropout rises, the right answer is to predict LESS and accept
   * being a little behind.
   */
  private scale = 1;

  /** Sets how far ahead to lead, as a fraction of the measured latency. */
  setScale(scale: number): void {
    if (scale >= 0) this.scale = scale;
  }

  get predictScale(): number {
    return this.scale;
  }

  private tracks = new Map<string, Track>();
  private lastPose: PoseFrame | null = null;
  private latency = 0;
  private torso = 0.3;
  private debugState: PredictorDebug = {
    latencyMs: 0,
    leadMs: 0,
    predicted: 0,
    available: 0,
    maxShift: 0,
  };

  get debug(): PredictorDebug {
    return this.debugState;
  }

  reset(): void {
    this.tracks.clear();
    this.lastPose = null;
    this.latency = 0;
  }

  /** Feed a new pose sample. Call at pose rate (~15 Hz). */
  ingest(pose: PoseFrame): void {
    // Ignore a repeat of the same sample. The render loop runs ~4x faster than
    // the pose stream, so without this the velocity estimate is divided by a
    // dt of zero on most frames.
    if (this.lastPose && pose.timestamp === this.lastPose.timestamp) return;

    const t = pose.timestamp;
    for (const key of ALL_POSE_KEYS) {
      const kp = pose[key] as Keypoint | undefined;
      if (!kp) continue;
      const prev = this.tracks.get(key);
      if (!prev) {
        this.tracks.set(key, { x: kp.x, y: kp.y, vx: 0, vy: 0, t });
        continue;
      }
      const dt = (t - prev.t) / 1000;
      if (dt <= 1e-4) continue;

      const vx = (kp.x - prev.x) / dt;
      const vy = (kp.y - prev.y) / dt;

      // Exponential smoothing on the DERIVATIVE, framed so the time constant
      // means the same thing regardless of the sample interval. A raw alpha
      // would make the filter behave differently every time the pose rate
      // wobbled, which it does constantly.
      const a = 1 - Math.exp(-dt / PREDICT_CONFIG.velocityTau);
      prev.vx += (vx - prev.vx) * a;
      prev.vy += (vy - prev.vy) * a;
      prev.x = kp.x;
      prev.y = kp.y;
      prev.t = t;
    }

    this.lastPose = pose;

    const sx = (pose.leftShoulder.x + pose.rightShoulder.x) / 2;
    const sy = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;
    const hx = (pose.leftHip.x + pose.rightHip.x) / 2;
    const hy = (pose.leftHip.y + pose.rightHip.y) / 2;
    const span = Math.hypot(sx - hx, sy - hy);
    if (span > 1e-3) this.torso = span;
  }

  /**
   * The pose as it should be drawn NOW.
   *
   * `nowMs` must be on the same clock as the pose timestamps. Returns null
   * before the first sample.
   */
  predictAt(nowMs: number): PoseFrame | null {
    const pose = this.lastPose;
    if (!pose) return null;

    const age = Math.max(0, nowMs - pose.timestamp);
    // Smoothed, because a single late frame should not swing the correction.
    this.latency += (age - this.latency) * 0.12;

    const lead = Math.min(
      PREDICT_CONFIG.maxLeadSeconds,
      (this.latency / 1000) * PREDICT_CONFIG.strength * this.scale
    );

    const out = { timestamp: pose.timestamp } as PoseFrame;
    const deadband = PREDICT_CONFIG.deadband * this.torso;
    // No landmark may be displaced more than a third of a torso by prediction.
    // A bad velocity estimate on a briefly-lost wrist would otherwise fling it
    // off the figure entirely, and one such frame is more visible than all the
    // lag this is removing.
    const maxShift = this.torso * 0.33;

    let predicted = 0;
    let available = 0;
    let largest = 0;

    for (const key of ALL_POSE_KEYS) {
      const kp = pose[key] as Keypoint | undefined;
      if (!kp) continue;
      available++;
      const track = this.tracks.get(key);
      const copy: Keypoint = { x: kp.x, y: kp.y, z: kp.z, confidence: kp.confidence };

      if (
        track &&
        lead > 0 &&
        kp.confidence >= PREDICT_CONFIG.minConfidence
      ) {
        const speed = Math.hypot(track.vx, track.vy);
        if (speed > deadband) {
          // Ramp in across the deadband rather than switching on at it.
          // A hard threshold makes a hand that hovers near walking pace snap
          // between predicted and unpredicted, which looks like a twitch.
          const ramp = Math.min(1, (speed - deadband) / deadband);
          let dx = track.vx * lead * ramp;
          let dy = track.vy * lead * ramp;
          const shift = Math.hypot(dx, dy);
          if (shift > maxShift) {
            const k = maxShift / shift;
            dx *= k;
            dy *= k;
          }
          copy.x += dx;
          copy.y += dy;
          largest = Math.max(largest, Math.min(shift, maxShift) / this.torso);
          predicted++;
        }
      }
      out[key] = copy;
    }

    this.debugState = {
      latencyMs: this.latency,
      leadMs: lead * 1000,
      predicted,
      available,
      maxShift: largest,
    };
    return out;
  }
}
