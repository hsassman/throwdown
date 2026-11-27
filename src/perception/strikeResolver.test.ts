import { describe, it, expect } from "vitest";
import { StrikeResolver, punchKindOf, zoneOf } from "./strikeResolver";
import { STRIKE_CONFIG } from "../config/tuning";
import { midpoint, type Keypoint, type PoseFrame } from "../pose/poseTypes";

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/**
 * Poses in the raw (unmirrored) camera frame: the player faces the camera, so
 * their anatomical left sits at larger image x.
 *
 * The right arm's three postures are laid out with real proportions, so the
 * measured segment lengths actually mean what the resolver assumes. Torso here
 * is 0.34 (shoulders y=0.38, hips y=0.72), and the seeded segment lengths are
 * 0.54 / 0.57 torso units, so a segment at full length spans ~0.18 / ~0.19 in
 * image units.
 */
type Arm = { elbow: [number, number]; wrist: [number, number] };

/** Elbow folded, fist at the chin. Both segments at close to full on-screen
 * length, so there is no foreshortening to mistake for extension. */
const GUARD: Arm = { elbow: [0.4, 0.56], wrist: [0.47, 0.37] };

/** Thrown straight down the lens: both segments collapse on screen while the
 * wrist barely moves. This is the punch a frontal camera can hardly see. */
const STRAIGHT: Arm = { elbow: [0.41, 0.44], wrist: [0.4, 0.42] };

/** Thrown sideways: long on-screen travel, little foreshortening. */
const HOOK: Arm = { elbow: [0.24, 0.4], wrist: [0.1, 0.44] };

function pose(arm: Arm, t = 0): PoseFrame {
  return {
    timestamp: t,
    leftShoulder: kp(0.58, 0.38),
    rightShoulder: kp(0.42, 0.38),
    leftElbow: kp(0.63, 0.5),
    leftWrist: kp(0.63, 0.63),
    rightElbow: kp(arm.elbow[0], arm.elbow[1]),
    rightWrist: kp(arm.wrist[0], arm.wrist[1]),
    leftHip: kp(0.56, 0.72),
    rightHip: kp(0.44, 0.72),
    nose: kp(0.5, 0.22),
    leftEye: kp(0.53, 0.21),
    rightEye: kp(0.47, 0.21),
    leftEar: kp(0.56, 0.22),
    rightEar: kp(0.44, 0.22),
  };
}

/** Interpolates between two arm postures, for building a motion. */
function lerpArm(a: Arm, b: Arm, t: number): Arm {
  const mix = (u: number, v: number) => u + (v - u) * t;
  return {
    elbow: [mix(a.elbow[0], b.elbow[0]), mix(a.elbow[1], b.elbow[1])],
    wrist: [mix(a.wrist[0], b.wrist[0]), mix(a.wrist[1], b.wrist[1])],
  };
}

/** A punch: `steps` samples from guard to `to`, then held. Pose samples arrive
 * at ~15 FPS, so 66ms apart. */
function throwPunch(to: Arm, steps: number, hold: number, t0 = 0): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 1; i <= steps; i++) {
    frames.push(pose(lerpArm(GUARD, to, i / steps), t0 + i * 66));
  }
  for (let i = 0; i < hold; i++) {
    frames.push(pose(to, t0 + (steps + i + 1) * 66));
  }
  return frames;
}

/** Settling frames at guard, so segment lengths are learned. */
function atGuard(n: number, t0 = 0): PoseFrame[] {
  return Array.from({ length: n }, (_, i) => pose(GUARD, t0 + i * 66));
}

/** Feeds frames, returning every strike emitted. */
function run(resolver: StrikeResolver, frames: PoseFrame[]) {
  return frames.flatMap((f) => resolver.update(f));
}

