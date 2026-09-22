// Punch detection and type classification - Approach a from
// the gesture-classification notes: a guard-state FSM plus geometric/velocity
// heuristics on the shoulder-elbow-wrist chain.
//
// Detection (was a punch thrown?) and classification (which punch?) are kept
// separate. Detection is tractable; classification is the open problem this
// milestone exists to measure, since curved punches thrown at the camera are
// foreshortened along the very axis that distinguishes them. Nothing reads z
// (see geometry.ts).

import type { PoseFrame, Keypoint } from "../pose/poseTypes";
import { PERCEPTION_CONFIG as C } from "../config/tuning";
import { allVisible, angleDeg, dist } from "./geometry";
import type { CalibrationData } from "./calibration";
import {
  PUNCH_FAMILY,
  leadHand,
  punchTypeFor,
  type HandSide,
  type PunchEvent,
  type PunchFeatures,
  type PunchType,
} from "./punchTypes";

interface Sample {
  t: number;
  wrist: { x: number; y: number };
  /**
   * Distance the fist has travelled from its calibrated guard position, in
   * torso units. Detection keys on this, not on `extension`.
   *
   * A punch thrown at the lens moves the fist toward the camera, so its 2D
   * distance from the shoulder barely grows - the extension-based design it
   * replaced detected only 19% of real punches (risk log OQ1). Excursion from
   * guard has no such blind axis and is direction-agnostic, so one gate serves
   * straights, hooks and uppercuts alike.
   */
  excursion: number;
  /** Torso-normalized speed of the wrist, torso-widths per second. */
  speed: number;
  extension: number; // torso-normalized wrist-to-shoulder distance (feature only)
  elbowAngle: number;
  /** Signed horizontal offset from the body midline, torso units, inward-positive. */
  inward: number;
  /** Height above the shoulder line, torso units, up-positive. */
  height: number;
}

type Phase = "guard" | "punching";

/** Live per-hand state, surfaced for the debug overlay. */
export interface HandDebugState {
  phase: Phase;
  extension: number;
  elbowAngle: number;
  speed: number;
}

/** Why a candidate punch failed the detection gates. */
export interface RejectionRecord {
  hand: HandSide;
  reason: string;
  peakExcursion: number;
  peakExtension: number;
  extensionGain: number;
  elbowOpening: number;
  peakSpeed: number;
  durationMs: number;
  samples: number;
  at: number;
}

/**
 * Instrumentation for diagnosing detection failures. Features are only produced
 * for punches that pass the gates, so `peakSeen` records the highest value each
 * signal reached regardless of detection: if a peak sits below its gate, the
 * gate is unreachable for that player rather than merely strict.
 */
export interface ClassifierDiagnostics {
  launches: number;
  detections: number;
  rejections: number;
  byReason: Record<string, number>;
  recent: RejectionRecord[];
  peakSeen: Record<
    HandSide,
    {
      excursion: number;
      extension: number;
      speed: number;
      elbowOpen: number;
      /** Highest mean outward speed seen across completed episodes. Distinct
       * from `speed`, which is the instantaneous per-sample peak: `meanSpeed`
       * is the quantity `minMeanSpeed` actually gates on. Comparing the
       * instantaneous peak against that gate reads "fine" almost always, which
       * is exactly the wrong signal when diagnosing why punches were rejected. */
      meanSpeed: number;
    }
  >;
  /** The excursion gate actually applied, per hand - `max(minPunchExcursion,
   * guardJitter x guardNoiseMultiple)`. Surfaced because a jittery player's
   * real gate sits well above the configured constant, and a diagnostics panel
   * showing the constant would report "ok" while every punch is rejected. */
  excursionGate: Record<HandSide, number>;
}

/** Mutable diagnostics shared by both hands. */
function emptyDiagnostics(): ClassifierDiagnostics {
  return {
    launches: 0,
    detections: 0,
    rejections: 0,
    byReason: {},
    recent: [],
    peakSeen: {
      left: { excursion: 0, extension: 0, speed: 0, elbowOpen: 0, meanSpeed: 0 },
      right: { excursion: 0, extension: 0, speed: 0, elbowOpen: 0, meanSpeed: 0 },
    },
    excursionGate: { left: C.minPunchExcursion, right: C.minPunchExcursion },
  };
}

