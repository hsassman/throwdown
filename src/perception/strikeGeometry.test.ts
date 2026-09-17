import { describe, it, expect } from "vitest";
import {
  allRegions,
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
} from "./strikeGeometry";
import { StrikeResolver, impactPointOf } from "./strikeResolver";
import type { PoseFrame } from "../pose/poseTypes";

// The point of phase 2 is that a strike resolves from GEOMETRY, never from a
// classifier's label. These tests are written to fail if that regresses.

const kp = (x: number, y: number, confidence = 1) => ({ x, y, z: 0, confidence });

describe("anatomical map", () => {
  it("places the classic knockout targets above the merely painful ones", () => {
    // Encoded striking knowledge, asserted so a future tuning pass cannot
    // quietly invert it: chin and jaw rotate the head, the liver and solar
    // plexus fold people up, the crown is the hardest bone in the body and the
    // shoulder is what you are SUPPOSED to be hit on.
    const by = (id: string) => allRegions().find((r) => r.id === id)!;
    expect(by("chin").damage).toBeGreaterThan(by("nose").damage);
    expect(by("jaw_left").damage).toBeGreaterThan(by("forehead").damage);
    expect(by("liver").damage).toBeGreaterThan(by("ribs_right").damage);
    expect(by("solar_plexus").damage).toBeGreaterThan(by("chest").damage);
    expect(by("crown").damage).toBeLessThan(by("nose").damage);
    expect(by("shoulder_left").damage).toBeLessThan(by("gut").damage);
  });

  it("puts the liver on the target's right, which is the puncher's left", () => {
    // Real anatomy, and the reason a left hook to the body ends more fights
    // than a right one. If this flips, the hardest body shot in the game
    // silently moves to the wrong hand.
    expect(regionAt({ lateral: -0.3, height: 0.55 }).id).toBe("liver");
    expect(regionAt({ lateral: 0.3, height: 0.55 }).id).toBe("ribs_right");
  });

  it("treats below the belt as a foul that does no damage", () => {
    const low = regionAt({ lateral: 0, height: 0.1 });
    expect(low.legal).toBe(false);
    expect(damageOf(low, 1, approachOf(0, 0, 1))).toBe(0);
  });

  it("resolves every point on the body to something, never to nothing", () => {
    // The core claim of the rework: a strike can land ANYWHERE and always
    // produces a result. Sweeping the whole reachable envelope is the only
    // honest way to assert that — a handful of spot checks would pass even
    // with a hole in the middle of the table.
    for (let h = -0.4; h <= 2.0; h += 0.02) {
      for (let lat = -0.8; lat <= 0.8; lat += 0.02) {
        const r = regionAt({ lateral: lat, height: h });
        expect(r.id, `nothing at lat=${lat.toFixed(2)} h=${h.toFixed(2)}`).toBeTruthy();
        expect(Number.isFinite(r.damage)).toBe(true);
      }
    }
  });

  it("is symmetric about the midline except where anatomy is not", () => {
    // Head targets mirror; the liver deliberately does not.
    const l = regionAt({ lateral: -0.25, height: 1.24 });
    const r = regionAt({ lateral: 0.25, height: 1.24 });
    expect(l.label).toBe(r.label);
    expect(l.damage).toBe(r.damage);
    expect(l.textureZone).not.toBe(r.textureZone);
  });
});

describe("approach descriptor", () => {
  it("calls a punch driven down the lens straight", () => {
    expect(approachOf(0.1, 0.05, 3).arc).toBe("straight");
  });

  it("calls a punch travelling across the body hooking", () => {
    expect(approachOf(3, 0.2, 0.4).arc).toBe("hooking");
  });

  it("calls a punch travelling upward rising", () => {
    expect(approachOf(0.2, 3, 0.4).arc).toBe("rising");
  });

  it("never throws on a stationary fist", () => {
    const a = approachOf(0, 0, 0);
    expect(Number.isFinite(a.directness)).toBe(true);
    expect(a.arc).toBe("straight");
  });

  it("rewards a RISING strike to the chin and nowhere else", () => {
    // The rotational-knockout rule. A blanket uppercut bonus would also show
    // up on the body, so the second half of this is the real assertion.
    const chin = regionAt({ lateral: 0, height: 1.2 });
    const gut = regionAt({ lateral: 0, height: 0.35 });
    const rising = approachOf(0, 3, 0.3);
    const straight = approachOf(0, 0.1, 3);
    expect(damageOf(chin, 1, rising)).toBeGreaterThan(damageOf(chin, 1, straight));
    expect(damageOf(gut, 1, rising)).toBe(damageOf(gut, 1, straight));
  });
});

