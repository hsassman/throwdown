// One-euro filter: adaptive low-pass that smooths jitter when the signal is
// slow but stays responsive (low latency) when it moves fast.
//
// Ported unchanged in principle from the Flap project's flap/smoothing.ts.
// the gesture-classification notes requires smoothing before any trajectory work -
// both the heuristic classifier and (especially) a DTW comparison are sensitive
// to single-frame landmark jitter. The adaptive cutoff matters here: a fixed
// low-pass strong enough to kill resting jitter would also add lag to a real
// punch, and punch timing is the whole game.

import { ALL_POSE_KEYS, type PoseFrame } from "./poseTypes";
import { SMOOTHING_DEFAULTS } from "../config/tuning";

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }

  /**
   * Retunes the filter in place, keeping its history.
   *
   * In place rather than by replacement, because rebuilding the filter would
   * discard `xPrev` and restart it from the next sample - a visible jump on
   * every landmark, every time the auto-tuner nudged anything.
   */
  setParams(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  /** Filter value x sampled at time t (ms). */
  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;

    // Filtered derivative.
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;

    // Adaptive cutoff rises with speed => less smoothing on fast motion.
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = alpha(cutoff, dt);
    const xHat = aX * x + (1 - aX) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
}

/**
 * Applies a one-euro filter per landmark, per axis, producing a smoothed
 * PoseFrame. This sits between pose/ and perception/ exactly as described in
 * docs/ARCHITECTURE.md - the perception layer should never see raw landmarks.
 *
 * Confidence is passed through unfiltered; it's a quality signal, not a
 * trajectory, and smoothing it would blur the "landmark just became untracked"
 * edge that downstream gates rely on.
 */
export class PoseSmoother {
  private filters = new Map<string, OneEuroFilter>();
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  /**
   * Multiplier from the tracking monitor. Above 1 means filter harder.
   *
   * It divides the cutoff rather than multiplying it, because a One Euro
   * filter's cutoff is a frequency: a lower cutoff passes less and smooths
   * more. Multiplying would have made a noisy signal twitchier, which is the
   * exact opposite of what the monitor asked for and would have looked like
   * the auto-tuner making things worse.
   */
  private scale = 1;

  constructor(
    minCutoff = SMOOTHING_DEFAULTS.minCutoff,
    beta = SMOOTHING_DEFAULTS.beta,
    dCutoff = SMOOTHING_DEFAULTS.dCutoff
  ) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset(): void {
    this.filters.clear();
  }

  /**
   * Sets how hard to filter, as a multiple of the tuned defaults.
   *
   * Driven by `TrackingMonitor.tuning()`. Applied to every live filter as well
   * as to any created later, so the change takes effect on the next sample
   * rather than only on landmarks that happen to appear afterwards.
   */
  setScale(scale: number): void {
    if (!(scale > 0) || scale === this.scale) return;
    this.scale = scale;
    for (const f of this.filters.values()) {
      f.setParams(this.minCutoff / scale, this.beta / scale);
    }
  }

  /** The scale currently in force. */
  get smoothingScale(): number {
    return this.scale;
  }

  private get(key: string): OneEuroFilter {
    let f = this.filters.get(key);
    if (!f) {
      f = new OneEuroFilter(
        this.minCutoff / this.scale,
        this.beta / this.scale,
        this.dCutoff
      );
      this.filters.set(key, f);
    }
    return f;
  }

  smooth(pose: PoseFrame): PoseFrame {
    const t = pose.timestamp;
    const out = { timestamp: t } as PoseFrame;
    for (const key of ALL_POSE_KEYS) {
      const kp = pose[key];
      // Optional landmarks are absent whenever the body part is out of frame.
      if (!kp) continue;
      out[key] = {
        x: this.get(`${key}.x`).filter(kp.x, t),
        y: this.get(`${key}.y`).filter(kp.y, t),
        z: kp.z === undefined ? undefined : this.get(`${key}.z`).filter(kp.z, t),
        confidence: kp.confidence,
      };
    }
    return out;
  }
}
