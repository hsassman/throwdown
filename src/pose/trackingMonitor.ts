import {
  POSE_KEYS,
  torsoScaleOf,
  type PoseFrame,
  type PoseKey,
} from "./poseTypes";
import { MONITOR_CONFIG } from "../config/tuning";

// A standing watchdog on pose-tracking quality, and a bounded auto-tuner.
// WHAT THIS IS FOR
//
// Tracking quality is not a constant. It changes with the room's light, how
// far back the player stands, what they are wearing, whether the laptop is
// thermally throttling, and what else is on the GPU. Every tuning number in
// this project was calibrated in ONE set of those conditions, and nothing has
// ever noticed when the conditions moved.
//
// So this runs continuously alongside the tracker, measures what the tracker
// is actually delivering, and says so. It is the difference between "the
// skeleton looks wrong today" and "dropout is 31% on the right wrist".
//
// THE LINE IT WILL NOT CROSS
//
// It tunes SMOOTHING and PREDICTION only. Both are latency/cosmetic controls:
// how hard the signal is filtered, and how far ahead the renderer draws.
//
// It must NEVER touch perception thresholds -- reach, strike speed, dodge
// angles. Those decide what HITS, and a hit threshold that quietly relaxed
// because the lighting got worse would mean the game rewards a bad webcam.
// That is the same principle the architecture already enforces by keeping the
// character mesh out of hit resolution: what you land must not depend on how
// well you happen to be seen. The auto-tuner returns multipliers for the two
// permitted knobs and nothing else, and both are clamped.
//
// EVERY METRIC IS SCALE-FREE
//
// All distances are divided by the torso scale, so a player who sits closer to
// the camera does not read as jittery simply because their pixels are bigger.

/** One metric's standing, so a report can name its own weakest link. */
export interface MetricScore {
  name: string;
  /** Raw measured value, in the metric's own units. */
  value: number;
  /** 0 = unusable, 1 = ideal. */
  score: number;
  /** Set when the metric is below its warning level. */
  advice?: string;
}

export interface TrackingReport {
  /** Frames considered in this window. */
  samples: number;
  /** Delivered pose rate, Hz. */
  hz: number;
  /** Per-frame positional noise, torso units. Second difference, so steady
   *  motion contributes nothing and only the shake shows up. */
  jitter: number;
  /** Fraction of landmark readings below the usable confidence bar. */
  dropout: number;
  /** Spread of measured limb lengths, as a fraction of their median. A rigid
   *  body has constant limb lengths; anything else is tracking error. */
  limbVariance: number;
  /** Worst per-landmark dropout, and which landmark. Named because "12%
   *  dropout" hides "the right wrist is invisible half the time". */
  worstLandmark: { key: PoseKey; dropout: number } | null;
  /** 0-1 overall, the minimum of the parts rather than their average: tracking
   *  is only as good as its weakest signal, and averaging hides a dead limb. */
  score: number;
  metrics: MetricScore[];
  /** Human-readable, ordered worst-first. Empty when everything is healthy. */
  advice: string[];
}

/**
 * Whether a report reflects an actual measurement, as opposed to the empty
 * placeholder produced before `minSamples` frames have arrived.
 *
 * The placeholder's `score` is 0 — not "unmeasured", genuinely the numeric
 * value zero — because `TrackingReport.score` has no separate slot for "no
 * data yet" and 0 is what an empty min() naturally produces. Any caller that
 * reads `.score` directly without this check will report "0% healthy" for a
 * player who has not stepped in front of the camera, which reads as the
 * camera being broken rather than as nobody being there. ONE place decides
 * this so TrackingPanel and the system monitor cannot drift onto two
 * different definitions of "not measured yet".
 */
export function isMeasured(report: TrackingReport): boolean {
  return report.samples >= MONITOR_CONFIG.minSamples && report.metrics.length > 0;
}

/** The only two things the monitor is allowed to change. */
export interface TrackingTuning {
  /** Multiplier on smoothing time constants. >1 filters harder. */
  smoothingScale: number;
  /** Multiplier on prediction lead. <1 draws less far ahead. */
  predictScale: number;
}

const LIMBS: ReadonlyArray<readonly [PoseKey, PoseKey]> = [
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"],
  ["leftShoulder", "rightShoulder"],
];

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Maps a measurement onto 0-1, where `good` scores 1 and `bad` scores 0. */
function scoreOf(value: number, good: number, bad: number): number {
  if (bad === good) return 1;
  const t = (value - bad) / (good - bad);
  return Math.min(1, Math.max(0, t));
}