describe("StrikeResolver", () => {
  it("does not fire from a guard held still", () => {
    const r = new StrikeResolver();
    expect(run(r, atGuard(40))).toHaveLength(0);
  });

  it("does not treat a folded guard as a foreshortened arm", () => {
    // The flaw the first version of reachOf had: bending the elbow shortens
    // the shoulder-to-wrist distance, and comparing that against a straight
    // arm made a normal guard read as most of a landed punch.
    const r = new StrikeResolver();
    run(r, atGuard(20));
    expect(r.debug.reach.right, "guard should sit well below a hit")
      .toBeLessThan(0.6);
  });

  it("does not fire from a slow reach forward", () => {
    // Adjusting your guard or scratching your nose covers the same distance a
    // punch does. Speed is what separates them.
    const r = new StrikeResolver();
    const slow: PoseFrame[] = [];
    for (let i = 1; i <= 45; i++) {
      slow.push(pose(lerpArm(GUARD, STRAIGHT, i / 45), i * 66));
    }
    expect(run(r, [...atGuard(10), ...slow])).toHaveLength(0);
  });

  it("registers a straight punch thrown down the lens", () => {
    // The motion a frontal webcam can barely see: the wrist hardly moves on
    // screen, and only foreshortening reveals it.
    const r = new StrikeResolver();
    const strikes = run(r, [...atGuard(10), ...throwPunch(STRAIGHT, 3, 8, 660)]);
    expect(strikes.length, "one extension is one strike").toBe(1);
    expect(strikes[0].hand).toBe("right");
    expect(strikes[0].power).toBeGreaterThan(0);
    expect(strikes[0].power).toBeLessThanOrEqual(1);
  });

  it("registers a hook, which foreshortens barely at all", () => {
    const r = new StrikeResolver();
    const strikes = run(r, [...atGuard(10), ...throwPunch(HOOK, 3, 8, 660)]);
    expect(strikes.length).toBe(1);
    expect(strikes[0].zone.lane, "a right hook arrives on the player's right")
      .toBe("right");
  });

  it("requires the fist to come back before it can strike again", () => {
    const r = new StrikeResolver();
    const frames = [
      ...atGuard(10),
      ...throwPunch(STRAIGHT, 3, 4, 660),
      ...atGuard(8, 1320),
      ...throwPunch(STRAIGHT, 3, 4, 1980),
    ];
    expect(run(r, frames).length).toBe(2);
  });

  it("never latches 'extended' through a tracking dropout", () => {
    // Losing the arm mid-punch must not register a strike the player never
    // threw, nor leave the hand stuck so the next good frame does.
    const r = new StrikeResolver();
    const frames = [...atGuard(10), ...throwPunch(STRAIGHT, 3, 4, 660)];
    for (const f of frames.slice(10)) {
      f.rightWrist = { ...f.rightWrist, confidence: 0 };
    }
    expect(run(r, frames)).toHaveLength(0);
  });

  it("reads landmarks only - no dependency on MediaPipe z", () => {
    // Every z carries a wild value; the result must be identical without it.
    const clean = new StrikeResolver();
    const poisoned = new StrikeResolver();
    const frames = [...atGuard(10), ...throwPunch(STRAIGHT, 3, 8, 660)];

    const a = frames.map((f) => clean.update(f).length);
    const b = frames.map((f) => {
      const copy: PoseFrame = { ...f };
      for (const key of Object.keys(copy) as (keyof PoseFrame)[]) {
        const v = copy[key];
        if (v && typeof v === "object" && "x" in v) {
          (copy[key] as Keypoint) = { ...(v as Keypoint), z: Math.random() * 1e3 };
        }
      }
      return poisoned.update(copy).length;
    });
    expect(b).toEqual(a);
  });
});

describe("zoneOf", () => {
  const shoulders = midpoint(kp(0.58, 0.38), kp(0.42, 0.38));
  const hips = midpoint(kp(0.56, 0.72), kp(0.44, 0.72));
  const torso = 0.34;

  it("splits head from body at the shoulder line", () => {
    expect(zoneOf(kp(0.5, 0.3), shoulders, hips, torso).height).toBe("head");
    expect(zoneOf(kp(0.5, 0.6), shoulders, hips, torso).height).toBe("body");
  });

  it("reports the lane from the PLAYER's point of view, not the image's", () => {
    // The raw camera image is unmirrored, so the player's own right hand sits
    // at smaller x. Reporting the image side here would label every right hook
    // as arriving on the left.
    const wide = STRIKE_CONFIG.laneHalfWidth * torso * 2;
    const mid = (shoulders.x + hips.x) / 2;
    expect(zoneOf(kp(mid - wide, 0.3), shoulders, hips, torso).lane).toBe("right");
    expect(zoneOf(kp(mid + wide, 0.3), shoulders, hips, torso).lane).toBe("left");
    expect(zoneOf(kp(mid, 0.3), shoulders, hips, torso).lane).toBe("centre");
  });

  it("is invariant to where the player stands in the room", () => {
    // Zones are measured in the player's own body frame, so walking sideways
    // must not change which lane a punch is credited to.
    const shift = 0.2;
    const shifted = midpoint(kp(0.58 + shift, 0.38), kp(0.42 + shift, 0.38));
    const shiftedHips = midpoint(kp(0.56 + shift, 0.72), kp(0.44 + shift, 0.72));
    const mid = (shoulders.x + hips.x) / 2;
    const wide = STRIKE_CONFIG.laneHalfWidth * torso * 2;

    const here = zoneOf(kp(mid - wide, 0.3), shoulders, hips, torso);
    const there = zoneOf(
      kp(mid - wide + shift, 0.3),
      shifted,
      shiftedHips,
      torso
    );
    expect(there).toEqual(here);
  });
});

