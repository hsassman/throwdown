import { describe, it, expect } from "vitest";
import { Drill, powerScore, timingScore } from "./drill";
import { ZONE_BY_ID, type HitZone } from "./hitZones";
import { TRAINING_CONFIG } from "../config/tuning";
import { makeStrike, strikeNear } from "./testStrike";

const NOSE = ZONE_BY_ID.get("nose")!;
const LIVER = ZONE_BY_ID.get("liver")!;

/** A drill that always lights the same zone, so tests can aim at it. */
function fixedDrill(zone: HitZone, targets = 4, requireHand = false) {
  return new Drill({
    targets,
    requireHand,
    tier: "expert",
    pick: () => zone,
    rng: () => 0.25,
  });
}

describe("timing score", () => {
  it("is flat at both ends and ramps between", () => {
    expect(timingScore(0)).toBe(1);
    expect(timingScore(TRAINING_CONFIG.perfectMs)).toBe(1);
    expect(timingScore(TRAINING_CONFIG.slowMs)).toBe(0);
    expect(timingScore(TRAINING_CONFIG.slowMs + 5000)).toBe(0);
    const mid = timingScore((TRAINING_CONFIG.perfectMs + TRAINING_CONFIG.slowMs) / 2);
    expect(mid).toBeCloseTo(0.5, 5);
  });
});

describe("power score", () => {
  it("saturates at the full-commitment threshold", () => {
    expect(powerScore(makeStrike({ impact: NOSE.centre, power: 1 }))).toBe(1);
    expect(
      powerScore(makeStrike({ impact: NOSE.centre, power: TRAINING_CONFIG.fullPowerAt }))
    ).toBe(1);
  });

  it("scales a flicked punch down", () => {
    const flick = powerScore(
      makeStrike({ impact: NOSE.centre, power: TRAINING_CONFIG.fullPowerAt * 0.3 })
    );
    expect(flick).toBeGreaterThan(0);
    expect(flick).toBeLessThan(0.5);
  });
});

describe("drill lifecycle", () => {
  it("lights nothing until started", () => {
    const d = fixedDrill(NOSE);
    expect(d.update(1000)).toBeNull();
    expect(d.lit).toBeNull();
  });

  it("lights a target on start and opens a window", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    expect(d.lit).not.toBeNull();
    expect(d.lit!.zone.id).toBe("nose");
    expect(d.lit!.expiresAt).toBe(TRAINING_CONFIG.windowMs);
    expect(d.lit!.index).toBe(1);
  });

  it("expires a target that is never answered", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    expect(d.update(TRAINING_CONFIG.windowMs - 1)).toBeNull();
    const out = d.update(TRAINING_CONFIG.windowMs);
    expect(out).not.toBeNull();
    expect(out!.kind).toBe("expired");
    expect(out!.score).toBe(0);
    expect(d.lit).toBeNull();
  });

  it("rests before lighting the next target", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    d.update(TRAINING_CONFIG.windowMs);
    d.update(TRAINING_CONFIG.windowMs + TRAINING_CONFIG.restMs - 1);
    expect(d.lit).toBeNull();
    d.update(TRAINING_CONFIG.windowMs + TRAINING_CONFIG.restMs);
    expect(d.lit).not.toBeNull();
  });

  it("finishes after the requested number of targets", () => {
    const d = fixedDrill(NOSE, 2);
    d.start(0);
    let t = 0;
    for (let i = 0; i < 40 && !d.finished; i++) {
      d.update(t);
      t += 200;
    }
    expect(d.finished).toBe(true);
    expect(d.stats.presented).toBe(2);
  });
});

