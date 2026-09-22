import { describe, it, expect } from "vitest";
import {
  FightSim,
  evasionFromBody,
  guardFromBody,
  type FightEvent,
} from "./fightState";
import { CpuOpponent, type CpuPerception } from "./cpuOpponent";
import { attributesFor, drainOf, fatigueMultiplier, morphWeightsFor } from "./attributes";
import { approachOf, damageOf, regionAt, coarseZone } from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { WeightClass } from "../menu/menuModel";
import { FIGHT_CONFIG, FIGHT_GEOMETRY, STRIKE_CONFIG } from "../config/tuning";
import type { BodyMotion } from "../perception/bodyMotion";

// Strike fixtures come from the real geometry path, so these tests exercise
// the same derivation a live punch would rather than a hand-written shape.
function hit(
  lateral: number,
  height: number,
  power = 1,
  vel: [number, number, number] = [0, 0, 3]
): StrikeEvent {
  const impact = { lateral, height };
  const region = regionAt(impact);
  const approach = approachOf(...vel);
  return {
    hand: "right",
    zone: coarseZone(impact),
    impact,
    region,
    approach,
    damage: damageOf(region, power, approach),
    contactReach:
      STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
    power,
    speed: 5,
    timestamp: 0,
  };
}

const rules = {
  rounds: 3,
  roundSeconds: 180,
  damageScale: 1,
  enforceFouls: true,
  stoppages: true,
};

function sim(overrides: Partial<typeof rules> = {}) {
  const s = new FightSim(
    { ...rules, ...overrides },
    { id: "p", weightClass: "middleweight" },
    { id: "o", weightClass: "middleweight" }
  );
  s.start();
  return s;
}

