import type { Stats } from "../debug/perfStats";
import { isMeasured, type TrackingReport } from "../pose/trackingMonitor";
import type { DrillStats } from "../training/drill";
import type { StrikeEvent } from "../perception/strikeResolver";
import { SYSTEM_CONFIG } from "../config/tuning";

// The single aggregated report: pose tracking, frame timing, strike
// resolution and drill health in one place.
//
// Why this exists separately from trackingMonitor.ts
//
// `TrackingMonitor` already answers "is the camera signal any good" and feeds
// the auto-tuner. That is one question. This answers a different one - "is
// the whole pipeline healthy right now" - and the two must not be folded
// together: the tracking monitor's report is consumed by code that adjusts
// the pipeline, and widening what it measures would widen what a bug in the
// auto-tuner could reach. This module only reads the other layers' own
// reports; it has no write access to anything and cannot become a second path
// by which the pipeline gets tuned.
//
// Each section can be missing - no tracking report yet, no drill running, no
// strikes thrown - and missing is not the same as unhealthy. A section that
// has not started reports null rather than a score, and the overall score is
// the minimum of whichever sections are actually present. That mirrors
// TrackingReport's own rule (its overall score is the minimum of its metrics,
// not their average) at one level up: the system is only as healthy as its
// worst present part, and a part that has not run yet is not a part that is
// failing.
//
// Time is always injected
//
// Every method takes `atMs` explicitly, the same discipline `training/drill.ts`
// uses, so the whole thing is testable without a clock and without waiting.

export interface FrameHealth {
  /** Delivered frame rate, from the render loop's own measured interval -
   *  deliberately separate from TrackingReport's `hz`, so a render-side stall
   *  is visible even when pose sampling itself is fine. */
  hz: number;
  inferenceMs: number;
  score: number;
}

export interface StrikeHealth {
  /** Strikes resolved inside the window. */
  resolved: number;
  /** Of those, how many were illegal (below the belt). */
  fouls: number;
  /** ms since the last resolved strike, or null before the first one. */
  sinceLastMs: number | null;
  /** Highest reach seen across both hands this frame, 0-1. */
  peakReach: number;
  /** Near-miss samples (reach above the threshold) inside the window with
   *  nothing landed - see SYSTEM_CONFIG.nearMissReach. */
  nearMisses: number;
}

