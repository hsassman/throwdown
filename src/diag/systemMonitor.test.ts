import { describe, it, expect } from "vitest";
import { SystemMonitor } from "./systemMonitor";
import { SYSTEM_CONFIG } from "../config/tuning";
import type { TrackingReport } from "../pose/trackingMonitor";
import type { DrillStats } from "../training/drill";
import type { Stats } from "../debug/perfStats";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
  type ImpactPoint,
} from "../perception/strikeGeometry";
import { STRIKE_CONFIG } from "../config/tuning";
import type { StrikeEvent } from "../perception/strikeResolver";

// The aggregate report, exercised without a camera, a renderer or a clock —
// every method takes its own timestamp, the same discipline drill.ts uses.

const EMPTY_STATS: Stats = {
  count: 0,
  mean: 0,
  median: 0,
  p5: 0,
  p95: 0,
  min: 0,
  max: 0,
};

function stats(over: Partial<Stats>): Stats {
  return { ...EMPTY_STATS, count: 1, ...over };
}

function strike(impact: ImpactPoint, power = 1): StrikeEvent {
  const region = regionAt(impact);
  const approach = approachOf(0, 0, 1);
  return {
    hand: "right",
    zone: coarseZone(impact),
    impact,
    region,
    approach,
    damage: damageOf(region, power, approach),
    contactReach: STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
    power,
    speed: 4,
    timestamp: 0,
  };
}

const legalStrike = () => strike({ lateral: 0, height: 1.21 });
const foulStrike = () => strike({ lateral: 0, height: -0.4 });

function baseReport(inputs: {
  tracking?: TrackingReport | null;
  drill?: DrillStats | null;
  frameInterval?: Stats;
  inference?: Stats;
}) {
  return {
    tracking: inputs.tracking ?? null,
    drill: inputs.drill ?? null,
    frameInterval: inputs.frameInterval ?? EMPTY_STATS,
    inference: inputs.inference ?? EMPTY_STATS,
  };
}

describe("sections report null before they have anything to say", () => {
  it("is entirely empty with nothing fed in", () => {
    const m = new SystemMonitor();
    const r = m.report(0, baseReport({}));
    expect(r.tracking).toBeNull();
    expect(r.frame).toBeNull();
    expect(r.strike).toBeNull();
    expect(r.drill).toBeNull();
    expect(r.score).toBeNull();
    expect(r.advice).toEqual([]);
  });

  it("a section appearing does not force the others to appear", () => {
    const m = new SystemMonitor();
    const r = m.report(0, baseReport({ frameInterval: stats({ median: 30 }) }));
    expect(r.frame).not.toBeNull();
    expect(r.tracking).toBeNull();
    expect(r.strike).toBeNull();
  });
});

describe("frame health", () => {
  it("converts the median interval to Hz", () => {
    const m = new SystemMonitor();
    // 40ms median interval is 25 Hz.
    const r = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 40, count: 50 }) })
    );
    expect(r.frame!.hz).toBeCloseTo(25, 6);
  });

  it("scores well above the good floor and poorly below the bad floor", () => {
    const m = new SystemMonitor();
    const good = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 1000 / 40 }) })
    ).frame!.score;
    const bad = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 1000 / 5 }) })
    ).frame!.score;
    expect(good).toBeGreaterThan(bad);
    expect(good).toBe(1);
    expect(bad).toBe(0);
  });

  it("carries inference time through from the median", () => {
    const m = new SystemMonitor();
    const r = m.report(
      0,
      baseReport({
        frameInterval: stats({ median: 30 }),
        inference: stats({ median: 47.5 }),
      })
    );
    expect(r.frame!.inferenceMs).toBe(47.5);
  });

  it("advises when frame delivery is slow", () => {
    const m = new SystemMonitor();
    const r = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 1000 / SYSTEM_CONFIG.badFrameHz }) })
    );
    expect(r.advice.some((a) => /frame delivery/i.test(a))).toBe(true);
  });

  it("does not advise when frame delivery is healthy", () => {
    const m = new SystemMonitor();
    const r = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 1000 / SYSTEM_CONFIG.goodFrameHz }) })
    );
    expect(r.advice.some((a) => /frame delivery/i.test(a))).toBe(false);
  });
});

