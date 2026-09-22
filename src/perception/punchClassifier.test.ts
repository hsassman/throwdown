import { describe, expect, it } from "vitest";
import { PunchClassifier } from "./punchClassifier";
import { syntheticIdle, syntheticPunch, SYNTHETIC_TORSO_SCALE } from "./synthetic";
import { TEST_CALIBRATION as CAL } from "./testCalibration";
import { angleDeg } from "./geometry";
import { torsoScaleOf } from "../pose/poseTypes";
import type { PunchEvent } from "./punchTypes";
import { PERCEPTION_CONFIG } from "../config/tuning";

// These tests check the perception layer's plumbing against idealised motion.
// They deliberately do not claim anything about real-world accuracy - see the
// header of synthetic.ts for why that distinction matters here.


function run(frames: ReturnType<typeof syntheticPunch>): PunchEvent[] {
  const c = new PunchClassifier();
  const events: PunchEvent[] = [];
  for (const f of frames) {
    events.push(...c.update(f, CAL, f.timestamp));
  }
  return events;
}

describe("geometry", () => {
  it("measures a straight arm as ~180 degrees", () => {
    expect(angleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 })).toBeCloseTo(180, 1);
  });

  it("measures a right-angled bend as ~90 degrees", () => {
    expect(angleDeg({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(90, 1);
  });
});

describe("torso scale", () => {
  it("prefers shoulder-hip distance when hips are visible", () => {
    const [frame] = syntheticPunch("straight", { hand: "left", frames: 2 });
    const s = torsoScaleOf(frame, 0.5);
    expect(s?.source).toBe("shoulder-hip");
    expect(s?.value).toBeCloseTo(SYNTHETIC_TORSO_SCALE, 3);
  });

  it("falls back to shoulder width when hips are not tracked", () => {
    const [frame] = syntheticPunch("straight", { hand: "left", frames: 2 });
    const noHips = {
      ...frame,
      leftHip: { ...frame.leftHip, confidence: 0 },
      rightHip: { ...frame.rightHip, confidence: 0 },
    };
    const s = torsoScaleOf(noHips, 0.5);
    expect(s?.source).toBe("shoulder-width");
    expect(s?.value).toBeGreaterThan(0);
  });
});

describe("punch detection", () => {
  it("detects exactly one punch per thrown punch", () => {
    const events = run(syntheticPunch("straight", { hand: "left" }));
    expect(events).toHaveLength(1);
  });

  it("does not fire while the player just holds guard", () => {
    const c = new PunchClassifier();
    const events: PunchEvent[] = [];
    for (const f of syntheticIdle(120)) {
      events.push(...c.update(f, CAL, f.timestamp));
    }
    expect(events).toHaveLength(0);
  });

  it("attributes the punch to the hand that actually moved", () => {
    expect(run(syntheticPunch("straight", { hand: "left" }))[0].hand).toBe("left");
    expect(run(syntheticPunch("straight", { hand: "right" }))[0].hand).toBe("right");
  });

  it("maps hand to lead/rear using the calibrated stance", () => {
    // Orthodox: left leads, so a left straight is a jab and a right a cross.
    expect(run(syntheticPunch("straight", { hand: "left" }))[0].type).toBe("jab");
    expect(run(syntheticPunch("straight", { hand: "right" }))[0].type).toBe("cross");
  });
});

describe("feature signs", () => {
  // A sign error here would invert a whole class and is the single most likely
  // way to waste a real measurement session, so it is asserted directly rather
  // than inferred from the resulting label.
  it("reports inward travel as positive for a hook with either hand", () => {
    for (const hand of ["left", "right"] as const) {
      const e = run(syntheticPunch("hook", { hand }))[0];
      expect(e, `${hand} hook produced no event`).toBeDefined();
      expect(e.features.inwardTravel).toBeGreaterThan(0);
    }
  });

  it("reports upward travel as positive for an uppercut with either hand", () => {
    for (const hand of ["left", "right"] as const) {
      const e = run(syntheticPunch("uppercut", { hand }))[0];
      expect(e, `${hand} uppercut produced no event`).toBeDefined();
      expect(e.features.upwardTravel).toBeGreaterThan(0);
    }
  });

  it("reports an uppercut as dropping below the shoulder line to chamber", () => {
    const e = run(syntheticPunch("uppercut", { hand: "right" }))[0];
    expect(e, "uppercut produced no event").toBeDefined();
    expect(e.features.lowestHeight).toBeLessThan(0);
  });

  it("reports a straight punch as NOT dropping as low as an uppercut", () => {
    const straight = run(syntheticPunch("straight", { hand: "left" }))[0];
    const uppercut = run(syntheticPunch("uppercut", { hand: "left" }))[0];
    expect(uppercut.features.lowestHeight).toBeLessThan(
      straight.features.lowestHeight
    );
  });

  it("reports a straight punch as less curved than a hook", () => {
    const straight = run(syntheticPunch("straight", { hand: "left" }))[0];
    const hook = run(syntheticPunch("hook", { hand: "left" }))[0];
    expect(hook.features.curvature).toBeGreaterThan(straight.features.curvature);
  });

  it("reports the elbow opening over the punch", () => {
    const e = run(syntheticPunch("straight", { hand: "left" }))[0];
    expect(e.features.elbowAnglePeak).toBeGreaterThan(e.features.elbowAngleStart);
  });
});

describe("classification of idealised motion", () => {
  // If these fail, Approach a has a bug. If these pass but a real measured run
  // fails, that is the documented frontal-camera limitation rather than a
  // defect - the distinction this whole file exists to make.
  it("classifies an unambiguous hook as a hook", () => {
    for (const hand of ["left", "right"] as const) {
      expect(run(syntheticPunch("hook", { hand }))[0].type).toBe("hook");
    }
  });

  it("classifies an unambiguous uppercut as an uppercut", () => {
    for (const hand of ["left", "right"] as const) {
      expect(run(syntheticPunch("uppercut", { hand }))[0].type).toBe("uppercut");
    }
  });

  it("classifies an unambiguous straight punch as straight-family", () => {
    for (const hand of ["left", "right"] as const) {
      expect(run(syntheticPunch("straight", { hand }))[0].family).toBe("straight");
    }
  });
});

describe("detection robustness", () => {
  // The episode-based design finalises when the fist returns to guard, so the
  // obvious risks are merging consecutive punches and never finalising at all.

  it("counts two consecutive punches as two events", () => {
    const c = new PunchClassifier();
    const events: PunchEvent[] = [];
    let t = 0;
    for (let rep = 0; rep < 2; rep++) {
      for (const f of syntheticPunch("straightForeshortened", { hand: "left" })) {
        // Re-base timestamps so the second punch follows the first.
        const shifted = { ...f, timestamp: f.timestamp + t };
        events.push(...c.update(shifted, CAL, shifted.timestamp));
      }
      t += 2000;
    }
    expect(events).toHaveLength(2);
  });

  it("does not emit while the hand stays extended and never returns", () => {
    const c = new PunchClassifier();
    const frames = syntheticPunch("straight", { hand: "left" });
    // Feed only the outward half, then hold the final frame indefinitely.
    const outward = frames.slice(0, Math.floor(frames.length / 2));
    const events: PunchEvent[] = [];
    for (const f of outward) events.push(...c.update(f, CAL, f.timestamp));

    const last = outward[outward.length - 1];
    for (let i = 1; i <= 60; i++) {
      const held = { ...last, timestamp: last.timestamp + i * 33 };
      events.push(...c.update(held, CAL, held.timestamp));
    }
    expect(events).toHaveLength(0);
  });

  it("rejects a slow reach rather than calling it a punch", () => {
    // Same path, but taken far too slowly to be a punch.
    const c = new PunchClassifier();
    const events: PunchEvent[] = [];
    for (const f of syntheticPunch("straight", {
      hand: "left",
      frames: 30,
      frameIntervalMs: 40,
    })) {
      events.push(...c.update(f, CAL, f.timestamp));
    }
    expect(events).toHaveLength(0);
  });

  it("tolerates a dropped-tracking frame mid-punch without emitting garbage", () => {
    const c = new PunchClassifier();
    const frames = syntheticPunch("hook", { hand: "left" });
    const events: PunchEvent[] = [];
    frames.forEach((f, i) => {
      const dropped =
        i === Math.floor(frames.length / 2)
          ? { ...f, leftWrist: { ...f.leftWrist, confidence: 0 } }
          : f;
      events.push(...c.update(dropped, CAL, dropped.timestamp));
    });
    // Either it recovers and reports a punch, or it discards it - but it must
    // never report one built from a trajectory with a hole in it.
    for (const e of events) {
      expect(e.features.sampleCount).toBeGreaterThanOrEqual(
        PERCEPTION_CONFIG.minPunchSamples
      );
    }
  });

  it("scales thresholds with measured guard jitter", () => {
    // A player whose guard wanders should need a bigger motion to register,
    // otherwise their jitter reads as a stream of phantom punches.
    const jittery = {
      ...CAL,
      guardJitter: { left: 0.2, right: 0.2 },
    };
    const c = new PunchClassifier();
    const events: PunchEvent[] = [];
    for (const f of syntheticPunch("straightForeshortened", { hand: "left" })) {
      events.push(...c.update(f, jittery, f.timestamp));
    }
    // 0.2 * 3 = 0.6 required, well above this punch's ~0.17 excursion.
    expect(events).toHaveLength(0);
  });
});