interface Sample {
  t: number;
  torso: number;
  /** Position per key, in torso units relative to the shoulder midpoint, so
   *  the player walking across the frame is not counted as jitter. */
  pos: Partial<Record<PoseKey, { x: number; y: number }>>;
  missing: PoseKey[];
  limbs: number[];
}

export class TrackingMonitor {
  private window: Sample[] = [];
  private limbHistory = new Map<number, number[]>();

  /** Feed every pose frame. Cheap: O(landmarks) and no allocation per key. */
  ingest(frame: PoseFrame | null): void {
    if (!frame) return;
    // `.value`, because torsoScaleOf reports its SOURCE alongside the number:
    // shoulder-to-hip when the hips are visible, shoulder width otherwise. The
    // two are not interchangeable, which is exactly why the type makes you
    // unwrap it rather than handing back a bare number.
    const scale = torsoScaleOf(frame, MONITOR_CONFIG.minConfidence);
    const torso = scale?.value ?? 0;
    // Without a torso scale nothing here is comparable between frames, so the
    // frame is counted as a total dropout rather than silently skipped.
    if (!scale || torso < 1e-6) {
      this.window.push({
        t: frame.timestamp,
        torso: 0,
        pos: {},
        missing: [...POSE_KEYS],
        limbs: [],
      });
      this.trim();
      return;
    }

    const origin = {
      x: (frame.leftShoulder.x + frame.rightShoulder.x) / 2,
      y: (frame.leftShoulder.y + frame.rightShoulder.y) / 2,
    };

    const pos: Sample["pos"] = {};
    const missing: PoseKey[] = [];
    for (const key of POSE_KEYS) {
      const kp = frame[key];
      if (!kp || kp.confidence < MONITOR_CONFIG.minConfidence) {
        missing.push(key);
        continue;
      }
      pos[key] = {
        x: (kp.x - origin.x) / torso,
        y: (kp.y - origin.y) / torso,
      };
    }

    const limbs: number[] = [];
    LIMBS.forEach(([a, b], i) => {
      const pa = pos[a];
      const pb = pos[b];
      if (!pa || !pb) {
        limbs.push(NaN);
        return;
      }
      const len = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      limbs.push(len);
      const hist = this.limbHistory.get(i) ?? [];
      hist.push(len);
      if (hist.length > MONITOR_CONFIG.windowFrames) hist.shift();
      this.limbHistory.set(i, hist);
    });

    this.window.push({ t: frame.timestamp, torso, pos, missing, limbs });
    this.trim();
  }

  private trim(): void {
    while (this.window.length > MONITOR_CONFIG.windowFrames) this.window.shift();
  }

  reset(): void {
    this.window = [];
    this.limbHistory.clear();
  }

  /** How many frames are in the current window. */
  get samples(): number {
    return this.window.length;
  }

