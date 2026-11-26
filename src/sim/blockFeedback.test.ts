import { describe, expect, it } from "vitest";
import { FightSim, type FightEvent, type FightRules } from "./fightState";
import { ImpactClassifier, type ImpactKind } from "./impactFeedback";
import { approachOf, coarseZone, damageOf, regionAt, type ImpactPoint } from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";

// A blocked punch must read as a block on screen, not as a hit as well.

const RULES: FightRules = { rounds: 3, roundSeconds: 180, damageScale: 1, enforceFouls: false, stoppages: true };
const HEAD: ImpactPoint = { lateral: 0, height: 1.24 };
const BODY: ImpactPoint = { lateral: 0, height: 0.62 };

function strike(impact: ImpactPoint): StrikeEvent {
  const region = regionAt(impact);
  const approach = approachOf(0, 0, 3);
  return {
    hand: "right", zone: coarseZone(impact), impact, region, approach,
    damage: damageOf(region, 1, approach), power: 1, speed: 4,
    contactReach: 1, timestamp: 0,
  };
}

/** One punch from `by` into the other fighter's `guard`; the impacts the
 *  player would see, and the events the sim emitted. */
function punch(by: "player" | "opponent", guard: "high" | "low" | "none", at: ImpactPoint) {
  const sim = new FightSim(RULES, { id: "player", weightClass: "middleweight" }, { id: "opponent", weightClass: "middleweight" });
  sim.start();
  const events: FightEvent[] = [];
  const seen: ImpactKind[] = [];
  const impacts = new ImpactClassifier();
  sim.on((e) => {
    events.push(e);
    const k = impacts.kind(e, "player");
    if (k) seen.push(k);
  });
  sim.setGuard(by === "player" ? "opponent" : "player", guard);
  sim.applyStrike(by, strike(at));
  return { seen, events };
}

describe("blocked punches read as blocks", () => {
  it("your high guard against their head shot: defended only, no 'taken'", () => {
    const { seen, events } = punch("opponent", "high", HEAD);
    expect(seen).toEqual(["defended"]);
    // The reduced damage still reaches the sim and the score.
    expect(events.map((e) => e.type)).toEqual(["block", "land"]);
  });

  it("their high guard against your head shot: blocked only, no 'landed'", () => {
    expect(punch("player", "high", HEAD).seen).toEqual(["blocked"]);
  });

  it("a low guard blocks the body", () => {
    expect(punch("opponent", "low", BODY).seen).toEqual(["defended"]);
  });

  it("a clean shot still reads as a hit", () => {
    expect(punch("opponent", "none", HEAD).seen).toEqual(["taken"]);
    expect(punch("player", "none", HEAD).seen).toEqual(["landed"]);
  });

  it("the wrong guard does not block: high guard, body shot", () => {
    expect(punch("opponent", "high", BODY).seen).toEqual(["taken"]);
  });

  it("a block does not swallow the next, unblocked punch", () => {
    const sim = new FightSim(RULES, { id: "player", weightClass: "middleweight" }, { id: "opponent", weightClass: "middleweight" });
    sim.start();
    const seen: ImpactKind[] = [];
    const impacts = new ImpactClassifier();
    sim.on((e) => { const k = impacts.kind(e, "player"); if (k) seen.push(k); });
    sim.setGuard("player", "high");
    sim.applyStrike("opponent", strike(HEAD));
    sim.setGuard("player", "none");
    sim.applyStrike("opponent", strike(HEAD));
    expect(seen).toEqual(["defended", "taken"]);
  });
});