class HandTracker {
  private history: Sample[] = [];
  private phase: Phase = "guard";
  private launchIndex = 0;
  private peakIndex = 0;
  private lastPunchAt = -Infinity;
  private speed = 0;
  private side: HandSide;
  private diag: ClassifierDiagnostics;

  constructor(side: HandSide, diag: ClassifierDiagnostics) {
    this.side = side;
    this.diag = diag;
  }

  get debug(): HandDebugState {
    const last = this.history[this.history.length - 1];
    return {
      phase: this.phase,
      extension: last?.extension ?? 0,
      elbowAngle: last?.elbowAngle ?? 0,
      speed: this.speed,
    };
  }

  reset(): void {
    this.history = [];
    this.phase = "guard";
    this.speed = 0;
    this.lastPunchAt = -Infinity;
  }

  /**
   * Feeds one frame. Returns a PunchEvent at the moment a punch completes
   * (peak extension reached and the hand starts back toward guard), else null.
   */
  update(pose: PoseFrame, cal: CalibrationData, now: number): PunchEvent | null {
    const shoulder = this.side === "left" ? pose.leftShoulder : pose.rightShoulder;
    const elbow = this.side === "left" ? pose.leftElbow : pose.rightElbow;
    const wrist = this.side === "left" ? pose.leftWrist : pose.rightWrist;

    if (!allVisible(C.minLandmarkConfidence, shoulder, elbow, wrist)) {
      // Losing the arm mid-punch would otherwise produce a garbage trajectory.
      if (this.phase === "punching") this.abort();
      return null;
    }

    const sample = this.toSample(shoulder, wrist, elbow, cal, now);
    this.pushSample(sample);

    if (this.phase === "guard") {
      this.maybeLaunch(sample, now, cal);
      return null;
    }
    return this.trackPunch(sample, now, cal);
  }

  private toSample(
    shoulder: Keypoint,
    wrist: Keypoint,
    elbow: Keypoint,
    cal: CalibrationData,
    now: number
  ): Sample {
    const scale = cal.torsoScale;
    // Inward is toward the body midline, so its sign depends on which side of
    // the body the hand is on. MediaPipe's "left" is the subject's anatomical
    // left, which appears on the right of an unmirrored image - hence the
    // left hand's inward direction is negative-x.
    const rawOffset = wrist.x - cal.midlineX;
    const inward = (this.side === "left" ? -rawOffset : rawOffset) / scale;

    // Displacement from the calibrated guard, in shoulder-relative torso units.
    const guard = cal.guardWrist[this.side];
    const offX = (wrist.x - shoulder.x) / scale - guard.x;
    const offY = (wrist.y - shoulder.y) / scale - guard.y;

    const prev = this.history[this.history.length - 1];
    let speed = 0;
    if (prev) {
      const dt = Math.max((now - prev.t) / 1000, 1e-3);
      // Torso-normalized to match the units the speed threshold is expressed in.
      speed =
        Math.hypot(wrist.x - prev.wrist.x, wrist.y - prev.wrist.y) / scale / dt;
    }

    return {
      t: now,
      wrist: { x: wrist.x, y: wrist.y },
      excursion: Math.hypot(offX, offY),
      speed,
      extension: dist(wrist, shoulder) / scale,
      elbowAngle: angleDeg(shoulder, elbow, wrist),
      inward,
      // y grows downward in image space, so flip it to make up positive.
      height: (cal.shoulderY - wrist.y) / scale,
    };
  }

