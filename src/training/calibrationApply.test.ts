import { describe, it, expect } from "vitest";
import { applyCalibration } from "./useDummyTraining";
import { makeStrike } from "./testStrike";
import { ZONE_BY_ID } from "./hitZones";

// `applyCalibration` is the single point where the adaptation loop changes a
// measurement, so it gets its own tests rather than being covered incidentally.

const CHIN = ZONE_BY_ID.get("chin")!;

describe("applying the learned calibration", () => {
  it("returns the strike untouched when there is nothing to correct", () => {
    const s = makeStrike({ impact: CHIN.centre });
    // Identity, not a copy - a new object every punch would defeat any
    // downstream memoisation for no benefit.
    expect(applyCalibration(s, { lateral: 0, height: 0 })).toBe(s);
  });

  it("shifts the landing point by the correction", () => {
    const s = makeStrike({ impact: { lateral: 0, height: 1.0 } });
    const out = applyCalibration(s, { lateral: 0.05, height: 0.2 });
    expect(out.impact.lateral).toBeCloseTo(0.05, 10);
    expect(out.impact.height).toBeCloseTo(1.2, 10);
  });

  it("RE-RESOLVES the region, so position and damage never disagree", () => {
    // The bug this exists to prevent: a correction that moves an impact from
    // the throat up to the chin while still reporting "throat" would show the
    // player a chin shot worth a throat shot's damage.
    const s = makeStrike({ impact: { lateral: 0, height: 1.05 }, power: 1 });
    expect(s.region.id).toBe("throat");
    const out = applyCalibration(s, { lateral: 0, height: 0.16 });
    expect(out.region.id).toBe("chin");
    expect(out.damage).toBeCloseTo(out.region.damage * out.power, 10);
    expect(out.damage).not.toBeCloseTo(s.damage, 3);
  });

  it("zeroes damage if the correction pushes a punch below the belt", () => {
    const s = makeStrike({ impact: { lateral: 0, height: 0.3 }, power: 1 });
    const out = applyCalibration(s, { lateral: 0, height: -0.2 });
    expect(out.region.legal).toBe(false);
    expect(out.damage).toBe(0);
  });

  it("leaves the hand, timing and speed alone", () => {
    // The correction is a coordinate fix. It has no business touching anything
    // that was measured rather than positioned.
    const s = makeStrike({
      impact: CHIN.centre,
      hand: "right",
      timestamp: 1234,
      speed: 4.5,
      power: 0.7,
    });
    const out = applyCalibration(s, { lateral: 0.1, height: 0.1 });
    expect(out.hand).toBe("right");
    expect(out.timestamp).toBe(1234);
    expect(out.speed).toBe(4.5);
    expect(out.power).toBe(0.7);
  });
});
