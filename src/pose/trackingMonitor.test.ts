import { describe, it, expect } from "vitest";
import { TrackingMonitor } from "./trackingMonitor";
import { MONITOR_CONFIG } from "../config/tuning";
import { POSE_KEYS, type PoseFrame, type PoseKey } from "./poseTypes";

// The monitor is only worth having if it can tell a healthy signal from a sick
// one, so every test here builds a stream with one known defect and checks it
// is the defect that gets named.

const HZ = 15;
const DT = 1000 / HZ;

/** A plausible resting pose. Shoulders 0.16 apart, hips 0.30 below them, so
 *  the torso scale is a round-ish 0.30 and the numbers below read easily. */
const BASE: Record<PoseKey, { x: number; y: number }> = {
  leftShoulder: { x: 0.58, y: 0.40 },
  rightShoulder: { x: 0.42, y: 0.40 },
  leftElbow: { x: 0.62, y: 0.52 },
  rightElbow: { x: 0.38, y: 0.52 },
  leftWrist: { x: 0.60, y: 0.62 },
  rightWrist: { x: 0.40, y: 0.62 },
  leftHip: { x: 0.55, y: 0.70 },
  rightHip: { x: 0.45, y: 0.70 },
  nose: { x: 0.50, y: 0.30 },
  leftEye: { x: 0.52, y: 0.28 },
  rightEye: { x: 0.48, y: 0.28 },
  leftEar: { x: 0.55, y: 0.29 },
  rightEar: { x: 0.45, y: 0.29 },
};

interface StreamOptions {
  frames?: number;
  hz?: number;
  /** Gaussian-ish positional noise, in normalized image units. */
  noise?: number;
  /** Keys to mark unusable, and how often. */
  drop?: { keys: PoseKey[]; rate: number };
  /** Stretches the forearm over time, simulating a breathing skeleton. */
  limbDrift?: number;
  /** Moves the whole body across frame - should not read as jitter. */
  travel?: number;
}

function stream(options: StreamOptions = {}): PoseFrame[] {
  const {
    frames = 60,
    hz = HZ,
    noise = 0,
    drop,
    limbDrift = 0,
    travel = 0,
  } = options;
  // Deterministic pseudo-noise: a seeded LCG, so a failure is reproducible.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  const out: PoseFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const frame: Partial<PoseFrame> & { timestamp: number } = {
      timestamp: i * (1000 / hz),
    };
    const shift = travel * i;
    for (const key of POSE_KEYS) {
      const base = BASE[key];
      let { x, y } = base;
      x += shift;
      if (limbDrift && (key === "leftWrist" || key === "rightWrist")) {
        y += limbDrift * Math.sin((i / frames) * Math.PI * 2);
      }
      if (noise) {
        x += rand() * noise;
        y += rand() * noise;
      }
      const dropped =
        drop && drop.keys.includes(key) && i % Math.round(1 / drop.rate) === 0;
      frame[key] = { x, y, z: 0, confidence: dropped ? 0.1 : 0.95 };
    }
    out.push(frame as PoseFrame);
  }
  return out;
}

function run(frames: PoseFrame[]): TrackingMonitor {
  const m = new TrackingMonitor();
  for (const f of frames) m.ingest(f);
  return m;
}