describe("strike health", () => {
  it("counts resolved strikes inside the window and drops old ones", () => {
    const m = new SystemMonitor();
    m.recordStrike(legalStrike(), 0);
    m.recordStrike(legalStrike(), 1000);
    let r = m.report(2000, baseReport({}));
    expect(r.strike!.resolved).toBe(2);

    // Past the window: both fall out.
    r = m.report(2000 + SYSTEM_CONFIG.strikeWindowMs + 1, baseReport({}));
    expect(r.strike!.resolved).toBe(0);
  });

  it("separates fouls from legal strikes", () => {
    const m = new SystemMonitor();
    m.recordStrike(legalStrike(), 0);
    m.recordStrike(foulStrike(), 10);
    m.recordStrike(foulStrike(), 20);
    const r = m.report(30, baseReport({}));
    expect(r.strike!.resolved).toBe(3);
    expect(r.strike!.fouls).toBe(2);
  });

  it("reports time since the last strike, and null before the first", () => {
    const m = new SystemMonitor();
    expect(m.report(500, baseReport({})).strike).toBeNull();

    m.recordStrike(legalStrike(), 1000);
    expect(m.report(1000, baseReport({})).strike!.sinceLastMs).toBe(0);
    expect(m.report(1400, baseReport({})).strike!.sinceLastMs).toBe(400);
  });

  it("tracks peak reach from sampled frames", () => {
    const m = new SystemMonitor();
    m.sampleReach({ left: 0.9, right: 0.2 }, 0);
    m.sampleReach({ left: 0.3, right: 0.95 }, 10);
    const r = m.report(10, baseReport({}));
    expect(r.strike!.peakReach).toBeCloseTo(0.95, 6);
  });

  it("does not treat reach below the near-miss threshold as a near miss", () => {
    const m = new SystemMonitor();
    m.sampleReach({ left: 0.5, right: 0.4 }, 0);
    const r = m.report(0, baseReport({}));
    // The section exists — sampling at all means the resolver is running —
    // but nothing crossed nearMissReach, so the count is zero.
    expect(r.strike!.nearMisses).toBe(0);
  });

  it("flags a stack of near misses with nothing landed", () => {
    const m = new SystemMonitor();
    for (let i = 0; i < SYSTEM_CONFIG.nearMissAdviceCount; i++) {
      m.sampleReach({ left: 0.95, right: 0 }, i * 100);
    }
    const r = m.report(1000, baseReport({}));
    expect(r.advice.some((a) => /reach calibration/i.test(a))).toBe(true);
  });

  it("does not flag near misses once a strike actually lands", () => {
    const m = new SystemMonitor();
    for (let i = 0; i < SYSTEM_CONFIG.nearMissAdviceCount; i++) {
      m.sampleReach({ left: 0.95, right: 0 }, i * 100);
    }
    m.recordStrike(legalStrike(), 900);
    const r = m.report(1000, baseReport({}));
    expect(r.advice.some((a) => /reach calibration/i.test(a))).toBe(false);
  });

  it("a handful of near misses alone is not advice-worthy", () => {
    const m = new SystemMonitor();
    m.sampleReach({ left: 0.9, right: 0 }, 0);
    m.sampleReach({ left: 0.9, right: 0 }, 100);
    const r = m.report(200, baseReport({}));
    expect(r.advice.some((a) => /reach calibration/i.test(a))).toBe(false);
  });

  it("resets cleanly", () => {
    const m = new SystemMonitor();
    m.recordStrike(legalStrike(), 0);
    m.sampleReach({ left: 1, right: 1 }, 0);
    m.reset();
    const r = m.report(0, baseReport({}));
    expect(r.strike).toBeNull();
  });
});