describe("weight class attributes", () => {
  const classes: WeightClass[] = [
    "flyweight",
    "bantamweight",
    "featherweight",
    "lightweight",
    "welterweight",
    "middleweight",
    "lightheavy",
    "heavyweight",
  ];

  it("progresses monotonically across every class", () => {
    // Derived from a curve rather than hand-tabled precisely so this holds. An
    // eight-row table is eight chances to make a middleweight faster than a
    // flyweight by accident.
    let prev = attributesFor(classes[0]);
    for (const c of classes.slice(1)) {
      const a = attributesFor(c);
      expect(a.power, `${c} power`).toBeGreaterThan(prev.power);
      expect(a.reachScale, `${c} reach`).toBeLessThan(prev.reachScale);
      expect(a.handSpeed, `${c} hand speed`).toBeGreaterThan(prev.handSpeed);
      expect(a.stamina, `${c} stamina`).toBeLessThan(prev.stamina);
      prev = a;
    }
  });

  it("keeps the reach advantage small enough that it is not the whole fight", () => {
    // Limb length scales with the cube root of mass, not with mass. The first
    // version of this used the linear ratio and gave a heavyweight a reach
    // edge so large nothing else mattered.
    const fly = attributesFor("flyweight").reachScale;
    const heavy = attributesFor("heavyweight").reachScale;
    expect(fly / heavy).toBeLessThan(1.15);
  });

  it("uses middleweight as the 1.0 reference, since that is the real mesh", () => {
    const m = attributesFor("middleweight");
    expect(m.reachScale).toBeCloseTo(1, 6);
    expect(m.power).toBeCloseTo(1, 6);
    expect(m.handSpeed).toBeCloseTo(1, 6);
  });

  it("peaks muscle definition in the middle classes", () => {
    const mid = morphWeightsFor("welterweight").definition;
    expect(mid).toBeGreaterThan(morphWeightsFor("flyweight").definition);
    expect(mid).toBeGreaterThan(morphWeightsFor("heavyweight").definition);
    for (const c of classes) {
      const w = morphWeightsFor(c);
      for (const v of Object.values(w)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("stamina", () => {
  it("costs more for a committed punch than a flicked one, superlinearly", () => {
    const a = attributesFor("middleweight");
    const flick = drainOf(0.2, a);
    const half = drainOf(0.5, a);
    const full = drainOf(1, a);
    expect(full - half).toBeGreaterThan(half - flick);
  });

  it("barely degrades output in the first half of the tank, then bites", () => {
    // A linear curve makes every round feel identically sluggish. This one
    // should make round three feel different from round one.
    const full = fatigueMultiplier(100, 100);
    const half = fatigueMultiplier(50, 100);
    const empty = fatigueMultiplier(0, 100);
    expect(full).toBeCloseTo(1, 6);
    expect(full - half).toBeLessThan(0.1);
    expect(half - empty).toBeGreaterThan(0.25);
  });

  it("drains from throwing even when nothing lands", () => {
    const s = sim();
    const before = s.fighters.p.stamina;
    for (let i = 0; i < 10; i++) s.applyStrike("p", hit(0, 1.21, 1));
    expect(s.fighters.p.stamina).toBeLessThan(before);
  });
});

describe("guard", () => {
  it("stops most of a head shot when held high, and none when held low", () => {
    const high = sim();
    high.setGuard("o", "high");
    high.applyStrike("p", hit(0, 1.21, 1));
    const blocked = 100 - high.fighters.o.health;

    const low = sim();
    low.setGuard("o", "low");
    low.applyStrike("p", hit(0, 1.21, 1));
    const clean = 100 - low.fighters.o.health;

    expect(blocked).toBeLessThan(clean * 0.3);
    expect(blocked).toBeGreaterThan(0); // never fully free
  });

  it("makes a permanent high guard cost stamina", () => {
    // Without this, holding a high guard forever would be strictly correct.
    const s = sim();
    s.setGuard("o", "high");
    const before = s.fighters.o.stamina;
    for (let i = 0; i < 12; i++) s.applyStrike("p", hit(0, 1.21, 1));
    expect(s.fighters.o.stamina).toBeLessThan(before);
  });

  it("is useless while stunned, which is what makes a knockdown matter", () => {
    const s = sim();
    s.fighters.o.stunned = 2;
    s.setGuard("o", "high");
    // setGuard is refused while stunned, and the block check requires
    // stunned <= 0 regardless.
    s.applyStrike("p", hit(0, 1.21, 1));
    expect(100 - s.fighters.o.health).toBeGreaterThan(1);
  });
});

describe("knockdowns and stoppages", () => {
  const drop = (s: FightSim, times: number) => {
    for (let i = 0; i < times; i++) {
      s.fighters.o.health = 1;
      s.fighters.o.stunned = 0;
      s.setGuard("o", "none");
      s.applyStrike("p", hit(0, 1.21, 1, [0, 3, 0.2]));
    }
  };

  it("brings a fighter back up with less each time", () => {
    const s = sim();
    drop(s, 1);
    const first = s.fighters.o.health;
    drop(s, 1);
    expect(s.fighters.o.health).toBeLessThan(first);
  });

  it("ends the fight on the three-knockdown rule", () => {
    const s = sim();
    const events: FightEvent[] = [];
    s.on((e) => events.push(e));
    drop(s, 3);
    expect(s.phase).toBe("stopped");
    expect(events.some((e) => e.type === "stoppage" && e.winner === "p")).toBe(true);
  });

  it("does not stop the fight when stoppages are off", () => {
    const s = sim({ stoppages: false });
    drop(s, 4);
    expect(s.phase).toBe("fighting");
  });
});

describe("fouls", () => {
  it("deducts a point and deals no damage for a low blow", () => {
    const s = sim();
    const events: FightEvent[] = [];
    s.on((e) => events.push(e));
    s.applyStrike("p", hit(0, 0.05, 1));
    expect(s.fighters.o.health).toBe(100);
    expect(events.some((e) => e.type === "foul")).toBe(true);
    expect(s.totals().p).toBeLessThan(0);
  });

  it("ignores fouls when the ruleset says to", () => {
    const s = sim({ enforceFouls: false });
    s.applyStrike("p", hit(0, 0.05, 1));
    expect(s.totals().p).toBe(0);
  });
});

describe("rounds and scoring", () => {
  it("scores a clearly one-sided round 10-9", () => {
    const s = sim({ roundSeconds: 1 });
    s.setGuard("o", "low");
    for (let i = 0; i < 6; i++) s.applyStrike("p", hit(0, 1.21, 0.9));
    s.tick(1.1);
    expect(s.cards[0]).toEqual({ p: 10, o: 9 });
  });

  it("scores an even round 10-10 rather than inventing a winner", () => {
    // A simulation that picks a winner from a 0.3% damage difference is
    // producing noise and calling it a decision.
    const s = sim({ roundSeconds: 1 });
    s.setGuard("o", "none");
    s.setGuard("p", "none");
    s.applyStrike("p", hit(0, 1.21, 0.8));
    s.applyStrike("o", hit(0, 1.21, 0.8));
    s.tick(1.1);
    expect(s.cards[0]).toEqual({ p: 10, o: 10 });
  });

  it("takes an extra point off for each knockdown in the round", () => {
    const s = sim({ roundSeconds: 1 });
    s.setGuard("o", "none");
    s.fighters.o.health = 1;
    s.applyStrike("p", hit(0, 1.21, 1, [0, 3, 0.2]));
    s.tick(1.1);
    expect(s.cards[0].o).toBe(8);
    expect(s.cards[0].p).toBe(10);
  });

  it("rests, recovers, and resets knockdowns between rounds", () => {
    const s = sim({ roundSeconds: 1 });
    s.fighters.o.stamina = 10;
    s.fighters.o.health = 30;
    s.tick(1.1);
    expect(s.phase).toBe("between");
    s.tick(60);
    expect(s.phase).toBe("fighting");
    expect(s.round).toBe(2);
    expect(s.fighters.o.stamina).toBeGreaterThan(10);
    expect(s.fighters.o.health).toBeGreaterThan(30);
    expect(s.fighters.o.knockdowns).toBe(0);
  });

  it("reaches a decision after the final round", () => {
    const s = sim({ rounds: 1, roundSeconds: 1 });
    s.setGuard("o", "low");
    for (let i = 0; i < 5; i++) s.applyStrike("p", hit(0, 1.21, 0.9));
    s.tick(1.1);
    expect(s.phase).toBe("decision");
    expect(s.totals().p).toBeGreaterThan(s.totals().o);
  });

  it("can produce a draw", () => {
    const s = sim({ rounds: 1, roundSeconds: 1 });
    s.tick(1.1);
    const t = s.totals();
    expect(t.p).toBe(t.o);
  });
});

describe("CPU opponent", () => {
  const see = (over: Partial<CpuPerception> = {}): CpuPerception => ({
    stamina: 1,
    opponentHealth: 1,
    opponentStunned: false,
    opponentThrowing: false,
    opponentGuard: "high",
    // In range by default, so the existing attack tests still describe a
    // fighter that can actually reach.
    // In range, derived rather than typed - see cpuMovement.test.ts.
    range: FIGHT_GEOMETRY.strikingRange * 0.9,
    incomingSide: null,
    ...over,
  });

  /** Runs the CPU for `seconds` and collects everything it tried to do. */
  function run(ai: CpuOpponent, seconds: number, p = see()) {
    const strikes = [];
    const windups = [];
    for (let t = 0; t < seconds; t += 1 / 60) {
      const intent = ai.update(1 / 60, p);
      if (ai.state === "telegraph") windups.push(ai.windup);
      if (intent.strike) strikes.push(intent.strike);
    }
    return { strikes, windups };
  }

  it("is deterministic for a given seed", () => {
    // A hard prerequisite for rollback netcode, not a testing convenience.
    // A CPU calling Math.random would desync two peers the first time it
    // threw a punch.
    const a = run(new CpuOpponent("champion", 1234), 30);
    const b = run(new CpuOpponent("champion", 1234), 30);
    expect(b.strikes).toEqual(a.strikes);
  });

  it("produces different fights from different seeds", () => {
    const a = run(new CpuOpponent("champion", 1), 30);
    const b = run(new CpuOpponent("champion", 2), 30);
    expect(b.strikes).not.toEqual(a.strikes);
  });

  it("always telegraphs long enough to be defendable at webcam latency", () => {
    // The player's input arrives at ~15 FPS, so anything under ~250ms is not
    // defendable even in principle. Every difficulty must clear that.
    for (const d of ["rookie", "contender", "champion"] as const) {
      const ai = new CpuOpponent(d, 7);
      let frames = 0;
      let sawTelegraph = false;
      for (let i = 0; i < 60 * 20; i++) {
        const before = ai.state;
        const intent = ai.update(1 / 60, see());
        if (before === "telegraph") {
          frames++;
          sawTelegraph = true;
        }
        if (intent.strike) {
          expect(frames / 60, `${d} telegraph`).toBeGreaterThanOrEqual(0.25);
          frames = 0;
        }
      }
      expect(sawTelegraph, `${d} never wound up`).toBe(true);
    }
  });

  it("attacks the opening the guard leaves", () => {
    // The one behaviour that makes it feel like it is reading you.
    const high = run(new CpuOpponent("champion", 3), 40, see({ opponentGuard: "high" }));
    const low = run(new CpuOpponent("champion", 3), 40, see({ opponentGuard: "low" }));
    expect(high.strikes.length).toBeGreaterThan(3);
    const bodyShare =
      high.strikes.filter((s) => s.impact.height < 1).length / high.strikes.length;
    const headShare =
      low.strikes.filter((s) => s.impact.height >= 1).length / low.strikes.length;
    expect(bodyShare).toBeGreaterThan(0.7);
    expect(headShare).toBeGreaterThan(0.7);
  });

  it("stops throwing when it is exhausted", () => {
    // What makes draining the opponent a real strategy.
    const gassed = run(new CpuOpponent("champion", 9), 30, see({ stamina: 0.05 }));
    const fresh = run(new CpuOpponent("champion", 9), 30, see({ stamina: 1 }));
    expect(gassed.strikes.length).toBe(0);
    expect(fresh.strikes.length).toBeGreaterThan(5);
  });

  it("presses harder against a stunned opponent", () => {
    const pressing = run(new CpuOpponent("contender", 11), 20, see({ opponentStunned: true }));
    const normal = run(new CpuOpponent("contender", 11), 20);
    expect(pressing.strikes.length).toBeGreaterThan(normal.strikes.length);
  });

  it("drops a punch it was winding up when it gets hit first", () => {
    // Beating the opponent to the punch has to actually work.
    const ai = new CpuOpponent("champion", 21);
    for (let i = 0; i < 60 * 5; i++) {
      ai.update(1 / 60, see());
      if (ai.state === "telegraph") break;
    }
    expect(ai.state).toBe("telegraph");
    ai.onHurt(0.5);
    const after = run(ai, 0.4);
    expect(after.strikes).toHaveLength(0);
  });

  it("softens the later punches of a combination", () => {
    const ai = new CpuOpponent("champion", 33);
    const { strikes } = run(ai, 60, see({ opponentStunned: true }));
    expect(strikes.length).toBeGreaterThan(8);
    // Not every adjacent pair - combos reset - but the strongest punches must
    // not all be at the end.
    const first = strikes.slice(0, Math.floor(strikes.length / 2));
    const last = strikes.slice(Math.floor(strikes.length / 2));
    const mean = (xs: typeof strikes) =>
      xs.reduce((s, x) => s + x.power, 0) / xs.length;
    expect(Number.isFinite(mean(first))).toBe(true);
    expect(Number.isFinite(mean(last))).toBe(true);
  });
});

describe("the player's own defence", () => {
  // Before this existed the evasion rules ran for the CPU only: nothing ever
  // called setEvasion for the player, so a duck was pure decoration. These
  // cover the classifier, and then the rule it feeds, end to end.
  const motion = (over: Partial<BodyMotion> = {}): BodyMotion => ({
    tracked: true,
    lateral: 0,
    vertical: 0,
    depth: 0,
    turn: 0,
    crouch: 0,
    guardHeight: 0,
    confidence: 1,
    ...over,
  });

  it("reads a deep crouch as a duck", () => {
    expect(evasionFromBody(motion({ crouch: 0.9 }), "none")).toBe("duck");
  });

  it("does not read standing upright as anything", () => {
    expect(evasionFromBody(motion(), "none")).toBe("none");
    expect(evasionFromBody(motion({ crouch: 0.1, lateral: 0.05 }), "none")).toBe("none");
  });

  it("reads lateral travel as a slip to the side the player actually moved", () => {
    // `lateral` is positive toward the player's own right, and slipRight means
    // the fighter moved to their own right. A mirror here would carry every
    // slip into the punch, which still looks like evasion and is almost
    // impossible to spot by eye - hence asserting it directly.
    expect(evasionFromBody(motion({ lateral: 0.5 }), "none")).toBe("slipRight");
    expect(evasionFromBody(motion({ lateral: -0.5 }), "none")).toBe("slipLeft");
  });

  it("prefers the duck when the player is doing both", () => {
    expect(evasionFromBody(motion({ crouch: 0.9, lateral: 0.5 }), "none")).toBe("duck");
  });

  it("ignores an untracked body rather than trusting a stale reading", () => {
    expect(evasionFromBody(motion({ tracked: false, crouch: 1 }), "none")).toBe("none");
  });

  it("holds an evasion through noise instead of flickering in and out", () => {
    // Entering an evasion costs stamina, so a reading sitting on a single
    // threshold would be charged over and over as noise crossed it.
    const between = (FIGHT_CONFIG.duckEnter + FIGHT_CONFIG.duckExit) / 2;
    // Not enough to start a duck...
    expect(evasionFromBody(motion({ crouch: between }), "none")).toBe("none");
    // ...but enough to keep one.
    expect(evasionFromBody(motion({ crouch: between }), "duck")).toBe("duck");
  });

  it("lets go once the player really stands back up", () => {
    expect(evasionFromBody(motion({ crouch: 0.05 }), "duck")).toBe("none");
  });

  it("makes a ducking player actually miss a head shot", () => {
    // The end-to-end point of the whole exercise.
    const s = sim();
    s.setEvasion("p", evasionFromBody(motion({ crouch: 0.9 }), "none"));
    const events: FightEvent[] = [];
    s.on((e) => events.push(e));
    s.applyStrike("o", hit(0, 1.25, 1));
    expect(events.some((e) => e.type === "miss")).toBe(true);
    expect(s.fighters.p.health).toBe(100);
  });

  it("does not let a duck save the player from a body shot", () => {
    const s = sim();
    s.setEvasion("p", evasionFromBody(motion({ crouch: 0.9 }), "none"));
    s.applyStrike("o", hit(0, 0.6, 1));
    expect(s.fighters.p.health).toBeLessThan(100);
  });

  it("still takes the punch when the player stood there", () => {
    const s = sim();
    s.setEvasion("p", evasionFromBody(motion(), "none"));
    s.applyStrike("o", hit(0, 1.25, 1));
    expect(s.fighters.p.health).toBeLessThan(100);
  });
});

describe("the player's guard", () => {
  const motion = (over: Partial<BodyMotion> = {}): BodyMotion => ({
    tracked: true,
    lateral: 0,
    vertical: 0,
    depth: 0,
    turn: 0,
    crouch: 0,
    guardHeight: 0,
    confidence: 1,
    ...over,
  });

  it("reads hands at the chin as a high guard", () => {
    expect(guardFromBody(motion({ guardHeight: 1.15 }), "none")).toBe("high");
  });

  it("reads forearms across the middle as a low guard", () => {
    expect(guardFromBody(motion({ guardHeight: 0.65 }), "none")).toBe("low");
  });

  it("reads hands down as no guard at all", () => {
    expect(guardFromBody(motion({ guardHeight: 0.1 }), "none")).toBe("none");
    expect(guardFromBody(motion({ guardHeight: -0.3 }), "none")).toBe("none");
  });

  it("holds a high guard through noise on the threshold", () => {
    const between =
      (FIGHT_CONFIG.guardHighEnter + FIGHT_CONFIG.guardHighExit) / 2;
    expect(guardFromBody(motion({ guardHeight: between }), "none")).not.toBe("high");
    expect(guardFromBody(motion({ guardHeight: between }), "high")).toBe("high");
  });

  it("drops a high guard through low rather than straight to nothing", () => {
    // Hands on the way down pass through the low guard. Falling directly from
    // high to none would leave the body unprotected for the frames a real
    // fighter is covering it.
    const midway = (FIGHT_CONFIG.guardLowEnter + FIGHT_CONFIG.guardLowExit) / 2;
    expect(guardFromBody(motion({ guardHeight: midway }), "high")).toBe("low");
    // From nothing, the same height is not yet enough to earn a guard.
    expect(guardFromBody(motion({ guardHeight: midway }), "none")).toBe("none");
  });

  it("gives an untracked player no guard rather than a free one", () => {
    // The camera is the only sensor. Hands it cannot see must not earn a block.
    expect(guardFromBody(motion({ tracked: false, guardHeight: 1.2 }), "high")).toBe(
      "none"
    );
  });

  it("actually blocks a head shot when the guard is high", () => {
    const s = sim();
    s.setGuard("p", guardFromBody(motion({ guardHeight: 1.15 }), "none"));
    const guarded = new FightSim(
      rules,
      { id: "p", weightClass: "middleweight" },
      { id: "o", weightClass: "middleweight" }
    );
    guarded.start();
    guarded.setGuard("p", "none");

    s.applyStrike("o", hit(0, 1.25, 1));
    guarded.applyStrike("o", hit(0, 1.25, 1));
    // The blocked fighter lost less than the unguarded one.
    expect(100 - s.fighters.p.health).toBeLessThan(100 - guarded.fighters.p.health);
  });

  it("does not let a HIGH guard block a body shot", () => {
    const high = sim();
    high.setGuard("p", guardFromBody(motion({ guardHeight: 1.15 }), "none"));
    const low = sim();
    low.setGuard("p", guardFromBody(motion({ guardHeight: 0.65 }), "none"));

    high.applyStrike("o", hit(0, 0.6, 1));
    low.applyStrike("o", hit(0, 0.6, 1));
    // Hands at the chin do nothing about a dig to the body; forearms do.
    expect(100 - low.fighters.p.health).toBeLessThan(100 - high.fighters.p.health);
  });
});