  private pushSample(s: Sample): void {
    this.history.push(s);

    // When the ring buffer slides, every stored index shifts down by one. This
    // must key off an actual shift (> capacity), not off reaching capacity, or
    // launch/peak get decremented against a buffer that never moved.
    if (this.history.length > C.historySize) {
      this.history.shift();
      this.launchIndex = Math.max(0, this.launchIndex - 1);
      this.peakIndex = Math.max(0, this.peakIndex - 1);
    }

    this.speed = s.speed;

    // Running maxima, independent of detection - these reveal an unreachable gate.
    const peak = this.diag.peakSeen[this.side];
    peak.excursion = Math.max(peak.excursion, s.excursion);
    peak.extension = Math.max(peak.extension, s.extension);
    peak.speed = Math.max(peak.speed, s.speed);
  }

  private abort(): void {
    this.phase = "guard";
  }

  /**
   * Punch threshold for this player: the larger of a configured floor and a
   * multiple of the player's own measured guard jitter, so a shaky stance or a
   * noisy camera raises the bar automatically instead of firing phantom punches.
   */
  private minExcursion(cal: CalibrationData): number {
    return Math.max(
      C.minPunchExcursion,
      cal.guardJitter[this.side] * C.guardNoiseMultiple
    );
  }

  /** Excursion below which the hand counts as back at guard and re-arms. */
  private reArmExcursion(cal: CalibrationData): number {
    return Math.max(
      C.guardExcursion,
      cal.guardJitter[this.side] * C.guardNoiseMultiple * 0.6
    );
  }

  private maybeLaunch(s: Sample, now: number, cal: CalibrationData): void {
    if (now - this.lastPunchAt < C.cooldownMs) return;
    const prev = this.history[this.history.length - 2];
    if (!prev) return;

    // Launch when the fist leaves guard and is still moving away from it.
    // Requiring the previous sample to sit inside the guard radius is the
    // re-arming rule: an already-extended hand can't re-trigger on small drift.
    const nearGuard = prev.excursion < this.reArmExcursion(cal);
    const leaving = s.excursion > prev.excursion;

    if (nearGuard && leaving) {
      this.diag.launches++;
      this.phase = "punching";
      this.launchIndex = this.history.length - 2;
      this.peakIndex = this.history.length - 1;
    }
  }

  private trackPunch(s: Sample, now: number, cal: CalibrationData): PunchEvent | null {
    const launch = this.history[this.launchIndex];
    const peak = this.history[this.peakIndex];
    if (!launch || !peak) {
      this.abort();
      return null;
    }

    // A punch is the whole excursion episode - fist leaving guard to returning
    // - not the first local peak. Finalising on the first peak swallowed an
    // uppercut's real drive behind its chamber (any wind-up has that shape).
    if (s.excursion > peak.excursion) {
      this.peakIndex = this.history.length - 1;
    }

    if (now - launch.t > C.maxPunchDurationMs) {
      // Hand left guard and never came back in a plausible time - a reach or
      // a block, not a punch.
      this.abort();
      return null;
    }

    // Not home yet.
    if (s.excursion > this.reArmExcursion(cal)) return null;

    // Fist is back at guard: the episode is complete. Decide whether the
    // motion we just saw actually qualifies.
    const done = this.finalize(launch, this.history[this.peakIndex], cal);
    this.phase = "guard";
    if (done) this.lastPunchAt = now;
    return done;
  }