describe("Wii-style punches", () => {
  /** Hands down by the hips: not a guard. */
  const LOW: Arm = { elbow: [0.42, 0.56], wrist: [0.43, 0.72] };
  /** A lower guard, fists at the chest, for throwing an uppercut from. */
  const CHEST: Arm = { elbow: [0.41, 0.58], wrist: [0.45, 0.5] };
  /** Uppercut: fist driven up past the face. */
  const UPPER: Arm = { elbow: [0.41, 0.36], wrist: [0.44, 0.14] };

  /** `steps` frames 66ms apart from one posture to another. */
  function move(from: Arm, to: Arm, steps: number, t0: number): PoseFrame[] {
    return Array.from({ length: steps }, (_, i) => pose(lerpArm(from, to, (i + 1) / steps), t0 + (i + 1) * 66));
  }
  function hold(arm: Arm, n: number, t0: number): PoseFrame[] {
    return Array.from({ length: n }, (_, i) => pose(arm, t0 + i * 66));
  }

  it("a quick punch from the guard counts", () => {
    const r = new StrikeResolver();
    run(r, atGuard(10));
    expect(run(r, move(GUARD, STRAIGHT, 2, 660)).length + run(r, hold(STRAIGHT, 3, 900)).length).toBe(1);
  });

  it("an arm swung up from the side, hands never in the guard, does not count", () => {
    const r = new StrikeResolver();
    run(r, hold(LOW, 10, 0));
    const swung = [...move(LOW, HOOK, 2, 660), ...hold(HOOK, 3, 860), ...move(HOOK, LOW, 2, 1060)];
    expect(run(r, swung)).toEqual([]);
  });

  it("waving an arm that is already out does not count, however fast", () => {
    const r = new StrikeResolver();
    run(r, hold(LOW, 10, 0));
    const OUT_A: Arm = { elbow: [0.26, 0.4], wrist: [0.12, 0.3] };
    const OUT_B: Arm = { elbow: [0.25, 0.46], wrist: [0.1, 0.56] };
    let t = 660;
    const frames: PoseFrame[] = [];
    for (let k = 0; k < 6; k++) {
      frames.push(...move(k % 2 ? OUT_B : OUT_A, k % 2 ? OUT_A : OUT_B, 2, t));
      t += 132;
    }
    expect(run(r, frames)).toEqual([]);
  });

  it("a slow reach out of the guard does not count", () => {
    const r = new StrikeResolver();
    run(r, atGuard(10));
    // ~1.3 s from guard to full extension: a reach, not a punch.
    expect(run(r, [...move(GUARD, STRAIGHT, 20, 660), ...hold(STRAIGHT, 4, 2060)])).toEqual([]);
  });

  it("after a punch the fist has to come back to the guard before the next one counts", () => {
    const r = new StrikeResolver();
    run(r, atGuard(10));
    expect(run(r, [...move(GUARD, STRAIGHT, 2, 660), ...hold(STRAIGHT, 2, 860)]).length).toBe(1);
    // Dropped to the hips instead of back up to the guard, then thrown again.
    const again = [...move(STRAIGHT, LOW, 3, 1000), ...hold(LOW, 4, 1200), ...move(LOW, STRAIGHT, 2, 1460), ...hold(STRAIGHT, 2, 1600)];
    expect(run(r, again)).toEqual([]);
    // Back to the guard, then thrown: counts.
    const proper = [...move(STRAIGHT, GUARD, 3, 1800), ...hold(GUARD, 4, 2000), ...move(GUARD, STRAIGHT, 2, 2264), ...hold(STRAIGHT, 2, 2400)];
    expect(run(r, proper).length).toBe(1);
  });

  it("names the three punches by direction", () => {
    const straight = new StrikeResolver();
    run(straight, atGuard(10));
    const s = run(straight, [...move(GUARD, STRAIGHT, 2, 660), ...hold(STRAIGHT, 3, 860)]);
    expect(s.map((e) => e.kind)).toEqual(["straight"]);

    const hook = new StrikeResolver();
    run(hook, atGuard(10));
    const h = run(hook, [...move(GUARD, HOOK, 2, 660), ...hold(HOOK, 3, 860)]);
    expect(h.map((e) => e.kind)).toEqual(["hook"]);

    const upper = new StrikeResolver();
    run(upper, hold(CHEST, 10, 0));
    const u = run(upper, [...move(CHEST, UPPER, 2, 660), ...hold(UPPER, 3, 860)]);
    expect(u.map((e) => e.kind)).toEqual(["uppercut"]);
  });
});

describe("punchKindOf", () => {
  it("up wins: uppercut; sideways wins: hook; forward or no clear winner: straight", () => {
    expect(punchKindOf({ x: 0.2, y: 3, z: 0.5 })).toBe("uppercut");
    expect(punchKindOf({ x: -3, y: 0.4, z: 0.5 })).toBe("hook");
    expect(punchKindOf({ x: 0.2, y: 0.1, z: 6 })).toBe("straight");
    expect(punchKindOf({ x: 1, y: 1, z: 2 })).toBe("straight");
    // Downward travel is never an uppercut.
    expect(punchKindOf({ x: 0, y: -3, z: 0 })).toBe("straight");
  });
});
