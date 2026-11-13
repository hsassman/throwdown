import { describe, expect, it } from "vitest";
import {
  ImpactLog,
  impactKind,
  impactPower,
  popupFor,
  shakeFor,
  shakeOffset,
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