  private finalize(
    launch: Sample,
    peak: Sample,
    cal: CalibrationData
  ): PunchEvent | null {
    const window = this.history.slice(this.launchIndex, this.peakIndex + 1);
    const durationMs = peak.t - launch.t;
    const extensionGain = peak.extension - launch.extension;
    const elbowOpening = peak.elbowAngle - launch.elbowAngle;

    let peakSpeed = 0;
    let pathLength = 0;
    for (let i = 1; i < window.length; i++) {
      const a = window[i - 1];
      const b = window[i];
      pathLength +=
        Math.hypot(b.wrist.x - a.wrist.x, b.wrist.y - a.wrist.y) / cal.torsoScale;
      peakSpeed = Math.max(peakSpeed, b.speed);
    }
    const peakExcursion = peak.excursion;
    // Mean outward velocity, torso-widths per second. Gated instead of peak
    // speed, which is frame-rate dependent: a slower camera under-reports the
    // true peak, so the same punch would pass at 30 FPS and fail at 15. Mean
    // distance-over-duration has no such dependence.
    const meanSpeed = durationMs > 0 ? peakExcursion / (durationMs / 1000) : 0;

    // Recorded before the gates below, so rejected episodes are represented
    // too - those are the ones a failed run needs to explain.
    this.diag.peakSeen[this.side].meanSpeed = Math.max(
      this.diag.peakSeen[this.side].meanSpeed,
      meanSpeed
    );
    this.diag.excursionGate[this.side] = this.minExcursion(cal);

    // Reject non-punches: slow reaches, small adjustments, guard fidgeting.
    // The first failing gate is recorded so a failed run can name the culprit.
    // Extension and elbow opening are deliberately not gated - both collapse
    // under foreshortening (the 19% run) and survive only as classification
    // features, where being weak costs accuracy rather than the whole punch.
    const reason =
      peakExcursion < this.minExcursion(cal)
        ? `excursion ${peakExcursion.toFixed(2)} < ${this.minExcursion(cal).toFixed(2)}`
        : meanSpeed < C.minMeanSpeed
          ? `mean speed ${meanSpeed.toFixed(2)} < ${C.minMeanSpeed}`
          : durationMs > C.maxPunchDurationMs
            ? `duration ${durationMs.toFixed(0)}ms > ${C.maxPunchDurationMs}ms`
            : window.length < C.minPunchSamples
              ? `only ${window.length} samples (need ${C.minPunchSamples})`
              : null;

    this.diag.peakSeen[this.side].elbowOpen = Math.max(
      this.diag.peakSeen[this.side].elbowOpen,
      elbowOpening
    );

    if (reason !== null) {
      this.diag.rejections++;
      // Bucket by gate name, dropping the numbers, so counts aggregate.
      const key = reason.replace(/[-\d.]+/g, "").replace(/\s+/g, " ").trim();
      this.diag.byReason[key] = (this.diag.byReason[key] ?? 0) + 1;
      this.diag.recent.unshift({
        hand: this.side,
        reason,
        peakExcursion,
        peakExtension: peak.extension,
        extensionGain,
        elbowOpening,
        peakSpeed,
        durationMs,
        samples: window.length,
        at: peak.t,
      });
      this.diag.recent.length = Math.min(this.diag.recent.length, 12);
      return null;
    }

    this.diag.detections++;

    const straightLine = Math.hypot(
      (peak.wrist.x - launch.wrist.x) / cal.torsoScale,
      (peak.wrist.y - launch.wrist.y) / cal.torsoScale
    );

    // Vertical travel is measured from the lowest point reached, not from
    // launch: an uppercut chambers down before driving up, so launch-to-peak
    // understates its rise.
    let lowestHeight = launch.height;
    for (const w of window) lowestHeight = Math.min(lowestHeight, w.height);

    const features: PunchFeatures = {
      peakExcursion,
      inwardTravel: peak.inward - launch.inward,
      upwardTravel: peak.height - lowestHeight,
      extensionGain,
      peakExtension: peak.extension,
      elbowAngleStart: launch.elbowAngle,
      elbowAnglePeak: peak.elbowAngle,
      peakSpeed,
      curvature: straightLine > 1e-3 ? pathLength / straightLine : 1,
      lowestHeight,
      durationMs,
      sampleCount: window.length,
    };

    return buildEvent(features, this.side, cal, peak.t);
  }
}

/**
 * Scores the three motion families against the measured features, then maps the
 * winner onto a punch type using the calibrated stance. Scores are deliberately
 * simple and additive so a misclassification can be read off the per-type
 * scores in the debug UI - Approach a exists to be diagnosed, then kept or dropped.
 */
