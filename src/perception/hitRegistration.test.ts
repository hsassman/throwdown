import { describe, it, expect } from "vitest";
import { StrikeResolver, type StrikeEvent } from "./strikeResolver";
import { PoseSmoother } from "../pose/smoothing";
import { STRIKE_CONFIG, STRIKE_SMOOTHING } from "../config/tuning";
import type { Keypoint, PoseFrame } from "../pose/poseTypes";

// End-to-end hit registration: synthetic punches, with landmark noise, at the
// pose rates the game actually runs at, through the filter that really sits
// in front of the resolver.
//
// strikeResolver.test.ts checks the resolver's rules on clean input. This
// file checks the numbers those rules add up to - how many real punches
// register, and how many non-punches do not - because every one of the
// problems fixed alongside it passed the rule-level tests:
//
// - The display filter lagged straight punches thrown down the lens so badly
//   that none of them registered.
// - The speed gate read on-screen speed only, which a straight barely has.
// - Speed from two consecutive samples was dominated by jitter.
// - Power depended on where in the punch the camera happened to sample.
//
// Same caveat as perception/synthetic.ts: these are idealised motions. They
// prove the pipeline does not throw away punches a clean signal contains; they
// say nothing about how clean the real signal is.

/** Seeded, so a failure reproduces. */
function makeNoise(seed: number) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

type Arm = { elbow: [number, number]; wrist: [number, number] };
// Same layout as strikeResolver.test.ts: torso 0.34, right arm throwing.
const GUARD: Arm = { elbow: [0.4, 0.56], wrist: [0.47, 0.37] };
const STRAIGHT: Arm = { elbow: [0.41, 0.44], wrist: [0.4, 0.42] };
const HOOK: Arm = { elbow: [0.24, 0.4], wrist: [0.1, 0.44] };
/** A guard adjustment: partway forward, not a punch. */
const ADJUST: Arm = { elbow: [0.405, 0.5], wrist: [0.43, 0.39] };

const lerp = (a: Arm, b: Arm, u: number): Arm => ({
  elbow: [a.elbow[0] + (b.elbow[0] - a.elbow[0]) * u, a.elbow[1] + (b.elbow[1] - a.elbow[1]) * u],
  wrist: [a.wrist[0] + (b.wrist[0] - a.wrist[0]) * u, a.wrist[1] + (b.wrist[1] - a.wrist[1]) * u],
});

function makePose(noise: () => number, sigma: number) {
  const kp = (x: number, y: number, s = sigma): Keypoint => ({
    x: x + noise() * s,
    y: y + noise() * s,
    confidence: 1,
  });
  return (arm: Arm, t: number, moving: boolean): PoseFrame => {
    // Landmarks jitter more in motion - blur, and the model's own uncertainty.
    const ws = moving ? sigma * 2 : sigma;
    return {
      timestamp: t,
      leftShoulder: kp(0.58, 0.38),
      rightShoulder: kp(0.42, 0.38),
      leftElbow: kp(0.63, 0.5),
      leftWrist: kp(0.63, 0.63),
      rightElbow: kp(arm.elbow[0], arm.elbow[1], ws),
      rightWrist: kp(arm.wrist[0], arm.wrist[1], ws),
      leftHip: kp(0.56, 0.72),
      rightHip: kp(0.44, 0.72),
      nose: kp(0.5, 0.22),
      leftEye: kp(0.53, 0.21),
      rightEye: kp(0.47, 0.21),
      leftEar: kp(0.56, 0.22),
      rightEar: kp(0.44, 0.22),
    };
  };
}

interface Motion {
  to: Arm;
  /** Outward travel, ms, eased; the return takes as long. */
  outMs: number;
  holdMs: number;
}

const PUNCHES: Record<string, Motion> = {
  "fast straight": { to: STRAIGHT, outMs: 90, holdMs: 40 },
  "slower straight": { to: STRAIGHT, outMs: 160, holdMs: 60 },
  hook: { to: HOOK, outMs: 120, holdMs: 40 },
};
const NOT_PUNCHES: Record<string, Motion> = {
  "slow reach forward": { to: STRAIGHT, outMs: 900, holdMs: 300 },
  "guard adjustment": { to: ADJUST, outMs: 150, holdMs: 100 },
  "still guard": { to: GUARD, outMs: 500, holdMs: 2000 },
};

