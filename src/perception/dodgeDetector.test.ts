import { describe, expect, it } from "vitest";
import { DodgeDetector } from "./dodgeDetector";
import { SYNTHETIC_TORSO_SCALE, syntheticIdle } from "./synthetic";
import { TEST_CALIBRATION as CAL } from "./testCalibration";
import type { PoseFrame } from "../pose/poseTypes";

// Milestone 2's done-when has two halves: dodges must register promptly, AND
// ordinary movement must not trigger them. The false-trigger tests below carry
// as much weight as the positive ones — a detector that fires on every
// sidestep would technically "detect dodges" while being useless in a fight.


/** Base upright frame, matching the calibrated neutral exactly. */
function neutralFrame(): PoseFrame {
  return syntheticIdle(1)[0];
}

/** Moves the whole body by (dx, dy) — a step, not a dodge. */
function translate(f: PoseFrame, dx: number, dy: number): PoseFrame {
  const out = { timestamp: f.timestamp } as PoseFrame;
  for (const k of Object.keys(f) as (keyof PoseFrame)[]) {
    if (k === "timestamp") continue;
    // PoseFrame's leg/hand landmarks are optional and absent from these
    // fixtures, so a key can legitimately carry no keypoint.
    const kp = f[k];
    if (!kp) continue;
    out[k] = { ...kp, x: kp.x + dx, y: kp.y + dy };
  }
  return out;
}

/** Moves only the head, leaving the shoulders put — an actual slip. */
function moveHead(f: PoseFrame, dx: number, dy: number): PoseFrame {
  return {
    ...f,
    nose: { ...f.nose, x: f.nose.x + dx, y: f.nose.y + dy },
  };
}

const S = SYNTHETIC_TORSO_SCALE;

describe("dodge detector — neutral and false triggers", () => {
  it("reports no dodge when standing at the calibrated neutral", () => {
    const d = new DodgeDetector();
    const s = d.update(neutralFrame(), CAL);
    expect(s.tracked).toBe(true);
    expect(Math.abs(s.lean)).toBeLessThan(0.01);
    expect(s.duck).toBeLessThan(0.01);
  });

  it("does NOT report a dodge when the whole body steps sideways", () => {
    // The single most important false-trigger case: the head moves a long way
    // in the image, but relative to the shoulders it has not moved at all.
    const d = new DodgeDetector();
    const stepped = translate(neutralFrame(), 0.25 * S, 0);
    expect(Math.abs(d.update(stepped, CAL).lean)).toBeLessThan(0.01);
  });

  it("ignores small natural sway inside the dead zone", () => {
    const d = new DodgeDetector();
    const swayed = moveHead(neutralFrame(), 0.04 * S, 0);
    expect(d.update(swayed, CAL).lean).toBe(0);
  });
});

describe("dodge detector — real dodges", () => {
  it("reports a lean when the head slips sideways over the shoulders", () => {
    const d = new DodgeDetector();
    const right = d.update(moveHead(neutralFrame(), 0.3 * S, 0), CAL);
    expect(right.lean).toBeGreaterThan(0.5);

    d.reset();
    const left = d.update(moveHead(neutralFrame(), -0.3 * S, 0), CAL);
    expect(left.lean).toBeLessThan(-0.5);
  });

  it("saturates at full commitment rather than exceeding 1", () => {
    const d = new DodgeDetector();
    const s = d.update(moveHead(neutralFrame(), 1.5 * S, 0), CAL);
    expect(s.lean).toBeLessThanOrEqual(1);
    expect(s.lean).toBeGreaterThan(0.99);
  });

  it("reports a duck when the head lowers toward the shoulders", () => {
    const d = new DodgeDetector();
    // +y is downward in image space.
    const s = d.update(moveHead(neutralFrame(), 0, 0.25 * S), CAL);
    expect(s.duck).toBeGreaterThan(0.4);
  });

  it("reports a duck when the whole body crouches", () => {
    // Bending the knees lowers head AND shoulders together, so their relative
    // distance is unchanged — this is caught by the body-drop signal instead,
    // and would be missed entirely by head-drop alone.
    const d = new DodgeDetector();
    const crouched = translate(neutralFrame(), 0, 0.3 * S);
    expect(crouched.nose.y).toBeGreaterThan(neutralFrame().nose.y);
    expect(d.update(crouched, CAL).duck).toBeGreaterThan(0.3);
  });
});

describe("dodge detector — tracking loss", () => {
  it("holds the last state rather than snapping upright when the nose is lost", () => {
    // Snapping to neutral mid-dodge would let the simulation score a hit that
    // the player had actually slipped.
    const d = new DodgeDetector();
    const dodged = moveHead(neutralFrame(), 0.3 * S, 0);
    const before = d.update(dodged, CAL);
    expect(before.lean).toBeGreaterThan(0.5);

    const lost = { ...dodged, nose: { ...dodged.nose, confidence: 0 } };
    const after = d.update(lost, CAL);
    expect(after.tracked).toBe(false);
    expect(after.lean).toBeCloseTo(before.lean, 5);
  });

  it("stays steady across a run of idle frames", () => {
    const d = new DodgeDetector();
    let maxLean = 0;
    let maxDuck = 0;
    for (const f of syntheticIdle(120)) {
      const s = d.update(f, CAL);
      maxLean = Math.max(maxLean, Math.abs(s.lean));
      maxDuck = Math.max(maxDuck, s.duck);
    }
    expect(maxLean).toBe(0);
    expect(maxDuck).toBe(0);
  });
});