describe("impact point", () => {
  const shoulders = kp(0.5, 0.4);
  const hips = kp(0.5, 0.7);
  const torso = 0.3;

  it("puts the shoulder line at exactly 1.0 for any fighter", () => {
    // Falls out of the normalisation rather than being a chosen constant —
    // the torso scale IS the shoulder-to-hip distance. The anatomical table is
    // written against this, so if it ever stopped holding every region
    // boundary would shift.
    const at = impactPointOf(kp(0.5, 0.4), shoulders, hips, torso);
    expect(at.height).toBeCloseTo(1, 6);
  });

  it("holds when the player moves across the room", () => {
    // Same fist position relative to the body, different absolute position.
    const a = impactPointOf(kp(0.42, 0.35), shoulders, hips, torso);
    const b = impactPointOf(kp(0.22, 0.35), kp(0.3, 0.4), kp(0.3, 0.7), torso);
    expect(b.lateral).toBeCloseTo(a.lateral, 6);
    expect(b.height).toBeCloseTo(a.height, 6);
  });

  it("agrees with the coarse zone it is derived from", () => {
    // There is now one measurement and one view of it. Two parallel
    // implementations of "which side is left" is what produced the mirrored
    // handedness bug earlier in this project.
    for (const lat of [-0.5, -0.1, 0, 0.1, 0.5]) {
      for (const h of [0.4, 0.95, 1.3]) {
        const z = coarseZone({ lateral: lat, height: h });
        expect(["left", "centre", "right"]).toContain(z.lane);
        expect(["head", "body"]).toContain(z.height);
      }
    }
    expect(coarseZone({ lateral: 0.5, height: 1.3 }).lane).toBe("right");
    expect(coarseZone({ lateral: -0.5, height: 1.3 }).lane).toBe("left");
  });
});

describe("resolver still honours the standing rules", () => {
  /** A pose with an arm thrown out to the given wrist position. */
  function frame(t: number, wristX: number, wristY: number, z = 0): PoseFrame {
    return {
      timestamp: t,
      leftShoulder: kp(0.42, 0.4),
      rightShoulder: kp(0.58, 0.4),
      leftElbow: kp(0.4, 0.55),
      rightElbow: { ...kp(0.56, 0.5), z },
      leftWrist: kp(0.4, 0.68),
      rightWrist: { ...kp(wristX, wristY), z },
      leftHip: kp(0.45, 0.7),
      rightHip: kp(0.55, 0.7),
      nose: kp(0.5, 0.3),
      leftEar: kp(0.46, 0.31),
      rightEar: kp(0.54, 0.31),
    } as unknown as PoseFrame;
  }

  it("produces identical results with every z poisoned", () => {
    // The rule is absolute: MediaPipe's z is never read. Poisoning it must
    // change nothing, including the new approach vector — whose forward
    // component comes from x/y foreshortening, not from z.
    const run = (z: number) => {
      const r = new StrikeResolver();
      const out = [];
      for (let i = 0; i < 12; i++) {
        out.push(...r.update(frame(i * 40, 0.58 - i * 0.03, 0.4 - i * 0.004, z)));
      }
      return out;
    };
    const clean = run(0);
    const poisoned = run(999);
    expect(poisoned.length).toBe(clean.length);
    for (let i = 0; i < clean.length; i++) {
      expect(poisoned[i].impact).toEqual(clean[i].impact);
      expect(poisoned[i].region.id).toBe(clean[i].region.id);
      expect(poisoned[i].approach).toEqual(clean[i].approach);
      expect(poisoned[i].damage).toBe(clean[i].damage);
    }
  });

  it("attaches a region and a finite damage to every strike it emits", () => {
    // The guarantee that replaced "the classifier must name it first".
    const r = new StrikeResolver();
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push(...r.update(frame(i * 40, 0.58 - i * 0.03, 0.42 - i * 0.006)));
    }
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.region.id).toBeTruthy();
      expect(Number.isFinite(e.damage)).toBe(true);
      expect(e.approach.arc).toBeTruthy();
      // And the derived zone must agree with the point it came from.
      expect(e.zone).toEqual(coarseZone(e.impact));
    }
  });
});