describe("tracking monitor", () => {
  it("says nothing useful until it has enough samples", () => {
    const m = run(stream({ frames: MONITOR_CONFIG.minSamples - 1 }));
    const r = m.report();
    expect(r.score).toBe(0);
    expect(r.advice).toContain("not enough samples yet");
    // And it must not tune on no evidence.
    expect(m.tuning(r)).toEqual({ smoothingScale: 1, predictScale: 1 });
  });

  it("scores a clean stream highly and offers no advice", () => {
    const r = run(stream({ hz: 30 })).report();
    expect(r.dropout).toBe(0);
    expect(r.jitter).toBeLessThan(MONITOR_CONFIG.goodJitter);
    expect(r.score).toBeGreaterThan(0.9);
    expect(r.advice).toEqual([]);
  });

  it("marks down this project's REAL pose rate, and says why", () => {
    // 15 Hz is what the app actually delivers (risk log 12: the ~15.1 FPS
    // requestVideoFrameCallback quantisation, against a ~27.8 Hz ceiling set
    // by inference time). Everything else about the stream is perfect, so this
    // pins the monitor's headline judgement to the project's real bottleneck
    // rather than to a synthetic ideal.
    const r = run(stream({ hz: 15 })).report();
    expect(r.dropout).toBe(0);
    expect(r.metrics.find((m) => m.name === "jitter")!.score).toBe(1);
    // Rate alone drags the overall score down, because scoring takes the
    // minimum.
    expect(r.metrics.find((m) => m.name === "rate")!.score).toBeCloseTo(
      (15 - MONITOR_CONFIG.badHz) /
        (MONITOR_CONFIG.goodHz - MONITOR_CONFIG.badHz),
      3
    );
    expect(r.score).toBeLessThan(0.5);
    expect(r.advice.join(" ")).toMatch(/pose rate/);
  });

  it("measures the delivered pose rate", () => {
    expect(run(stream({ hz: 15 })).report().hz).toBeCloseTo(15, 0);
    expect(run(stream({ hz: 30 })).report().hz).toBeCloseTo(30, 0);
  });

  it("flags a slow pose rate", () => {
    const r = run(stream({ hz: 6 })).report();
    expect(r.metrics.find((m) => m.name === "rate")!.score).toBeLessThan(0.5);
    expect(r.advice.join(" ")).toMatch(/pose rate/);
  });

  it("does NOT mistake body travel for jitter", () => {
    // The whole point of measuring a second difference against a
    // shoulder-relative origin. A player walking across frame moves every
    // landmark a long way, and none of it is noise.
    const still = run(stream({ hz: 30 })).report();
    const moving = run(stream({ hz: 30, travel: 0.004 })).report();
    expect(moving.jitter).toBeCloseTo(still.jitter, 3);
    expect(moving.advice).toEqual([]);
  });

  it("detects jitter and filters harder in response", () => {
    const clean = run(stream());
    const noisy = run(stream({ noise: 0.03 }));
    expect(noisy.report().jitter).toBeGreaterThan(clean.report().jitter * 3);
    expect(noisy.report().advice.join(" ")).toMatch(/jitter/);
    expect(noisy.tuning().smoothingScale).toBeGreaterThan(
      clean.tuning().smoothingScale
    );
  });

  it("names the WORST landmark, not just an overall figure", () => {
    // "12% dropout" hides "the right wrist is invisible half the time".
    const r = run(stream({ drop: { keys: ["rightWrist"], rate: 0.5 } })).report();
    expect(r.worstLandmark?.key).toBe("rightWrist");
    expect(r.worstLandmark!.dropout).toBeGreaterThan(0.4);
  });

  it("pulls prediction in when the signal is gappy", () => {
    const clean = run(stream());
    const gappy = run(
      stream({ drop: { keys: ["leftWrist", "rightWrist", "leftElbow"], rate: 0.5 } })
    );
    expect(gappy.report().dropout).toBeGreaterThan(MONITOR_CONFIG.badDropout * 0.5);
    expect(gappy.tuning().predictScale).toBeLessThan(
      clean.tuning().predictScale
    );
  });

  it("notices a breathing skeleton", () => {
    const steady = run(stream()).report();
    const drifting = run(stream({ limbDrift: 0.06 })).report();
    expect(drifting.limbVariance).toBeGreaterThan(steady.limbVariance);
    expect(drifting.advice.join(" ")).toMatch(/limb lengths/);
  });

  it("scores by the WEAKEST metric, not the average", () => {
    // Three healthy signals must not be allowed to hide one dead limb.
    const r = run(stream({ drop: { keys: POSE_KEYS.slice(), rate: 1 } })).report();
    expect(r.dropout).toBe(1);
    expect(r.score).toBe(0);
  });

  it("keeps the auto-tuner inside its bounds, whatever it is fed", () => {
    // It runs unattended. Its worst case must be "a bit soft" or "a bit
    // laggy", never "broken".
    for (const opts of [
      {},
      { noise: 0.5 },
      { noise: 1e-9 },
      { drop: { keys: POSE_KEYS.slice(), rate: 1 } },
      { hz: 1 },
      { limbDrift: 0.5 },
    ] as StreamOptions[]) {
      const t = run(stream(opts)).tuning();
      expect(t.smoothingScale).toBeGreaterThanOrEqual(
        MONITOR_CONFIG.minSmoothingScale
      );
      expect(t.smoothingScale).toBeLessThanOrEqual(
        MONITOR_CONFIG.maxSmoothingScale
      );
      expect(t.predictScale).toBeGreaterThanOrEqual(
        MONITOR_CONFIG.minPredictScale
      );
      expect(t.predictScale).toBeLessThanOrEqual(MONITOR_CONFIG.maxPredictScale);
    }
  });

  it("exposes ONLY smoothing and prediction - never a hit threshold", () => {
    // The architectural line. A monitor that could relax `reachThreshold`
    // because the lighting got worse would mean the game rewards a bad webcam,
    // and it would do it invisibly. Asserted structurally so adding a third
    // knob has to be a deliberate act that breaks this test.
    const keys = Object.keys(run(stream()).tuning()).sort();
    expect(keys).toEqual(["predictScale", "smoothingScale"]);
  });

  it("forgets old conditions, so a fixed problem stops being reported", () => {
    const m = new TrackingMonitor();
    for (const f of stream({
      noise: 0.05,
      hz: 30,
      frames: MONITOR_CONFIG.windowFrames,
    }))
      m.ingest(f);
    expect(m.report().advice.join(" ")).toMatch(/jitter/);

    // The light comes back on. The window must roll over rather than hold a
    // grudge, or the tuner stays clamped long after the cause is gone.
    const t0 = MONITOR_CONFIG.windowFrames * DT;
    for (const f of stream({ frames: MONITOR_CONFIG.windowFrames, hz: 30 })) {
      m.ingest({ ...f, timestamp: t0 + f.timestamp });
    }
    expect(m.report().advice).toEqual([]);
  });

  it("resets cleanly", () => {
    const m = run(stream({ noise: 0.05 }));
    expect(m.samples).toBeGreaterThan(0);
    m.reset();
    expect(m.samples).toBe(0);
    expect(m.report().advice).toContain("not enough samples yet");
  });
});
