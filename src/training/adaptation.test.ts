import { describe, it, expect } from "vitest";
import {
  adaptivePick,
  calibrationFrom,
  coachingNotes,
  estimateBias,
  weakestZones,
  zoneSkill,
  zoneWeights,
} from "./adaptation";
import {
  freshProfile,
  recordOutcome,
  recordRound,
  reviveProfile,
  PROFILE_VERSION,
  type TrainingProfile,
} from "./profile";
import { HIT_ZONES, ZONE_BY_ID, type HitZone } from "./hitZones";
import { ADAPT_CONFIG, TRAINING_CONFIG } from "../config/tuning";
import type { DrillOutcome } from "./drill";
import { strikeNear } from "./testStrike";

/** A landed outcome on `zone`, missing by the given offset. */
function hit(
  zone: HitZone,
  offset: { lateral?: number; height?: number } = {},
  extra: Partial<DrillOutcome> = {}
): DrillOutcome {
  const lateral = offset.lateral ?? 0;
  const height = offset.height ?? 0;
  const strike = strikeNear(zone.centre, offset);
  return {
    kind: "hit",
    zone,
    index: 1,
    strike,
    accuracy: 0.8,
    miss: { distance: Math.hypot(lateral, height), lateral, height },
    power: 0.8,
    reactionMs: 400,
    timing: 1,
    score: 0.85,
    ...extra,
  };
}

function miss(zone: HitZone): DrillOutcome {
  return {
    kind: "expired",
    zone,
    index: 1,
    strike: null,
    accuracy: 0,
    miss: { distance: Infinity, lateral: 0, height: 0 },
    power: 0,
    reactionMs: TRAINING_CONFIG.windowMs,
    timing: 0,
    score: 0,
  };
}

/** Trains `zones` with a consistent offset until each is past the sample gate. */
function train(
  zones: HitZone[],
  offset: { lateral?: number; height?: number },
  reps = TRAINING_CONFIG.minZoneSamples + 2
): TrainingProfile {
  const p = freshProfile();
  for (let i = 0; i < reps; i++) {
    for (const z of zones) recordOutcome(p, hit(z, offset));
  }
  return p;
}

describe("profile bookkeeping", () => {
  it("starts with a record for every zone and no evidence", () => {
    const p = freshProfile();
    expect(Object.keys(p.zones).sort()).toEqual(HIT_ZONES.map((z) => z.id).sort());
    expect(p.totalStrikes).toBe(0);
    for (const z of HIT_ZONES) expect(p.zones[z.id].accuracy).toBe(0);
  });

  it("does NOT let a missed target contribute to the bias", () => {
    // An expired target has no landing point. Folding it in as a zero offset
    // would drag the bias estimate toward the origin in proportion to how
    // often the player misses, which is exactly backwards.
    const nose = ZONE_BY_ID.get("nose")!;
    const p = freshProfile();
    for (let i = 0; i < 10; i++) recordOutcome(p, hit(nose, { height: -0.2 }));
    const withHits = p.zones.nose.bias.height;
    for (let i = 0; i < 20; i++) recordOutcome(p, miss(nose));
    expect(p.zones.nose.bias.height).toBe(withHits);
    expect(p.zones.nose.biasSamples).toBe(10);
    // But a miss IS evidence about accuracy.
    expect(p.zones.nose.accuracy).toBeLessThan(0.8);
  });

  it("weights recent form over ancient history", () => {
    const nose = ZONE_BY_ID.get("nose")!;
    const p = freshProfile();
    for (let i = 0; i < 60; i++) recordOutcome(p, hit(nose, {}, { accuracy: 0.1 }));
    const beginner = p.zones.nose.accuracy;
    for (let i = 0; i < 60; i++) recordOutcome(p, hit(nose, {}, { accuracy: 1 }));
    expect(beginner).toBeLessThan(0.3);
    // A plain lifetime mean would sit near 0.55 here. The player improved, and
    // the profile must be able to say so.
    expect(p.zones.nose.accuracy).toBeGreaterThan(0.75);
  });

  it("records rounds and keeps the best score", () => {
    const p = freshProfile();
    recordRound(p, 0.4);
    recordRound(p, 0.9);
    recordRound(p, 0.6);
    expect(p.rounds).toBe(3);
    expect(p.bestRoundScore).toBe(0.9);
  });
});

