import { describe, it, expect } from "vitest";
import { SkeletonSolver } from "./skeletonSolver";
import { PosePredictor } from "./predictor";
import { RoiTracker } from "./roiCrop";
import type { PoseFrame } from "./poseTypes";

// These are written to measure the actual improvement, not to check the code
// agrees with itself. Each one builds a synthetic body with a known truth,
// corrupts it the way MediaPipe corrupts a real one, and asserts the error
// after correction is meaningfully smaller than before.

/** Deterministic noise - a seeded LCG, so a run that fails fails reproducibly. */
function noise(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

const kp = (x: number, y: number, confidence = 0.95) => ({
  x,
  y,
  z: 0,
  confidence,
});

/**
 * A body with exact, known limb lengths. Arms are posed by angle so the truth
 * is analytic rather than eyeballed.
 */
function truth(t: number, leftArm = 0.4, rightArm = -0.3): PoseFrame {
  const UPPER = 0.14;
  const LOWER = 0.13;
  const sway = Math.sin(t * 1.7) * 0.01;

  const ls = { x: 0.42 + sway, y: 0.36 };
  const rs = { x: 0.58 + sway, y: 0.36 };
  const le = {
    x: ls.x + Math.cos(leftArm + Math.PI / 2) * UPPER,
    y: ls.y + Math.sin(leftArm + Math.PI / 2) * UPPER,
  };
  const re = {
    x: rs.x + Math.cos(rightArm + Math.PI / 2) * UPPER,
    y: rs.y + Math.sin(rightArm + Math.PI / 2) * UPPER,
  };
  const lw = {
    x: le.x + Math.cos(leftArm + Math.PI / 2.4) * LOWER,
    y: le.y + Math.sin(leftArm + Math.PI / 2.4) * LOWER,
  };
  const rw = {
    x: re.x + Math.cos(rightArm + Math.PI / 2.4) * LOWER,
    y: re.y + Math.sin(rightArm + Math.PI / 2.4) * LOWER,
  };

  return {
    timestamp: t * 1000,
    leftShoulder: kp(ls.x, ls.y),
    rightShoulder: kp(rs.x, rs.y),
    leftElbow: kp(le.x, le.y),
    rightElbow: kp(re.x, re.y),
    leftWrist: kp(lw.x, lw.y),
    rightWrist: kp(rw.x, rw.y),
    leftHip: kp(0.45 + sway, 0.62),
    rightHip: kp(0.55 + sway, 0.62),
    nose: kp(0.5 + sway, 0.26),
    leftEye: kp(0.48 + sway, 0.25),
    rightEye: kp(0.52 + sway, 0.25),
    leftEar: kp(0.46 + sway, 0.26),
    rightEar: kp(0.54 + sway, 0.26),
  } as PoseFrame;
}

/** Adds independent per-landmark jitter, exactly the error model MediaPipe has. */
function corrupt(pose: PoseFrame, rand: () => number, amount: number): PoseFrame {
  const out = { timestamp: pose.timestamp } as PoseFrame;
  for (const k of Object.keys(pose) as (keyof PoseFrame)[]) {
    if (k === "timestamp") continue;
    const p = pose[k] as { x: number; y: number; confidence: number };
    out[k] = {
      x: p.x + rand() * amount,
      y: p.y + rand() * amount,
      z: 0,
      confidence: p.confidence,
    } as never;
  }
  return out;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe("limb rigidity", () => {
  it("measurably reduces how much limb lengths breathe", () => {
    // The headline claim. MediaPipe estimates each landmark independently, so
    // the elbow-to-wrist distance changes every frame even on a rigid forearm.
    // A temporal filter cannot fix that - it is an error across space.
    const solver = new SkeletonSolver();
    const rand = noise(12345);
    const JITTER = 0.012;

    const rawLengths: number[] = [];
    const fixedLengths: number[] = [];

    for (let i = 0; i < 200; i++) {
      const t = i / 15;
      const clean = truth(t);
      const dirty = corrupt(clean, rand, JITTER);
      const fixed = solver.update(dirty);
      // Measure after the solver has had time to learn.
      if (i > 60) {
        rawLengths.push(dist(dirty.leftElbow, dirty.leftWrist));
        fixedLengths.push(dist(fixed.leftElbow, fixed.leftWrist));
      }
    }

    const spread = (xs: number[]) => {
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(
        xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
      );
    };

    const before = spread(rawLengths);
    const after = spread(fixedLengths);
    // A real, quantified improvement - not "it changed something".
    //
    // Measured 0.280 (a 72% reduction in length variance) with the magnitude
    // discriminator in skeletonSolver. The threshold is set just above that so
    // this is a genuine regression guard: an earlier speed-based rule scored
    // 0.549 and would fail here, which is precisely the point.
    expect(after).toBeLessThan(before * 0.35);
  });

  it("does NOT erase foreshortening, which is the depth signal", () => {
    // The trap. Forcing every limb to full length would make a punch thrown at
    // the camera look identical to a guard, and the strike resolver reads
    // exactly that shortening to decide a punch landed. Getting this wrong
    // would silently break hit detection while looking like an improvement.
    const solver = new SkeletonSolver();
    for (let i = 0; i < 90; i++) solver.update(truth(i / 15));

    const extended = truth(6, 0.4, -0.3);
    // Now foreshorten the right forearm hard, as a punch down the lens does.
    const punching = { ...extended } as PoseFrame;
    punching.rightWrist = kp(
      extended.rightElbow.x + (extended.rightWrist.x - extended.rightElbow.x) * 0.25,
      extended.rightElbow.y + (extended.rightWrist.y - extended.rightElbow.y) * 0.25
    );
    punching.timestamp = 6100;

    const solved = solver.update(punching);
    const observed = dist(solved.rightElbow, solved.rightWrist);
    const full = dist(extended.rightElbow, extended.rightWrist);
    // Still clearly foreshortened after solving.
    expect(observed).toBeLessThan(full * 0.5);
  });

  it("rejects a landmark that teleports faster than a human can move", () => {
    const solver = new SkeletonSolver();
    for (let i = 0; i < 90; i++) solver.update(truth(i / 15));

    const jumped = truth(6.07);
    const realX = jumped.rightWrist.x;
    // Tracker latches onto something across the room.
    jumped.rightWrist = kp(0.05, 0.9);

    const solved = solver.update(jumped);
    // Clamped to one frame's worth of physically possible travel.
    //
    // The bound is not arbitrary: 18 torso-spans/sec at a torso of ~0.28
    // normalized units over a 67 ms sample is ~0.34, and the teleport was
    // ~0.9. So the assertion is that the jump was cut to the configured
    // physical limit - my first draft asserted 0.25, which was tighter than
    // the physics the constant encodes, and the solver was right.
    //
    // This bound halves as the pose rate rises, which the pipelining fix does.
    expect(Math.abs(solved.rightWrist.x - realX)).toBeLessThan(0.4);
    expect(Math.abs(solved.rightWrist.x - 0.05)).toBeGreaterThan(0.3);
    expect(solver.debug.rejected).toBeGreaterThan(0);
    // And flagged as untrusted, rather than handed on at full confidence.
    expect(solved.rightWrist.confidence).toBeLessThan(0.5);
  });

  it("stops an elbow folding through itself", () => {
    // When tracking loses an arm it habitually collapses the wrist onto the
    // elbow. Downstream that reads as a maximally foreshortened forearm - i.e.
    // a fully committed punch at the camera. It is the worst false positive
    // this pipeline can produce.
    const solver = new SkeletonSolver();
    for (let i = 0; i < 90; i++) solver.update(truth(i / 15));

    const collapsed = truth(6.2);
    collapsed.rightWrist = kp(
      collapsed.rightElbow.x + 0.002,
      collapsed.rightElbow.y + 0.002
    );
    const solved = solver.update(collapsed);

    const a = solved.rightShoulder;
    const j = solved.rightElbow;
    const w = solved.rightWrist;
    const ux = a.x - j.x;
    const uy = a.y - j.y;
    const vx = w.x - j.x;
    const vy = w.y - j.y;
    const angle =
      (Math.acos(
        Math.min(
          1,
          Math.max(
            -1,
            (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
          )
        )
      ) *
        180) /
      Math.PI;
    expect(angle).toBeGreaterThan(15);
  });

  it("learns one shared length for left and right limbs", () => {
    // A person's arms are the same length. Pooling the two doubles the
    // evidence and removes an entire class of asymmetry artefact.
    const solver = new SkeletonSolver();
    const rand = noise(999);
    for (let i = 0; i < 160; i++) {
      solver.update(corrupt(truth(i / 15), rand, 0.01));
    }
    const out = solver.update(truth(11));
    const left = dist(out.leftShoulder, out.leftElbow);
    const right = dist(out.rightShoulder, out.rightElbow);
    expect(Math.abs(left - right)).toBeLessThan(0.012);
  });

  it("never reads MediaPipe z", () => {
    const run = (z: number) => {
      const solver = new SkeletonSolver();
      let last: PoseFrame | null = null;
      for (let i = 0; i < 100; i++) {
        const p = truth(i / 15);
        for (const k of Object.keys(p) as (keyof PoseFrame)[]) {
          if (k === "timestamp") continue;
          (p[k] as { z?: number }).z = z;
        }
        last = solver.update(p);
      }
      return last!;
    };
    const a = run(0);
    const b = run(999);
    expect(b.rightWrist.x).toBe(a.rightWrist.x);
    expect(b.rightWrist.y).toBe(a.rightWrist.y);
  });

  it("does not drift the body away from the observation", () => {
    // Relative constraints alone let the whole skeleton wander. Confidence
    // weighting is what anchors it; if that regressed, the figure would
    // slowly slide out of frame while looking internally consistent.
    const solver = new SkeletonSolver();
    const rand = noise(7);
    let out: PoseFrame | null = null;
    for (let i = 0; i < 300; i++) out = solver.update(corrupt(truth(i / 15), rand, 0.008));
    const clean = truth(299 / 15);
    expect(Math.abs(out!.leftShoulder.x - clean.leftShoulder.x)).toBeLessThan(0.03);
    expect(Math.abs(out!.leftShoulder.y - clean.leftShoulder.y)).toBeLessThan(0.03);
  });
});

describe("latency compensation", () => {
  it("lands closer to the true position than the raw sample does", () => {
    // The whole justification. A hand moving steadily is drawn where it is,
    // not where it was ~110 ms ago.
    const predictor = new PosePredictor();
    const SPEED = 0.6; // normalized units per second - a brisk jab
    const step = 1 / 15;

    let rawError = 0;
    let predError = 0;
    let n = 0;

    for (let i = 0; i < 60; i++) {
      const t = i * step;
      const pose = truth(t);
      pose.rightWrist = kp(0.5 + SPEED * t, 0.4);
      pose.timestamp = t * 1000;
      predictor.ingest(pose);

      // Render 110 ms after the sample was taken - the measured latency.
      const renderT = t + 0.11;
      const predicted = predictor.predictAt(renderT * 1000);
      if (i > 20 && predicted) {
        const trueX = 0.5 + SPEED * renderT;
        rawError += Math.abs(pose.rightWrist.x - trueX);
        predError += Math.abs(predicted.rightWrist.x - trueX);
        n++;
      }
    }

    expect(n).toBeGreaterThan(20);
    // Meaningfully closer, not marginally.
    expect(predError / n).toBeLessThan((rawError / n) * 0.55);
  });

  it("does not amplify jitter on a stationary hand", () => {
    // The classic failure of naive extrapolation. A resting hand has no
    // velocity worth extrapolating, and predicting noise on it would
    // reintroduce exactly the jitter everything else removes.
    const predictor = new PosePredictor();
    const rand = noise(4242);
    const xs: number[] = [];
    for (let i = 0; i < 80; i++) {
      const pose = truth(i / 15);
      pose.rightWrist = kp(0.5 + rand() * 0.004, 0.4);
      pose.timestamp = (i / 15) * 1000;
      predictor.ingest(pose);
      const p = predictor.predictAt((i / 15) * 1000 + 110);
      if (i > 30 && p) xs.push(p.rightWrist.x);
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    // No worse than the input noise it was given.
    expect(sd).toBeLessThan(0.004);
  });

  it("caps how far it will extrapolate", () => {
    // A latency spike must not become a visible lunge.
    const predictor = new PosePredictor();
    for (let i = 0; i < 40; i++) {
      const pose = truth(i / 15);
      pose.rightWrist = kp(0.3 + i * 0.04, 0.4);
      pose.timestamp = (i / 15) * 1000;
      predictor.ingest(pose);
    }
    const last = predictor.predictAt((39 / 15) * 1000 + 5000);
    const raw = 0.3 + 39 * 0.04;
    // 5 seconds of lead must not produce 5 seconds of travel.
    expect(Math.abs(last!.rightWrist.x - raw)).toBeLessThan(0.2);
  });

  it("leaves low-confidence landmarks alone", () => {
    const predictor = new PosePredictor();
    for (let i = 0; i < 40; i++) {
      const pose = truth(i / 15);
      pose.rightWrist = { x: 0.3 + i * 0.04, y: 0.4, z: 0, confidence: 0.2 };
      pose.timestamp = (i / 15) * 1000;
      predictor.ingest(pose);
    }
    const p = predictor.predictAt((39 / 15) * 1000 + 110);
    expect(p!.rightWrist.x).toBeCloseTo(0.3 + 39 * 0.04, 9);
  });
});

describe("roi crop", () => {
  const VW = 640;
  const VH = 480;

  it("zooms onto the player instead of the whole frame", () => {
    const roi = new RoiTracker();
    for (let i = 0; i < 40; i++) roi.update(truth(i / 15), VW, VH);
    expect(roi.debug.active).toBe(true);
    // The body occupies a fraction of a 640x480 frame; the crop should be
    // meaningfully tighter than the whole thing.
    expect(roi.debug.coverage).toBeLessThan(0.6);
    expect(roi.debug.magnification).toBeGreaterThan(1.3);
  });

  it("maps landmarks back to exactly where they started", () => {
    // If this is wrong every landmark is in the wrong place, which is the one
    // way this optimisation can be catastrophic rather than merely unhelpful.
    const roi = new RoiTracker();
    for (let i = 0; i < 40; i++) roi.update(truth(i / 15), VW, VH);
    const crop = roi.crop!;
    const pose = truth(3);
    for (const key of ["leftWrist", "rightWrist", "nose"] as const) {
      const p = pose[key]!;
      // Forward: full frame -> crop space.
      const cx = (p.x * VW - crop.x) / crop.w;
      const cy = (p.y * VH - crop.y) / crop.h;
      const [bx, by] = roi.mapBack(cx, cy, VW, VH);
      expect(bx).toBeCloseTo(p.x, 9);
      expect(by).toBeCloseTo(p.y, 9);
    }
  });

  it("holds still for a still player", () => {
    // A jittering window injects its own jitter into every landmark, which
    // would trade pixel precision for a new noise source and come out behind.
    const roi = new RoiTracker();
    const rand = noise(31337);
    for (let i = 0; i < 60; i++) roi.update(truth(0), VW, VH);
    const settled = { ...roi.crop! };
    for (let i = 0; i < 40; i++) {
      roi.update(corrupt(truth(0), rand, 0.003), VW, VH);
    }
    const after = roi.crop!;
    expect(Math.abs(after.x - settled.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(after.w - settled.w)).toBeLessThanOrEqual(8);
  });

  it("goes wide again after losing the player", () => {
    // Staying zoomed on an empty box is self-sealing - the player cannot be
    // re-acquired from outside the only region being examined.
    const roi = new RoiTracker();
    for (let i = 0; i < 40; i++) roi.update(truth(i / 15), VW, VH);
    expect(roi.crop).not.toBeNull();
    for (let i = 0; i < 30; i++) roi.update(null, VW, VH);
    expect(roi.crop).toBeNull();
  });

  it("never proposes a window outside the frame", () => {
    const roi = new RoiTracker();
    // Player hard against the left edge.
    for (let i = 0; i < 60; i++) {
      const p = truth(i / 15);
      for (const k of Object.keys(p) as (keyof PoseFrame)[]) {
        if (k === "timestamp") continue;
        (p[k] as { x: number }).x -= 0.38;
      }
      roi.update(p, VW, VH);
      const c = roi.crop;
      if (!c) continue;
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(VW + 1e-6);
      expect(c.y + c.h).toBeLessThanOrEqual(VH + 1e-6);
    }
  });
});