describe("scoring a punch", () => {
  it("scores a dead-centre punch thrown fast at full power near 1", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    const out = d.onStrike(
      makeStrike({ impact: NOSE.centre, power: 1, timestamp: 300 }),
      300
    );
    expect(out!.kind).toBe("hit");
    expect(out!.accuracy).toBe(1);
    expect(out!.power).toBe(1);
    expect(out!.timing).toBe(1);
    expect(out!.score).toBeCloseTo(1, 6);
  });

  it("clears the target so one punch cannot score twice", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    d.onStrike(makeStrike({ impact: NOSE.centre, timestamp: 100 }), 100);
    expect(d.lit).toBeNull();
    // The follow-up of a one-two arrives before the next target lights, and it
    // must not be scored against a target that is already down.
    expect(d.onStrike(makeStrike({ impact: NOSE.centre, timestamp: 180 }), 180)).toBeNull();
    expect(d.stats.landed).toBe(1);
  });

  it("reports the miss as a SIGNED vector, not just a distance", () => {
    // The whole adaptation loop depends on this. "6cm out" and "6cm low" are
    // the same distance and completely different facts.
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    const out = d.onStrike(
      strikeNear(NOSE.centre, { height: -0.2, lateral: 0.05 }, { timestamp: 200 }),
      200
    );
    expect(out!.miss.height).toBeCloseTo(-0.2, 6);
    expect(out!.miss.lateral).toBeCloseTo(0.05, 6);
    expect(out!.miss.distance).toBeCloseTo(Math.hypot(0.2, 0.05), 6);
  });

  it("refuses a punch that arrives after the window shut", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    d.update(0);
    const late = TRAINING_CONFIG.windowMs + 50;
    expect(d.onStrike(makeStrike({ impact: NOSE.centre, timestamp: late }), late)).toBeNull();
    expect(d.stats.stray).toBe(1);
  });

  it("counts punches thrown at nothing as strays, not as accuracy", () => {
    const d = fixedDrill(NOSE);
    d.start(0);
    // Nothing lit yet - update() has not been called.
    d.onStrike(makeStrike({ impact: NOSE.centre }), 0);
    d.onStrike(makeStrike({ impact: NOSE.centre }), 0);
    expect(d.stats.stray).toBe(2);
    expect(d.stats.landed).toBe(0);
  });
});

describe("hand requirement", () => {
  it("asks for the hand that can actually reach the target", () => {
    // The liver is on the puncher's left. Asking for a right hand there would
    // drill a punch that cannot physically land.
    const d = fixedDrill(LIVER, 4, true);
    d.start(0);
    d.update(0);
    expect(d.lit!.hand).toBe("left");
  });

  it("rejects the wrong hand WITHOUT clearing the target", () => {
    const d = fixedDrill(LIVER, 4, true);
    d.start(0);
    d.update(0);
    const wrong = d.onStrike(
      makeStrike({ impact: LIVER.centre, hand: "right", timestamp: 200 }),
      200
    );
    expect(wrong!.kind).toBe("wrong-hand");
    expect(wrong!.score).toBe(0);
    // Still lit: a twitch must not cost the whole target.
    expect(d.lit).not.toBeNull();
    const right = d.onStrike(
      makeStrike({ impact: LIVER.centre, hand: "left", timestamp: 400 }),
      400
    );
    expect(right!.kind).toBe("hit");
    expect(d.stats.landed).toBe(1);
  });
});

describe("stats", () => {
  it("does NOT report perfect accuracy for standing still", () => {
    // The most misleading number the drill could show. Means are taken over
    // landed targets, so an unanswered round must read as zero landed rather
    // than as an unblemished average.
    const d = fixedDrill(NOSE, 3);
    d.start(0);
    let t = 0;
    for (let i = 0; i < 30 && !d.finished; i++) {
      d.update(t);
      t += 200;
    }
    const s = d.stats;
    expect(s.presented).toBe(3);
    expect(s.landed).toBe(0);
    expect(s.accuracy).toBe(0);
    expect(s.score).toBe(0);
  });

  it("tracks the best streak and breaks it on a miss", () => {
    const d = fixedDrill(NOSE, 10);
    d.start(0);
    let t = 0;
    // Two hits, one expiry, one hit.
    for (const answer of [true, true, false, true]) {
      d.update(t);
      if (answer) {
        d.onStrike(makeStrike({ impact: NOSE.centre, timestamp: t + 100 }), t + 100);
        t += 100 + TRAINING_CONFIG.restMs;
      } else {
        t += TRAINING_CONFIG.windowMs;
        d.update(t);
        t += TRAINING_CONFIG.restMs;
      }
    }
    expect(d.stats.bestStreak).toBe(2);
    expect(d.stats.streak).toBe(1);
  });
});

describe("target selection", () => {
  it("never lights the same zone twice running", () => {
    // A repeat measures nothing - the hand is already there - and reads as a
    // bug. With a real rng across many lights, no two consecutive picks may
    // match.
    let seed = 7;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const d = new Drill({ tier: "expert", targets: 0, rng });
    d.start(0);
    const seen: string[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      d.update(t);
      if (d.lit) {
        if (seen[seen.length - 1] !== d.lit.zone.id) seen.push(d.lit.zone.id);
        d.onStrike(makeStrike({ impact: d.lit.zone.centre, timestamp: t }), t);
      }
      t += TRAINING_CONFIG.restMs + 10;
    }
    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });
});