describe("profile persistence", () => {
  it("survives a round trip through JSON", () => {
    const p = train(HIT_ZONES.slice(0, 5), { height: -0.1 });
    const back = reviveProfile(JSON.parse(JSON.stringify(p)));
    expect(back.totalStrikes).toBe(p.totalStrikes);
    expect(back.zones.nose.bias.height).toBeCloseTo(p.zones.nose.bias.height, 10);
  });

  it("degrades to a fresh profile rather than throwing, whatever it is fed", () => {
    // This reads from localStorage: the input can be a half-written string
    // from a browser killed mid-write, a future version, or something pasted
    // in by hand. A corrupted profile that crashes training is unrecoverable
    // without devtools.
    for (const junk of [
      null,
      undefined,
      42,
      "not json",
      [],
      {},
      { version: 999, zones: { nose: { accuracy: 5 } } },
      { version: PROFILE_VERSION, zones: null },
      { version: PROFILE_VERSION, totalStrikes: NaN, zones: { nose: "nope" } },
    ]) {
      const p = reviveProfile(junk);
      expect(p.version).toBe(PROFILE_VERSION);
      expect(Number.isFinite(p.totalStrikes)).toBe(true);
      expect(Object.keys(p.zones).length).toBe(HIT_ZONES.length);
    }
  });

  it("drops records for zones that no longer exist", () => {
    // `gut` was a real zone until the dummy's cut line was measured off the
    // reference photo. A stale record would feed a phantom target into the
    // bias estimate forever.
    const saved = {
      ...freshProfile(),
      zones: { ...freshProfile().zones, gut: { presented: 9, landed: 9, accuracy: 1, power: 1, timing: 1, bias: { lateral: 0.5, height: 0.5 }, biasSamples: 9 } },
    };
    const back = reviveProfile(JSON.parse(JSON.stringify(saved)));
    expect(back.zones.gut).toBeUndefined();
  });
});

describe("bias estimation", () => {
  it("says it has no evidence rather than reporting a zero bias", () => {
    // "No bias detected" and "not enough data to say" are the same number and
    // opposite facts. The caller has to be able to tell them apart.
    const b = estimateBias(freshProfile());
    expect(b.confident).toBe(false);
    expect(b.reason).toMatch(/more scored punches/);
    expect(calibrationFrom(freshProfile())).toEqual({ lateral: 0, height: 0 });
  });

  it("detects a consistent offset across many zones", () => {
    const p = train(HIT_ZONES, { height: -0.15 });
    const b = estimateBias(p);
    expect(b.confident).toBe(true);
    expect(b.height).toBeCloseTo(-0.15, 1);
    // Correction is the NEGATION, under-applied by the gain.
    const c = calibrationFrom(p);
    expect(c.height).toBeGreaterThan(0);
    expect(c.height).toBeCloseTo(0.15 * ADAPT_CONFIG.gain, 1);
  });

  it("CANNOT be taught an offset by hammering one target", () => {
    // The guard that separates a setup error from a technical fault. A bias
    // seen on one zone is that player's technique on that shot; only a bias
    // seen across the dummy is the camera. Without this, a player who always
    // undercuts their jab would have the whole game silently shifted to match.
    const nose = ZONE_BY_ID.get("nose")!;
    const p = freshProfile();
    for (let i = 0; i < 300; i++) recordOutcome(p, hit(nose, { height: -0.3 }));
    const b = estimateBias(p);
    expect(b.samples).toBeGreaterThan(ADAPT_CONFIG.minSamples);
    expect(b.confident).toBe(false);
    expect(b.reason).toMatch(/more zones/);
    expect(calibrationFrom(p)).toEqual({ lateral: 0, height: 0 });
  });

  it("ignores one wildly bad zone instead of averaging it in", () => {
    // Why the estimate is a median. One genuine technical fault must not get
    // baked into the correction applied to every other target.
    const clean = HIT_ZONES.filter((z) => z.id !== "liver");
    const p = freshProfile();
    for (let i = 0; i < TRAINING_CONFIG.minZoneSamples + 2; i++) {
      for (const z of clean) recordOutcome(p, hit(z, { height: -0.05 }));
      recordOutcome(p, hit(ZONE_BY_ID.get("liver")!, { height: -0.9 }));
    }
    const b = estimateBias(p);
    expect(b.confident).toBe(true);
    // A mean would be dragged well past -0.10 by the outlier.
    expect(b.height).toBeCloseTo(-0.05, 1);
  });

  it("never applies a correction larger than its bound", () => {
    const p = train(HIT_ZONES, { height: -5, lateral: 5 });
    const c = calibrationFrom(p);
    expect(Math.abs(c.height)).toBeLessThanOrEqual(ADAPT_CONFIG.maxCorrection);
    expect(Math.abs(c.lateral)).toBeLessThanOrEqual(ADAPT_CONFIG.maxCorrection);
  });

  it("exposes ONLY a coordinate correction — never a hit threshold", () => {
    // The architectural line, asserted structurally exactly as
    // trackingMonitor.test.ts does. A loop that could relax the reach
    // threshold because the player was missing would make the game easier the
    // worse you got, invisibly. Adding a third knob must break this test.
    const p = train(HIT_ZONES, { height: -0.1 });
    expect(Object.keys(calibrationFrom(p)).sort()).toEqual(["height", "lateral"]);
  });
});