type Filter = "strike" | "display" | "laggy";

/**
 * Runs `trials` repetitions of a motion, each at a different phase against
 * the sampling grid, and returns every strike that resolved.
 */
function trial(
  m: Motion,
  opts: { frameMs: number; sigma: number; filter: Filter; trials?: number; seed?: number }
): StrikeEvent[] {
  const trials = opts.trials ?? 24;
  const pose = makePose(makeNoise(opts.seed ?? 7), opts.sigma);
  const out: StrikeEvent[] = [];
  for (let k = 0; k < trials; k++) {
    const resolver = new StrikeResolver();
    const smoother =
      opts.filter === "strike"
        ? new PoseSmoother(STRIKE_SMOOTHING.minCutoff, STRIKE_SMOOTHING.beta, STRIKE_SMOOTHING.dCutoff)
        : opts.filter === "laggy"
          ? // The character filter's original Flap-era values: a heavy,
            // slow-to-open filter, standing in for any laggy or auto-tuned
            // smoother the strike path must never be routed through.
            new PoseSmoother(1.2, 0.02, 1.0)
          : new PoseSmoother();
    const feed = (f: PoseFrame) => out.push(...resolver.update(smoother.smooth(f)));

    // Settle at guard so segment lengths are learned.
    for (let i = 0; i < 30; i++) feed(pose(GUARD, i * opts.frameMs, false));
    const t0 = 30 * opts.frameMs;
    const phase = (k / trials) * opts.frameMs;
    const end = m.outMs * 2 + m.holdMs + 400;
    for (let t = phase; t < end; t += opts.frameMs) {
      const u =
        t < m.outMs
          ? t / m.outMs
          : t < m.outMs + m.holdMs
            ? 1
            : t < 2 * m.outMs + m.holdMs
              ? 2 - (t - m.holdMs) / m.outMs
              : 0;
      feed(pose(lerp(GUARD, m.to, Math.sin((u * Math.PI) / 2)), t0 + t, u > 0 && u < 1));
    }
  }
  return out;
}

const RATES = [
  { name: "19 FPS", frameMs: 53 },
  { name: "30 FPS", frameMs: 33 },
];
const NOISE = [
  { name: "steady light", sigma: 0.003 },
  { name: "poor light", sigma: 0.006 },
];

describe("hit registration", () => {
  for (const rate of RATES) {
    for (const noise of NOISE) {
      describe(`${rate.name}, ${noise.name}`, () => {
        for (const [name, m] of Object.entries(PUNCHES)) {
          it(`registers nearly every ${name}`, () => {
            const trials = 24;
            const hits = trial(m, { ...rate, sigma: noise.sigma, filter: "strike", trials });
            expect(hits.length).toBeGreaterThanOrEqual(Math.floor(trials * 0.9));
          });
        }
        for (const [name, m] of Object.entries(NOT_PUNCHES)) {
          it(`does not strike from a ${name}`, () => {
            const hits = trial(m, { ...rate, sigma: noise.sigma, filter: "strike" });
            // At most one in 24 - the poor-light runs sit right at the edge of
            // what a webcam produces, and zero there would be overfitting.
            expect(hits.length).toBeLessThanOrEqual(noise.sigma > 0.004 ? 1 : 0);
          });
        }
      });
    }
  }

  it("keeps the strike filter ahead of a laggy filter on straights", () => {
    // The regression this file exists for. If the strike path were ever routed
    // through a heavy or auto-tuned smoother, straights would stop registering.
    // This used to compare against the character (display) filter, back when
    // that filter was heavy; it has since been retuned to follow the player
    // (see SMOOTHING_DEFAULTS), so the heavy values are pinned here directly.
    const opts = { frameMs: 53, sigma: 0.003 };
    const m = PUNCHES["fast straight"];
    const viaStrike = trial(m, { ...opts, filter: "strike" }).length;
    const viaLaggy = trial(m, { ...opts, filter: "laggy" }).length;
    expect(viaLaggy).toBeLessThan(viaStrike / 2);
  });

  it("never registers fewer straights than the character filter would", () => {
    // Hits are resolved through STRIKE_SMOOTHING, not the character filter.
    // Whatever the character filter is tuned to, the strike path must not be
    // the slower of the two.
    const opts = { frameMs: 53, sigma: 0.003 };
    const m = PUNCHES["fast straight"];
    const viaStrike = trial(m, { ...opts, filter: "strike" }).length;
    const viaDisplay = trial(m, { ...opts, filter: "display" }).length;
    expect(viaStrike).toBeGreaterThanOrEqual(viaDisplay);
  });

  it("measures the same punch at the same power whatever the frame phase", () => {
    const powers = trial(PUNCHES.hook, { frameMs: 53, sigma: 0.003, filter: "strike" }).map(
      (e) => e.power
    );
    const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
    const sd = Math.sqrt(powers.reduce((a, b) => a + (b - mean) ** 2, 0) / powers.length);
    // Was 0.16 when power was read on the crossing frame.
    expect(sd).toBeLessThan(0.05);
  });
});

