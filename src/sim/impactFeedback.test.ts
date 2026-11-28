import { describe, expect, it } from "vitest";
import {
  ImpactLog,
  impactKind,
  impactPower,
  popupFor,
  shakeFor,
  shakeOffset,
  freeLane,
  hitStopFor,
  TimeWarp,
  POPUP_LANES,
} from "./impactFeedback";
import type { FightEvent } from "./fightState";

const land = (target: string, power: number): FightEvent => ({
  type: "land",
  target,
  damage: 1,
  region: "jaw",
  power,
});

describe("impactKind", () => {
  it("reads every punch outcome from the player's side", () => {
    expect(impactKind(land("opponent", 0.5), "player")).toBe("landed");
    expect(impactKind(land("player", 0.5), "player")).toBe("taken");
    expect(impactKind({ type: "block", target: "opponent", region: "jaw" }, "player")).toBe("blocked");
    expect(impactKind({ type: "block", target: "player", region: "jaw" }, "player")).toBe("defended");
    expect(impactKind({ type: "miss", target: "opponent", evasion: "slipLeft", region: "jaw" }, "player")).toBe("evaded");
    expect(impactKind({ type: "miss", target: "player", evasion: "slipLeft", region: "jaw" }, "player")).toBe("slipped");
  });

  it("ignores events that aren't a punch arriving", () => {
    expect(impactKind({ type: "knockdown", target: "player", count: 1 }, "player")).toBeNull();
    expect(impactKind({ type: "roundEnd", round: 1, scores: {} }, "player")).toBeNull();
  });
});

describe("impactPower", () => {
  it("uses a landed punch's power, clamped", () => {
    expect(impactPower(land("opponent", 0.7))).toBe(0.7);
    expect(impactPower(land("opponent", 3))).toBe(1);
  });
});

describe("shake", () => {
  it("grows with power, and being hit shakes more than hitting", () => {
    const jab = shakeFor({ kind: "landed", power: 0.35 });
    const bomb = shakeFor({ kind: "landed", power: 1 });
    const taken = shakeFor({ kind: "taken", power: 1 });
    expect(bomb.amplitude).toBeGreaterThan(jab.amplitude);
    expect(taken.amplitude).toBeGreaterThan(bomb.amplitude);
    expect(shakeFor({ kind: "evaded", power: 1 }).amplitude).toBe(0);
  });

  it("decays to nothing by the end and is zero outside its window", () => {
    expect(shakeOffset(-0.01, 1, 0.2, 0)).toEqual({ x: 0, y: 0 });
    expect(shakeOffset(0.2, 1, 0.2, 0)).toEqual({ x: 0, y: 0 });
    const early = shakeOffset(0.01, 1, 0.2, 3);
    const late = shakeOffset(0.19, 1, 0.2, 3);
    expect(Math.hypot(late.x, late.y)).toBeLessThan(Math.hypot(early.x, early.y) + 1e-9);
    expect(Math.hypot(early.x, early.y)).toBeLessThanOrEqual(1);
  });
});

describe("popupFor", () => {
  it("names the punch that landed, Wii-style, sized by power", () => {
    expect(popupFor({ kind: "landed", power: 0.4, punch: "hook" })).toEqual({ text: "HOOK!", tone: "good", size: 0 });
    expect(popupFor({ kind: "landed", power: 0.7, punch: "straight" })?.size).toBe(1);
    expect(popupFor({ kind: "landed", power: 0.9, punch: "uppercut" })).toEqual({ text: "UPPERCUT!", tone: "good", size: 2 });
  });

  it("says how hard a landed punch was", () => {
    expect(popupFor({ kind: "landed", power: 0.4 })?.text).toBe("HIT");
    expect(popupFor({ kind: "landed", power: 0.7 })?.text).toBe("HARD!");
    expect(popupFor({ kind: "landed", power: 0.95 })?.text).toBe("HUGE!");
  });

  it("names defence and failed punches, and leaves being hit to the flash", () => {
    expect(popupFor({ kind: "blocked", power: 0.3 })?.text).toBe("BLOCKED");
    expect(popupFor({ kind: "slipped", power: 0.3 })?.text).toBe("SLIP!");
    expect(popupFor({ kind: "taken", power: 1 })).toBeNull();
  });
});

describe("ImpactLog", () => {
  it("lets two readers each see every impact", () => {
    const log = new ImpactLog();
    log.push("landed", 0.5, 1);
    const a = log.since(0);
    log.push("taken", 0.8, 2);
    expect(a.map((i) => i.kind)).toEqual(["landed"]);
    expect(log.since(a[0].seq).map((i) => i.kind)).toEqual(["taken"]);
    expect(log.since(0)).toHaveLength(2);
  });

  it("stays bounded with no readers", () => {
    const log = new ImpactLog();
    for (let i = 0; i < 100; i++) log.push("landed", 0.5, i);
    expect(log.since(0)).toHaveLength(16);
  });
});

describe("popup lanes", () => {
  it("never puts two live words in the same row", () => {
    const taken: number[] = [];
    for (let i = 0; i < POPUP_LANES.length; i++) taken.push(freeLane(taken));
    expect(new Set(taken).size).toBe(POPUP_LANES.length);
  });

  it("reuses a row once its word has gone", () => {
    expect(freeLane([1, 2])).toBe(0);
    expect(freeLane([0, 2])).toBe(1);
  });
});

describe("hit-stop and slow motion", () => {
  it("freezes only on punches that landed with some weight", () => {
    expect(hitStopFor({ kind: "landed", power: 0.9 })).toBeGreaterThan(0);
    expect(hitStopFor({ kind: "taken", power: 0.9 })).toBeGreaterThan(0);
    expect(hitStopFor({ kind: "landed", power: 0.2 })).toBe(0);
    expect(hitStopFor({ kind: "blocked", power: 1 })).toBe(0);
    expect(hitStopFor({ kind: "evaded", power: 1 })).toBe(0);
  });

  it("freezes harder the harder the punch, and never for long", () => {
    const big = hitStopFor({ kind: "landed", power: 1 });
    expect(big).toBeGreaterThan(hitStopFor({ kind: "landed", power: 0.5 }));
    // Past ~100ms a freeze stops reading as impact and starts reading as lag.
    expect(big).toBeLessThanOrEqual(0.1);
  });

  it("holds the figures still for the stop, then lets them go", () => {
    const w = new TimeWarp();
    w.hitStop(1000, 0.08);
    expect(w.rate(1000)).toBe(0);
    expect(w.rate(1079)).toBe(0);
    expect(w.rate(1081)).toBe(1);
  });

  it("does not let a small stop cut a big one short", () => {
    const w = new TimeWarp();
    w.hitStop(1000, 0.09);
    w.hitStop(1010, 0.03);
    expect(w.rate(1080)).toBe(0);
  });

  it("slows down, then eases back to full speed rather than snapping", () => {
    const w = new TimeWarp();
    w.slowMotion(0, 0.9, 0.3);
    expect(w.rate(100)).toBeCloseTo(0.3);
    const easing = w.rate(800);
    expect(easing).toBeGreaterThan(0.3);
    expect(easing).toBeLessThan(1);
    expect(w.rate(900)).toBe(1);
  });
});