describe("skill and target weighting", () => {
  it("rates an untrained zone as weakest, not as average", () => {
    // A neutral seed would make untrained targets look competent and stop them
    // being drilled — the exact opposite of what the loop is for.
    const p = train([ZONE_BY_ID.get("nose")!], {});
    expect(zoneSkill(p, "nose")).toBeGreaterThan(0);
    expect(zoneSkill(p, "liver")).toBe(0);
    expect(weakestZones(p)[0].id).not.toBe("nose");
  });

  it("counts ignoring a target as a weakness, not as accuracy", () => {
    // A player can be pinpoint on the three targets they bother to answer.
    const nose = ZONE_BY_ID.get("nose")!;
    const chin = ZONE_BY_ID.get("chin")!;
    const p = freshProfile();
    for (let i = 0; i < 12; i++) recordOutcome(p, hit(nose, {}, { accuracy: 1 }));
    for (let i = 0; i < 12; i++) {
      recordOutcome(p, hit(chin, {}, { accuracy: 1 }));
      recordOutcome(p, miss(chin));
      recordOutcome(p, miss(chin));
    }
    expect(zoneSkill(p, "chin")).toBeLessThan(zoneSkill(p, "nose"));
  });

  it("keeps drilling mastered zones rather than dropping them", () => {
    // Drilling only weaknesses produces a player who has drilled away their
    // strengths, and makes the session monotonous when they are struggling.
    const p = train(HIT_ZONES, {}, 40);
    for (const w of zoneWeights(p).values()) expect(w).toBeGreaterThanOrEqual(1);
  });

  it("favours the weak zone without ever excluding the strong one", () => {
    const nose = ZONE_BY_ID.get("nose")!;
    const p = freshProfile();
    for (let i = 0; i < 40; i++) recordOutcome(p, hit(nose, {}, { accuracy: 1 }));
    const w = zoneWeights(p);
    expect(w.get("liver")!).toBeGreaterThan(w.get("nose")!);

    let seed = 3;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = adaptivePick(p, rng);
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const z = pick(HIT_ZONES, null);
      counts.set(z.id, (counts.get(z.id) ?? 0) + 1);
    }
    expect(counts.get("liver")!).toBeGreaterThan(counts.get("nose")!);
    expect(counts.get("nose")!).toBeGreaterThan(0);
  });

  it("still honours the no-repeat rule when weighted", () => {
    const p = train(HIT_ZONES, {});
    const pick = adaptivePick(p, () => 0.999999);
    const previous = HIT_ZONES[0];
    for (let i = 0; i < 50; i++) {
      expect(pick(HIT_ZONES, previous).id).not.toBe(previous.id);
    }
  });
});

describe("coaching notes", () => {
  it("blames the CAMERA for a whole-body offset, not the player", () => {
    // Telling a player to raise their hands when the real cause is a high
    // camera makes them change a technique that was fine.
    const p = train(HIT_ZONES, { height: -0.2 });
    const notes = coachingNotes(p);
    const setup = notes.filter((n) => n.kind === "setup");
    expect(setup.length).toBe(1);
    expect(setup[0].text).toMatch(/camera framing/);
    expect(setup[0].text).toMatch(/low/);
  });

  it("blames the PLAYER for a fault on one zone only", () => {
    const p = freshProfile();
    for (let i = 0; i < TRAINING_CONFIG.minZoneSamples + 2; i++) {
      for (const z of HIT_ZONES) {
        recordOutcome(p, hit(z, z.id === "liver" ? { height: -0.35 } : {}));
      }
    }
    const notes = coachingNotes(p);
    expect(notes.some((n) => n.kind === "setup")).toBe(false);
    const technique = notes.filter((n) => n.kind === "technique");
    expect(technique.length).toBeGreaterThan(0);
    expect(technique[0].zoneId).toBe("liver");
    expect(technique[0].text).toMatch(/under it/);
  });

  it("says nothing at all on an empty profile", () => {
    expect(coachingNotes(freshProfile())).toEqual([]);
  });
});