describe("the overall score", () => {
  it("is the minimum of the PRESENT scored sections", () => {
    const m = new SystemMonitor();
    const tracking = {
      score: 0.9,
      advice: [],
      samples: 90,
      metrics: [{ name: "rate", value: 25, score: 0.9 }],
    } as unknown as TrackingReport;
    const r = m.report(
      0,
      baseReport({ tracking, frameInterval: stats({ median: 1000 / 5 }) })
    );
    expect(r.score).toBe(r.frame!.score);
    expect(r.score).toBeLessThan(tracking.score);
  });

  it("does not let drill or strike activity pull the score down", () => {
    // Neither section produces a score at all — a burst of strikes or a drill
    // in progress is not "unhealthy" at any pace.
    const m = new SystemMonitor();
    m.recordStrike(legalStrike(), 0);
    const r = m.report(
      0,
      baseReport({ frameInterval: stats({ median: 1000 / SYSTEM_CONFIG.goodFrameHz }) })
    );
    expect(r.score).toBe(1);
  });

  it("is null when nothing scored has appeared yet", () => {
    const m = new SystemMonitor();
    m.recordStrike(legalStrike(), 0);
    const r = m.report(0, baseReport({}));
    expect(r.strike).not.toBeNull();
    expect(r.score).toBeNull();
  });
});

describe("an unmeasured tracking report is not a failing one", () => {
  // Caught by the smoke run: headless has a camera but no person in it, and
  // the panel showed "Pose 0 · 0.0 Hz" — a real 0, not a placeholder — the
  // instant any pose frame arrived, well before the tracking monitor had
  // enough samples to say anything. TrackingReport's own empty placeholder
  // has score 0 because a min() over nothing naturally produces zero, not
  // because the signal is bad.
  const unmeasured = {
    samples: 3,
    hz: 0,
    jitter: 0,
    dropout: 0,
    limbVariance: 0,
    worstLandmark: null,
    score: 0,
    metrics: [],
    advice: [],
  } as TrackingReport;

  it("does not drag the overall score to zero", () => {
    const m = new SystemMonitor();
    const r = m.report(
      0,
      baseReport({
        tracking: unmeasured,
        frameInterval: stats({ median: 1000 / SYSTEM_CONFIG.goodFrameHz }),
      })
    );
    expect(r.score).toBe(1);
  });

  it("contributes no advice", () => {
    const measuredButQuiet = { ...unmeasured, advice: ["should not appear"] };
    const m = new SystemMonitor();
    const r = m.report(0, baseReport({ tracking: measuredButQuiet }));
    expect(r.advice).not.toContain("should not appear");
  });

  it("still passes the raw report through, for a panel that wants to show its own idle state", () => {
    const m = new SystemMonitor();
    const r = m.report(0, baseReport({ tracking: unmeasured }));
    expect(r.tracking).toBe(unmeasured);
  });

  it("a report that HAS cleared the sample bar contributes normally", () => {
    const measured = {
      ...unmeasured,
      samples: 90,
      score: 0.3,
      metrics: [{ name: "rate", value: 10, score: 0.3 }],
    };
    const m = new SystemMonitor();
    const r = m.report(
      0,
      baseReport({
        tracking: measured,
        frameInterval: stats({ median: 1000 / SYSTEM_CONFIG.goodFrameHz }),
      })
    );
    expect(r.score).toBe(0.3);
  });
});

describe("passthrough sections", () => {
  it("carries the tracking report and drill stats through unchanged", () => {
    const m = new SystemMonitor();
    const tracking = {
      score: 0.7,
      advice: ["dim room"],
      samples: 90,
      metrics: [{ name: "rate", value: 20, score: 0.7 }],
    } as unknown as TrackingReport;
    const drill = { presented: 4, landed: 3 } as DrillStats;
    const r = m.report(0, baseReport({ tracking, drill }));
    expect(r.tracking).toBe(tracking);
    expect(r.drill).toBe(drill);
    expect(r.advice).toContain("dim room");
  });
});