export interface SystemReport {
  tracking: TrackingReport | null;
  frame: FrameHealth | null;
  strike: StrikeHealth | null;
  drill: DrillStats | null;
  /** 0-1, the minimum of whichever sections are present. Null when nothing
   *  has reported anything yet. */
  score: number | null;
  /** Human-readable, ordered worst-first, spanning every section. */
  advice: string[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear ramp between a bad and a good value, clamped, direction-agnostic. */
function scoreBetween(value: number, bad: number, good: number): number {
  if (good === bad) return value >= good ? 1 : 0;
  return clamp01((value - bad) / (good - bad));
}

interface StrikeSample {
  atMs: number;
  legal: boolean;
}

interface ReachSample {
  atMs: number;
  peak: number;
}

/**
 * Owns the rolling state the other layers don't keep: how strikes and near
 * misses are spaced out over time. Frame timing, tracking and drill stats
 * arrive already computed from their own owners and are only read here.
 */
export class SystemMonitor {
  private strikes: StrikeSample[] = [];
  private reaches: ReachSample[] = [];
  private lastStrikeAtMs: number | null = null;
  /** True once the resolver has reported anything, ever - distinct from the
   *  windowed arrays above, which age out. A strike that happened nine
   *  seconds ago should still show "resolved: 0 now, last one 9s ago" rather
   *  than vanish back into "not measured yet" the moment the window passes. */
  private everActive = false;

  /** Called whenever the strike resolver lands a strike. */
  recordStrike(strike: StrikeEvent, atMs: number): void {
    this.everActive = true;
    this.strikes.push({ atMs, legal: strike.region.legal });
    this.lastStrikeAtMs = atMs;
    this.trim(atMs);
  }

  /** Called every tick with the current per-hand reach, 0-1. */
  sampleReach(reach: { left: number; right: number }, atMs: number): void {
    this.everActive = true;
    const peak = Math.max(reach.left, reach.right);
    if (peak >= SYSTEM_CONFIG.nearMissReach) {
      this.reaches.push({ atMs, peak });
    }
    this.trim(atMs);
  }

  private trim(atMs: number): void {
    const floor = atMs - SYSTEM_CONFIG.strikeWindowMs;
    while (this.strikes.length > 0 && this.strikes[0].atMs < floor) {
      this.strikes.shift();
    }
    while (this.reaches.length > 0 && this.reaches[0].atMs < floor) {
      this.reaches.shift();
    }
  }

  reset(): void {
    this.strikes = [];
    this.reaches = [];
    this.lastStrikeAtMs = null;
    this.everActive = false;
  }

  private strikeHealth(atMs: number): StrikeHealth | null {
    this.trim(atMs);
    if (!this.everActive) return null;
    return {
      resolved: this.strikes.length,
      fouls: this.strikes.filter((s) => !s.legal).length,
      sinceLastMs: this.lastStrikeAtMs === null ? null : atMs - this.lastStrikeAtMs,
      peakReach: this.reaches.length === 0 ? 0 : this.reaches[this.reaches.length - 1].peak,
      nearMisses: this.reaches.length,
    };
  }

  /**
   * Builds the aggregate report.
   *
   * `frame` takes the already-computed Stats objects from the render loop's
   * own RollingStats - this module does not own a second copy of that data,
   * it only reads it.
   */
  report(
    atMs: number,
    inputs: {
      tracking: TrackingReport | null;
      drill: DrillStats | null;
      frameInterval: Stats;
      inference: Stats;
    }
  ): SystemReport {
    const strike = this.strikeHealth(atMs);

    let frame: FrameHealth | null = null;
    if (inputs.frameInterval.count > 0) {
      const hz = inputs.frameInterval.median > 0 ? 1000 / inputs.frameInterval.median : 0;
      frame = {
        hz,
        inferenceMs: inputs.inference.median,
        score: scoreBetween(hz, SYSTEM_CONFIG.badFrameHz, SYSTEM_CONFIG.goodFrameHz),
      };
    }

    // A tracking report exists from the first pose frame, but its score is a
    // real 0 - not "unmeasured" - until enough samples have accumulated. Both
    // the score and the advice below must skip it until then, or a player who
    // has not yet stepped into frame reads as "0% healthy" rather than as
    // nobody being there. See isMeasured()'s own note on why this check
    // exists in exactly one place.
    const trackingMeasured = inputs.tracking && isMeasured(inputs.tracking);

    const scores: number[] = [];
    if (trackingMeasured) scores.push(inputs.tracking!.score);
    if (frame) scores.push(frame.score);
    // Drill and strike sections report data, not a pass/fail score - a drill
    // in progress or a burst of strikes is not "unhealthy" at any pace, so
    // neither contributes to the minimum. They still drive advice below.
    const score = scores.length === 0 ? null : Math.min(...scores);

    const advice: string[] = [];
    if (trackingMeasured) advice.push(...inputs.tracking!.advice);
    if (frame && frame.score < 0.5) {
      advice.push(
        `Frame delivery is slow (${frame.hz.toFixed(1)} Hz) - the render loop is falling behind the pose stream.`
      );
    }
    if (
      strike &&
      strike.nearMisses >= SYSTEM_CONFIG.nearMissAdviceCount &&
      strike.resolved === 0
    ) {
      advice.push(
        `${strike.nearMisses} punches have reached close to the threshold with none landing - the reach calibration may be off for this stance.`
      );
    }

    return { tracking: inputs.tracking, frame, strike, drill: inputs.drill, score, advice };
  }
}