describe("strike timing and robustness", () => {
  const clean = makePose(() => 0, 0);
  const settle = (r: StrikeResolver, frameMs = 50) => {
    for (let i = 0; i < 20; i++) r.update(clean(GUARD, i * frameMs, false));
    return 20 * frameMs;
  };

  it("timestamps a strike at the interpolated crossing, not the later sample", () => {
    const r = new StrikeResolver();
    let t = settle(r);
    const events: StrikeEvent[] = [];
    let crossingSample = -1;
    for (let i = 1; i <= 6; i++) {
      t += 50;
      const before = r.debug.reach.right;
      events.push(...r.update(clean(lerp(GUARD, HOOK, i / 6), t, true)));
      if (crossingSample < 0 && before < 1 && r.debug.reach.right >= 1) crossingSample = t;
    }
    expect(events).toHaveLength(1);
    expect(crossingSample).toBeGreaterThan(0);
    expect(events[0].timestamp).toBeLessThanOrEqual(crossingSample);
    expect(events[0].timestamp).toBeGreaterThan(crossingSample - 50);
  });

  it("resolves at most one sample after the crossing", () => {
    const r = new StrikeResolver();
    let t = settle(r);
    const emittedAt: number[] = [];
    let crossedAt = -1;
    for (let i = 1; i <= 10; i++) {
      t += 50;
      // Still extending for the whole run, so only the latch bound can end it.
      const before = r.debug.reach.right;
      if (r.update(clean(lerp(GUARD, HOOK, i / 10), t, true)).length) emittedAt.push(t);
      if (crossedAt < 0 && before < 1 && r.debug.reach.right >= 1) crossedAt = t;
    }
    expect(emittedAt).toHaveLength(1);
    expect(emittedAt[0] - crossedAt).toBeLessThanOrEqual(50 * STRIKE_CONFIG.peakLatchSamples);
  });

  it("is not lengthened for good by one mis-tracked frame", () => {
    // One sample with the elbow snapped far out. Before, the learned length
    // took it at face value and never let go, so every later straight read as
    // barely foreshortened and stopped landing.
    const r = new StrikeResolver();
    let t = settle(r);
    const glitch = clean(GUARD, (t += 50), false);
    glitch.rightElbow = { x: 0.2, y: 0.75, confidence: 1 };
    r.update(glitch);
    for (let i = 0; i < 5; i++) r.update(clean(GUARD, (t += 50), false));

    const events: StrikeEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      events.push(...r.update(clean(lerp(GUARD, STRAIGHT, i / 3), (t += 50), true)));
    }
    for (let i = 0; i < 3; i++) events.push(...r.update(clean(STRAIGHT, (t += 50), false)));
    expect(events).toHaveLength(1);
  });

  it("still resolves a crossed strike when the arm is lost before its peak", () => {
    const r = new StrikeResolver();
    let t = settle(r);
    let events: StrikeEvent[] = [];
    for (let i = 1; i <= 6 && events.length === 0; i++) {
      t += 50;
      const before = r.debug.reach.right;
      events = r.update(clean(lerp(GUARD, HOOK, i / 6), t, true));
      if (before < 1 && r.debug.reach.right >= 1) break;
    }
    expect(events).toHaveLength(0);
    const lost = clean(HOOK, (t += 50), false);
    lost.rightWrist = { ...lost.rightWrist, confidence: 0.1 };
    expect(r.update(lost)).toHaveLength(1);
  });
});

