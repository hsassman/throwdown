import { describe, it, expect } from "vitest";
import { PoseSmoother } from "./smoothing";
import { PosePredictor } from "./predictor";
import { TrackingMonitor } from "./trackingMonitor";
import { MONITOR_CONFIG } from "../config/tuning";
import { POSE_KEYS, type PoseFrame, type PoseKey } from "./poseTypes";

// The loop that makes the tracking monitor do something.
//
// Until these knobs existed the monitor was a thermometer with nothing
// attached: it measured the signal every frame, computed a correction, and
// nothing read it. These tests cover the two things it is allowed to move, and
// - just as importantly - that it still cannot move anything else.

const BASE: Record<PoseKey, { x: number; y: number }> = {
  leftShoulder: { x: 0.58, y: 0.4 },
  rightShoulder: { x: 0.42, y: 0.4 },
  leftElbow: { x: 0.62, y: 0.52 },
  rightElbow: { x: 0.38, y: 0.52 },
  leftWrist: { x: 0.6, y: 0.62 },
  rightWrist: { x: 0.4, y: 0.62 },
  leftHip: { x: 0.55, y: 0.7 },
  rightHip: { x: 0.45, y: 0.7 },
  nose: { x: 0.5, y: 0.3 },
  leftEye: { x: 0.52, y: 0.28 },
  rightEye: { x: 0.48, y: 0.28 },
  leftEar: { x: 0.55, y: 0.29 },
  rightEar: { x: 0.45, y: 0.29 },
};

function frame(t: number, wristX = BASE.leftWrist.x): PoseFrame {
  const f: Record<string, unknown> = { timestamp: t };
  for (const k of POSE_KEYS) {
    const b = BASE[k];
    f[k] = {
      x: k === "leftWrist" ? wristX : b.x,
      y: b.y,
      z: 0,
      confidence: 0.95,
    };
  }
  return f as unknown as PoseFrame;
}

/** Runs a step input through a smoother and returns how far it travelled. */
function stepResponse(scale: number): number {
  const s = new PoseSmoother();
  s.setScale(scale);
  let t = 0;
  // Settle on the resting position first.
  for (let i = 0; i < 20; i++, t += 33) s.smooth(frame(t));
  // Then jump the wrist and see how much of the jump survives one sample.
  const out = s.smooth(frame(t, BASE.leftWrist.x + 0.2));
  return out.leftWrist.x - BASE.leftWrist.x;
}

describe("smoothing scale", () => {
  it("defaults to no change", () => {
    expect(new PoseSmoother().smoothingScale).toBe(1);
  });

  it("filters HARDER as the scale rises, not softer", () => {
    // The direction is the whole point and it is easy to get backwards: a One
    // Euro cutoff is a frequency, so more smoothing means a lower number. A
    // scale that multiplied the cutoff would have made a noisy signal twitchier
    // - the exact opposite of what the monitor asked for, and it would have
    // looked like the auto-tuner making things worse.
    const soft = stepResponse(1);
    const hard = stepResponse(2.5);
    expect(hard).toBeLessThan(soft);
    expect(hard).toBeGreaterThan(0);
  });

  it("is more responsive below 1", () => {
    expect(stepResponse(0.7)).toBeGreaterThan(stepResponse(1));
  });

  it("retunes in place instead of restarting the filters", () => {
    // Rebuilding a filter discards its history and restarts it from the next
    // sample - a visible jump on every landmark, every time the auto-tuner
    // nudged anything.
    const s = new PoseSmoother();
    let t = 0;
    for (let i = 0; i < 20; i++, t += 33) s.smooth(frame(t));
    const before = s.smooth(frame(t)).leftWrist.x;
    s.setScale(2.2);
    t += 33;
    const after = s.smooth(frame(t)).leftWrist.x;
    // A restart would snap straight to the raw input.
    expect(Math.abs(after - before)).toBeLessThan(0.01);
  });

  it("ignores a nonsensical scale rather than dividing by zero", () => {
    const s = new PoseSmoother();
    s.setScale(0);
    s.setScale(-3);
    s.setScale(Number.NaN);
    expect(s.smoothingScale).toBe(1);
    expect(Number.isFinite(s.smooth(frame(0)).leftWrist.x)).toBe(true);
  });
});

describe("prediction scale", () => {
  /** Feeds a steadily moving wrist and returns the lead actually applied. */
  function leadFor(scale: number): number {
    const p = new PosePredictor();
    p.setScale(scale);
    let t = 0;
    for (let i = 0; i < 20; i++, t += 33) {
      p.ingest(frame(t, BASE.leftWrist.x + i * 0.004));
    }
    // Ask for a prediction well after the last sample, so latency is real.
    p.predictAt(t + 120);
    return p.debug.leadMs;
  }

  it("defaults to no change", () => {
    expect(new PosePredictor().predictScale).toBe(1);
  });

  it("leads less as the scale falls", () => {
    const full = leadFor(1);
    const half = leadFor(0.5);
    expect(full).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it("stops predicting entirely at zero", () => {
    // What the monitor asks for when the signal is full of holes: a velocity
    // estimate built from a gappy stream is mostly noise, and leading on noise
    // flings landmarks around far more visibly than the latency it corrects.
    expect(leadFor(0)).toBe(0);
  });

  it("ignores a negative scale", () => {
    const p = new PosePredictor();
    p.setScale(-1);
    expect(p.predictScale).toBe(1);
  });
});

describe("what the loop is allowed to touch", () => {
  it("still exposes ONLY smoothing and prediction", () => {
    // The architectural line, re-asserted at the point of use rather than only
    // where the values are produced. Now that something consumes the tuning,
    // a third knob would actually reach the pipeline.
    const m = new TrackingMonitor();
    const keys = Object.keys(m.tuning()).sort();
    expect(keys).toEqual(["predictScale", "smoothingScale"]);
  });

  it("hands the pipeline values it will accept", () => {
    // The monitor clamps; the setters reject nonsense. Neither should ever
    // have to rescue the other, so this checks they agree.
    const m = new TrackingMonitor();
    let t = 0;
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < MONITOR_CONFIG.windowFrames; i++, t += 33) {
      const f = frame(t, BASE.leftWrist.x + rand() * 0.08);
      m.ingest(f);
    }
    const tuning = m.tuning();
    const s = new PoseSmoother();
    s.setScale(tuning.smoothingScale);
    expect(s.smoothingScale).toBe(tuning.smoothingScale);

    const p = new PosePredictor();
    p.setScale(tuning.predictScale);
    expect(p.predictScale).toBe(tuning.predictScale);
  });
});