  report(): TrackingReport {
    const n = this.window.length;
    const empty: TrackingReport = {
      samples: n,
      hz: 0,
      jitter: 0,
      dropout: 1,
      limbVariance: 0,
      worstLandmark: null,
      score: 0,
      metrics: [],
      advice: ["not enough samples yet"],
    };
    if (n < MONITOR_CONFIG.minSamples) return empty;

    // --- rate ------------------------------------------------------------
    const span = (this.window[n - 1].t - this.window[0].t) / 1000;
    const hz = span > 0 ? (n - 1) / span : 0;

    // --- dropout, overall and per landmark -------------------------------
    const misses = new Map<PoseKey, number>();
    let missTotal = 0;
    for (const s of this.window) {
      for (const key of s.missing) {
        misses.set(key, (misses.get(key) ?? 0) + 1);
        missTotal++;
      }
    }
    const dropout = missTotal / (n * POSE_KEYS.length);
    let worstLandmark: TrackingReport["worstLandmark"] = null;
    for (const [key, count] of misses) {
      const rate = count / n;
      if (!worstLandmark || rate > worstLandmark.dropout) {
        worstLandmark = { key, dropout: rate };
      }
    }

    // --- jitter ----------------------------------------------------------
    // SECOND difference, not first. A punch is a large first difference and is
    // signal, not noise; shake shows up as the frame-to-frame CHANGE in
    // velocity. Median over landmarks so one flickering ankle does not
    // dominate the reading.
    const accels: number[] = [];
    for (let i = 2; i < n; i++) {
      const a = this.window[i - 2];
      const b = this.window[i - 1];
      const c = this.window[i];
      for (const key of POSE_KEYS) {
        const pa = a.pos[key];
        const pb = b.pos[key];
        const pc = c.pos[key];
        if (!pa || !pb || !pc) continue;
        accels.push(
          Math.hypot(pc.x - 2 * pb.x + pa.x, pc.y - 2 * pb.y + pa.y)
        );
      }
    }
    const jitter = median(accels);

    // --- limb-length stability -------------------------------------------
    // A rigid body has constant limb lengths. Any spread is tracking error --
    // the same reasoning skeletonSolver.ts uses, and the reason it estimates
    // with a MEDIAN. Reported as spread over median so it is scale-free.
    const variances: number[] = [];
    for (const hist of this.limbHistory.values()) {
      const clean = hist.filter((v) => Number.isFinite(v) && v > 1e-6);
      if (clean.length < MONITOR_CONFIG.minSamples) continue;
      const mid = median(clean);
      if (mid < 1e-6) continue;
      const spread = median(clean.map((v) => Math.abs(v - mid))) / mid;
      variances.push(spread);
    }
    const limbVariance = variances.length ? Math.max(...variances) : 0;

    // --- scoring ----------------------------------------------------------
    const cfg = MONITOR_CONFIG;
    const metrics: MetricScore[] = [
      {
        name: "rate",
        value: hz,
        score: scoreOf(hz, cfg.goodHz, cfg.badHz),
        advice:
          `pose rate ${hz.toFixed(1)} Hz is below ${cfg.badHz} Hz — inference is the bottleneck, not the camera`,
      },
      {
        name: "dropout",
        value: dropout,
        score: scoreOf(dropout, cfg.goodDropout, cfg.badDropout),
        advice:
          worstLandmark
              ? `${(dropout * 100).toFixed(0)}% of landmarks unusable — worst is ${worstLandmark.key} at ${(worstLandmark.dropout * 100).toFixed(0)}%; check framing and lighting`
              : `${(dropout * 100).toFixed(0)}% of landmarks unusable`,
      },
      {
        name: "jitter",
        value: jitter,
        score: scoreOf(jitter, cfg.goodJitter, cfg.badJitter),
        advice:
          `jitter ${jitter.toFixed(3)} torso/frame² — smoothing raised; if it persists the room is probably underlit`,
      },
      {
        name: "limbs",
        value: limbVariance,
        score: scoreOf(limbVariance, cfg.goodLimbVariance, cfg.badLimbVariance),
        advice:
          `limb lengths vary by ${(limbVariance * 100).toFixed(0)}% — the skeleton is breathing, so depth recovery will be unreliable`,
      },
    ];

    // MINIMUM, not mean. Tracking is only as usable as its weakest signal, and
    // averaging lets three healthy metrics hide a limb that is not tracked at
    // all.
    const score = Math.min(...metrics.map((m) => m.score));
    // Keyed off the SCORE, not off each metric's "bad" line. A 15 Hz pose
    // rate scores 0.36 while sitting above the bad threshold, and reporting
    // nothing about it was how the project's actual bottleneck stayed quiet.
    const advice = metrics
      .filter((m) => m.advice && m.score < cfg.warnScore)
      .sort((a, b) => a.score - b.score)
      .map((m) => m.advice!);

    return {
      samples: n,
      hz,
      jitter,
      dropout,
      limbVariance,
      worstLandmark,
      score,
      metrics,
      advice,
    };
  }

  /**
   * Bounded corrections for the two knobs the monitor may touch.
   *
   * Deliberately gentle and deliberately clamped. This runs unattended, and a
   * tuner that can reach an extreme will eventually get there on one bad
   * window and stay -- so the range it can express is small enough that the
   * worst case is merely a bit soft or a bit laggy, never broken.
   */
  tuning(report = this.report()): TrackingTuning {
    const cfg = MONITOR_CONFIG;
    if (report.samples < cfg.minSamples) {
      return { smoothingScale: 1, predictScale: 1 };
    }

    // Noisy signal -> filter harder. Clean signal -> let it through, because
    // over-smoothing blunts exactly the fast motion this game is made of.
    const jitterExcess = report.jitter / Math.max(1e-6, cfg.goodJitter);
    const smoothingScale = Math.min(
      cfg.maxSmoothingScale,
      Math.max(cfg.minSmoothingScale, Math.sqrt(jitterExcess))
    );

    // Prediction extrapolates forward. Extrapolating a noisy or gappy signal
    // amplifies the noise, so lead is pulled in when either is bad -- the
    // WORSE of the two, since one is enough to make a prediction wrong.
    const quality = Math.min(
      scoreOf(report.jitter, cfg.goodJitter, cfg.badJitter),
      scoreOf(report.dropout, cfg.goodDropout, cfg.badDropout)
    );
    const predictScale = Math.min(
      cfg.maxPredictScale,
      Math.max(cfg.minPredictScale, quality)
    );

    return { smoothingScale, predictScale };
  }
}