function buildEvent(
  f: PunchFeatures,
  side: HandSide,
  cal: CalibrationData,
  timestamp: number
): PunchEvent {
  const hookScore =
    ratio(f.inwardTravel, C.hookInwardTravel) * 1.0 +
    ratio(f.curvature - 1, C.curvedPathRatio - 1) * 0.5;

  const uppercutScore =
    ratio(f.upwardTravel, C.uppercutUpwardTravel) * 1.0 +
    ratio(-f.lowestHeight, C.uppercutChamberDepth) * 0.6 +
    ratio(f.curvature - 1, C.curvedPathRatio - 1) * 0.3;

  // A straight punch is characterised by what it lacks: no swing across the
  // body, no upward drive, no arc. Two subtleties: only travel toward the
  // midline counts against it (outward extension is what a straight does), and
  // extension gain is not scored (hooks/uppercuts gain it too).
  const straightScore =
    (1 - Math.min(1, ratio(Math.max(0, f.inwardTravel), C.hookInwardTravel))) * 1.0 +
    (1 - Math.min(1, ratio(Math.max(0, f.upwardTravel), C.uppercutUpwardTravel))) *
      1.0 +
    (1 - Math.min(1, ratio(f.curvature - 1, C.curvedPathRatio - 1))) * 0.5;

  const role: "lead" | "rear" = side === leadHand(cal.stance) ? "lead" : "rear";

  type Family = "straight" | "hook" | "uppercut";
  const families: { key: Family; score: number }[] = [
    { key: "straight" as Family, score: straightScore },
    { key: "hook" as Family, score: hookScore },
    { key: "uppercut" as Family, score: uppercutScore },
  ].sort((a, b) => b.score - a.score);

  const winner = families[0];
  const runnerUp = families[1];
  const total = families.reduce((s, x) => s + Math.max(0, x.score), 0) || 1;
  const confidence = Math.max(
    0,
    Math.min(1, (winner.score - runnerUp.score) / total)
  );

  const type = punchTypeFor(winner.key, role);

  // Report scores per punch type, mapping the straight family onto whichever
  // of jab/cross the stance implies, so the debug readout lines up with the
  // labels used in the confusion matrix.
  const scores: Record<PunchType, number> = {
    jab: role === "lead" ? straightScore : 0,
    cross: role === "rear" ? straightScore : 0,
    hook: hookScore,
    uppercut: uppercutScore,
  };

  return {
    type,
    family: PUNCH_FAMILY[type],
    hand: side,
    role,
    confidence,
    scores,
    features: f,
    timestamp,
  };
}

/** Normalized ratio of a value against a threshold, clamped at zero. */
function ratio(value: number, threshold: number): number {
  if (threshold <= 0) return 0;
  return Math.max(0, value / threshold);
}

/** Detects punches from both hands against a calibrated player. */
export class PunchClassifier {
  private diag = emptyDiagnostics();
  private left = new HandTracker("left", this.diag);
  private right = new HandTracker("right", this.diag);

  reset(): void {
    this.left.reset();
    this.right.reset();
  }

  /** Live detection diagnostics. See ClassifierDiagnostics for why. */
  get diagnostics(): ClassifierDiagnostics {
    return this.diag;
  }

  /** Clears diagnostics without disturbing in-flight tracking state. */
  resetDiagnostics(): void {
    const fresh = emptyDiagnostics();
    this.diag.launches = fresh.launches;
    this.diag.detections = fresh.detections;
    this.diag.rejections = fresh.rejections;
    this.diag.byReason = fresh.byReason;
    this.diag.recent = fresh.recent;
    this.diag.peakSeen = fresh.peakSeen;
    this.diag.excursionGate = fresh.excursionGate;
  }

  get debug(): Record<HandSide, HandDebugState> {
    return { left: this.left.debug, right: this.right.debug };
  }

  /** Returns any punches that completed on this frame. */
  update(pose: PoseFrame, cal: CalibrationData, now: number): PunchEvent[] {
    const events: PunchEvent[] = [];
    const l = this.left.update(pose, cal, now);
    if (l) events.push(l);
    const r = this.right.update(pose, cal, now);
    if (r) events.push(r);
    return events;
  }
}
