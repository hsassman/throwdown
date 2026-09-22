import { describe, it, expect } from "vitest";
import { FightSim, evades, type Evasion, type FightEvent } from "./fightState";
import { CpuOpponent, type CpuPerception } from "./cpuOpponent";
import {
  CPU_CONFIG,
  FIGHT_CONFIG,
  FIGHT_GEOMETRY,
  STRIKE_CONFIG,
} from "../config/tuning";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
  type ImpactPoint,
} from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";

// The opponent that moves.
//
// Two things are being checked here, and they are different in kind. The
// `evades` rules are a small pure function and are pinned exactly. The CPU's
// behaviour is stochastic, so it is checked statistically - "a champion slips
// more often than a rookie" rather than "the third punch is slipped" - which
// is the only kind of assertion that survives a tuning change without being
// rewritten to match whatever the code now does.

/**
 * A strike built from a landing point, so the fixture runs the same derivation
 * the live resolver does.
 *
 * This matters more than usual here: the whole evasion rule turns on the
 * relationship between `impact.lateral` and `zone.lane`, and a test that
 * hand-wrote both could not catch them disagreeing - which is exactly the bug
 * the mirror below is there to prevent.
 */
function strike(
  impact: ImpactPoint,
  velocity: [number, number, number] = [0, 0, 3],
  power = 1
): StrikeEvent {
  const region = regionAt(impact);
  const approach = approachOf(...velocity);
  return {
    hand: "right",
    zone: coarseZone(impact),
    impact,
    region,
    approach,
    damage: damageOf(region, power, approach),
    contactReach: STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
    power,
    speed: 4,
    timestamp: 0,
  };
}

/** A punch to the head, on the puncher's right (= the target's own left). */
const toTargetsLeft = () => strike({ lateral: 0.3, height: 1.24 });
const toTargetsRight = () => strike({ lateral: -0.3, height: 1.24 });
const downTheMiddle = () => strike({ lateral: 0, height: 1.21 });

describe("the evasion rule", () => {
  it("slips AWAY from a punch, not into it", () => {
    // The single most important assertion in this file. A lane of "right" is
    // the puncher's right, which arrives on the target's own left - so moving
    // to your own left carries you into it. Getting this backwards would still
    // have produced a figure leaning convincingly out of the way on screen
    // while eating every punch, which is close to undebuggable by eye.
    expect(toTargetsLeft().zone.lane).toBe("right");
    expect(evades("slipRight", toTargetsLeft())).toBe(true);
    expect(evades("slipLeft", toTargetsLeft())).toBe(false);

    expect(toTargetsRight().zone.lane).toBe("left");
    expect(evades("slipLeft", toTargetsRight())).toBe(true);
    expect(evades("slipRight", toTargetsRight())).toBe(false);
  });

  it("takes a punch down the middle off the line either way", () => {
    expect(evades("slipLeft", downTheMiddle())).toBe(true);
    expect(evades("slipRight", downTheMiddle())).toBe(true);
  });

  it("does not slip a HOOK", () => {
    // A hook curves around the outside and arrives where the head has just
    // moved to. A slip that beat every arc would make the guard pointless, and
    // would remove the one thing that punishes slipping at the wrong moment.
    const hook = strike({ lateral: 0.3, height: 1.24 }, [3, 0, 0.4]);
    expect(hook.approach.arc).toBe("hooking");
    expect(evades("slipRight", hook)).toBe(false);
    // The duck still gets under it, which is what makes them different moves.
    expect(evades("duck", hook)).toBe(true);
  });

  it("slips a rising punch, because an uppercut has already picked its line", () => {
    const upper = strike({ lateral: 0, height: 1.21 }, [0.2, 3, 0.6]);
    expect(upper.approach.arc).toBe("rising");
    expect(evades("slipLeft", upper)).toBe(true);
  });

  it("never evades a body shot by moving the head", () => {
    const liver = strike({ lateral: -0.26, height: 0.56 });
    expect(liver.zone.height).toBe("body");
    for (const e of ["slipLeft", "slipRight", "duck"] as Evasion[]) {
      expect(evades(e, liver)).toBe(false);
    }
  });

  it("evades nothing when not evading", () => {
    expect(evades("none", downTheMiddle())).toBe(false);
  });
});


function sim() {
  return new FightSim(
    {
      rounds: 3,
      roundSeconds: 180,
      damageScale: 1,
      enforceFouls: true,
      stoppages: true,
    },
    { id: "p", weightClass: "middleweight" },
    { id: "o", weightClass: "middleweight" }
  );
}

describe("evasion in the fight", () => {
  it("a slipped punch does no damage and reports itself as a slip", () => {
    const s = sim();
    s.start();
    const events: FightEvent[] = [];
    s.on((e) => events.push(e));
    s.setEvasion("o", "slipRight");

    const before = s.fighters.o.health;
    s.applyStrike("p", toTargetsLeft());

    expect(s.fighters.o.health).toBe(before);
    expect(events.some((e) => e.type === "miss")).toBe(true);
    expect(events.some((e) => e.type === "land")).toBe(false);
  });

  it("still costs the PUNCHER stamina, because they threw it", () => {
    // A punch that misses is the expensive kind. If evasion refunded the
    // thrower, slipping would drain the slipper and leave the aggressor fresh,
    // which is backwards.
    const s = sim();
    s.start();
    s.setEvasion("o", "slipRight");
    const before = s.fighters.p.stamina;
    s.applyStrike("p", toTargetsLeft());
    expect(s.fighters.p.stamina).toBeLessThan(before);
  });

  it("charges the evader once for the move, not once per frame", () => {
    const s = sim();
    s.start();
    const fresh = s.fighters.o.stamina;
    s.setEvasion("o", "slipLeft");
    const afterFirst = s.fighters.o.stamina;
    expect(afterFirst).toBeCloseTo(fresh - FIGHT_CONFIG.evadeStaminaCost, 6);
    // Re-asserting the same evasion is the state being held, not a new one.
    s.setEvasion("o", "slipLeft");
    s.setEvasion("o", "slipLeft");
    expect(s.fighters.o.stamina).toBeCloseTo(afterFirst, 6);
  });

  it("does not let a stunned fighter slip", () => {
    // The window after a knockdown is the whole point of a knockdown. A
    // fighter who could still evade through it would make being dropped
    // almost free.
    const s = sim();
    s.start();
    s.fighters.o.stunned = 2;
    s.setEvasion("o", "slipRight");
    expect(s.fighters.o.evasion).toBe("none");
    const before = s.fighters.o.health;
    s.applyStrike("p", toTargetsLeft());
    expect(s.fighters.o.health).toBeLessThan(before);
  });

  it("a foul is still a foul, whether or not it was slipped", () => {
    const s = sim();
    s.start();
    const events: FightEvent[] = [];
    s.on((e) => events.push(e));
    s.setEvasion("o", "duck");
    s.applyStrike("p", strike({ lateral: 0, height: -0.4 }));
    expect(events.some((e) => e.type === "foul")).toBe(true);
  });
});


const see = (over: Partial<CpuPerception> = {}): CpuPerception => ({
  stamina: 1,
  opponentHealth: 1,
  opponentStunned: false,
  opponentThrowing: false,
  opponentGuard: "high",
  // In the pocket: inside striking range, but not inside the CPU's own guard.
  // Derived from the same geometry the CPU reads, not typed. A literal here
  // drifted out of the pocket the moment the ranges were re-anchored on where
  // the fighters really stand, and the tests then measured a fighter backing
  // out of a clinch for the whole run rather than the behaviour they name.
  range: FIGHT_GEOMETRY.strikingRange * 0.9,
  incomingSide: null,
  ...over,
});

/** Steps the CPU at a fixed 60 Hz and collects what it did. */
function run(ai: CpuOpponent, seconds: number, p: CpuPerception = see()) {
  const dt = 1 / 60;
  const strikes: number[] = [];
  const evasions: Evasion[] = [];
  const footwork: string[] = [];
  for (let t = 0; t < seconds; t += dt) {
    const intent = ai.update(dt, p);
    if (intent.strike) strikes.push(t);
    if (intent.evasion && intent.evasion !== "none") evasions.push(intent.evasion);
    if (footwork[footwork.length - 1] !== ai.footwork) footwork.push(ai.footwork);
  }
  return { strikes, evasions, footwork };
}

describe("footwork", () => {
  it("does not throw from outside its own reach", () => {
    // An opponent that lands blows from across the ring is the single most
    // obvious way this reads as fake.
    const far = run(
      new CpuOpponent("champion", 1),
      20,
      see({ range: FIGHT_GEOMETRY.strikingRange * 2 })
    );
    expect(far.strikes.length).toBe(0);
    // And the same fighter at the same tempo, in range, does throw - so the
    // test above is measuring the range gate rather than a broken CPU.
    expect(run(new CpuOpponent("champion", 1), 20).strikes.length).toBeGreaterThan(5);
  });

  it("closes the distance instead of standing there", () => {
    const ai = new CpuOpponent("contender", 2);
    run(ai, 2, see({ range: FIGHT_GEOMETRY.preferredRange * 1.6 }));
    expect(ai.stance.depth).toBeGreaterThan(0.2);
  });

  it("does not walk into a player who steps in while it is advancing", () => {
    // The closed loop, with both halves of the gap moving.
    //
    // The CPU cannot close on its own: in the pocket it only circles or holds,
    // and it advances only when the range is above `preferredRange`. But the
    // gap has two owners - the CPU's `stance.depth` and the player's measured
    // `depth` - and the player's half is not subject to any rule at all. So a
    // player who charges forward while the CPU is mid-advance closes both
    // halves at once, and the CPU's footwork state is held for up to 1.6
    // seconds before it reconsiders. Its depth integrator was bounded only by
    // `depthLimit` (1.4 torso units against a starting gap of 1.66), so it
    // kept walking, and the two figures ended up inside one another.
    //
    // The player here steps in to 0.6 torso units, which on its own leaves a
    // legal gap. Anything below the bar is therefore the CPU's doing.
    const STEP_SPEED = 1.1; // torso units per second, the player walking in
    const stepIn = (t: number) =>
      t < 3 ? -0.5 : Math.min(0.6, -0.5 + (t - 3) * STEP_SPEED);
    // The ceiling is applied against a range measured one frame earlier, so
    // the player can cross one frame of their own travel inside it before the
    // constraint sees it. That is the whole of the permitted slack.
    // 1e-6 is float slop from accumulating `t` at 1/60, not a tolerance on
    // the rule - the measured value lands on the bar to fifteen decimal places.
    const bar = FIGHT_GEOMETRY.clinchRange - STEP_SPEED / 60 - 1e-6;

    for (const id of ["rookie", "contender", "champion"] as const) {
      for (const seed of [1, 7, 11, 23]) {
        const ai = new CpuOpponent(id, seed);
        let closest = Infinity;
        let advanced = false;
        for (let t = 0; t < 12; t += 1 / 60) {
          const range = FIGHT_GEOMETRY.neutralRange - stepIn(t) - ai.stance.depth;
          if (t > 2.9 && ai.stance.depth > 0.2) advanced = true;
          if (t >= 3) closest = Math.min(closest, range);
          ai.update(1 / 60, see({ range }));
        }
        // It really was coming forward when the player arrived, so the bar
        // below measures a clamp rather than a fighter that never moved.
        expect(advanced, `${id}/${seed} was not advancing`).toBe(true);
        // A hard constraint, so the bar is the constraint itself rather than
        // a percentage around it.
        expect(
          closest,
          `${id}/${seed} closed to ${closest.toFixed(3)}, bar ${bar.toFixed(3)}`
        ).toBeGreaterThanOrEqual(bar);
      }
    }
  });

  it("still closes to somewhere it can punch from", () => {
    // The clamp must bound the advance, not prevent it. Without this pairing,
    // "never walks into the player" would be satisfied by an opponent that
    // stayed on the far side of the ring.
    const ai = new CpuOpponent("contender", 12);
    let closest = Infinity;
    for (let t = 0; t < 30; t += 1 / 60) {
      const range = FIGHT_GEOMETRY.neutralRange * 1.8 - ai.stance.depth;
      closest = Math.min(closest, range);
      ai.update(1 / 60, see({ range }));
    }
    expect(closest).toBeLessThan(FIGHT_GEOMETRY.strikingRange);
  });

  it("backs out when the opponent is inside its guard", () => {
    const ai = new CpuOpponent("contender", 3);
    run(ai, 2, see({ range: FIGHT_GEOMETRY.clinchRange * 0.4 }));
    expect(ai.stance.depth).toBeLessThan(0);
  });

  it("gives ground when hurt", () => {
    const ai = new CpuOpponent("contender", 4);
    run(ai, 1); // settle
    const before = ai.stance.depth;
    ai.onHurt(0.8);
    run(ai, 0.7);
    expect(ai.stance.depth).toBeLessThan(before);
  });

  it("circles rather than standing still in the pocket", () => {
    const ai = new CpuOpponent("contender", 5);
    run(ai, 12);
    expect(Math.abs(ai.stance.lateral)).toBeGreaterThan(0.05);
  });

  it("turns around at the edge instead of walking out of the ring", () => {
    // The bound has to hold for a long run, not just a short one: an
    // integrator with a clamp still pins to the clamp, and a fighter glued to
    // the edge of the stage is as broken as one that walked off it.
    const ai = new CpuOpponent("champion", 6);
    const seen: number[] = [];
    for (let i = 0; i < 60 * 40; i++) {
      ai.update(1 / 60, see());
      seen.push(ai.stance.lateral);
    }
    expect(Math.max(...seen.map(Math.abs))).toBeLessThanOrEqual(
      CPU_CONFIG.lateralLimit + 1e-6
    );
    // It genuinely used the room, rather than passing by never moving.
    expect(Math.max(...seen)).toBeGreaterThan(0.1);
    expect(Math.min(...seen)).toBeLessThan(-0.1);
  });

  it("moves the body smoothly rather than teleporting it", () => {
    // The stance is what the render layer draws directly. A step function here
    // is a figure that snaps between positions.
    const ai = new CpuOpponent("champion", 7);
    let previous = ai.stance.lateral;
    let worst = 0;
    for (let i = 0; i < 60 * 20; i++) {
      ai.update(1 / 60, see());
      worst = Math.max(worst, Math.abs(ai.stance.lateral - previous));
      previous = ai.stance.lateral;
    }
    expect(worst).toBeLessThan(0.08);
  });
});

describe("head movement", () => {
  it("slips when the player is throwing, and not otherwise", () => {
    const quiet = run(new CpuOpponent("champion", 8), 20);
    expect(quiet.evasions.length).toBe(0);
    const busy = run(new CpuOpponent("champion", 8), 20, see({ opponentThrowing: true }));
    expect(busy.evasions.length).toBeGreaterThan(3);
  });

  it("slips away from the side it has been read on", () => {
    const busy = run(
      new CpuOpponent("champion", 9),
      30,
      see({ opponentThrowing: true, incomingSide: "left" })
    );
    const slips = busy.evasions.filter((e) => e !== "duck");
    expect(slips.length).toBeGreaterThan(2);
    // Punches arriving on its left are answered by moving right. Every one of
    // them - this is a rule, not a tendency.
    expect(slips.every((e) => e === "slipRight")).toBe(true);
  });

  it("cannot hold a slip as permanent invulnerability", () => {
    const ai = new CpuOpponent("champion", 10);
    const p = see({ opponentThrowing: true });
    let evading = 0;
    const steps = 60 * 30;
    for (let i = 0; i < steps; i++) {
      ai.update(1 / 60, p);
      if (ai.evasion !== "none") evading++;
    }
    // The commitment window and the cooldown together bound the duty cycle. A
    // fighter evading most of the time is not a fighter, it is a wall.
    const duty = evading / steps;
    expect(duty).toBeLessThan(0.6);
    expect(duty).toBeGreaterThan(0.05);
  });

  it("a rookie covers up where a champion slips", () => {
    const p = see({ opponentThrowing: true });
    const rookie = run(new CpuOpponent("rookie", 11), 30, p).evasions.length;
    const champion = run(new CpuOpponent("champion", 11), 30, p).evasions.length;
    expect(champion).toBeGreaterThan(rookie);
  });

  it("stops evading when hurt", () => {
    const ai = new CpuOpponent("champion", 12);
    const p = see({ opponentThrowing: true });
    for (let i = 0; i < 600; i++) {
      ai.update(1 / 60, p);
      if (ai.evasion !== "none") break;
    }
    expect(ai.evasion).not.toBe("none");
    ai.onHurt(0.5);
    expect(ai.evasion).toBe("none");
  });
});

describe("the range scale matches where the fighters really stand", () => {
  // The bug this guards against was not a wrong rule, it was a wrong unit. The
  // CPU had a striking range of 0.55 and a neutral gap of 1.0, both in torso
  // units, while the figures were placed 1.66 torso units apart in the scene.
  // Every rule worked exactly as written and the opponent still threw punches
  // from across the ring, because it believed it had already walked up.

  it("starts the fight at exactly reaching distance", () => {
    // TARGET_CONFIG.distance was derived as the gap at which a committed punch
    // just reaches. The CPU's striking range is the same statement in the other
    // unit, so they must agree to the last digit, not merely be close.
    expect(FIGHT_GEOMETRY.strikingRange).toBe(FIGHT_GEOMETRY.neutralRange);
  });

  it("orders the bands the way a fight does", () => {
    expect(FIGHT_GEOMETRY.clinchRange).toBeLessThan(FIGHT_GEOMETRY.strikingRange);
    expect(FIGHT_GEOMETRY.strikingRange).toBeLessThan(
      FIGHT_GEOMETRY.preferredRange
    );
  });

  it("leaves the CPU able to actually cover the gap it wants to hold", () => {
    // It steps out to `preferredRange` and back in to strike, so the round
    // trip has to fit inside the travel its own footwork is clamped to.
    const trip = FIGHT_GEOMETRY.preferredRange - FIGHT_GEOMETRY.strikingRange;
    expect(trip).toBeGreaterThan(0.05);
    expect(trip).toBeLessThan(CPU_CONFIG.depthLimit);
  });

  it("throws from the starting position, without having to walk in first", () => {
    // The end-to-end consequence, measured rather than reasoned about: an
    // opponent placed where the scene puts it can reach the player.
    const ai = new CpuOpponent("contender", 31);
    const thrown = run(
      ai,
      20,
      see({ range: FIGHT_GEOMETRY.neutralRange })
    ).strikes.length;
    expect(thrown).toBeGreaterThan(3);
  });
});

describe("determinism", () => {
  it("two opponents with the same seed fight the same fight", () => {
    // The prerequisite for rollback netcode, asserted over the whole output
    // rather than just the punches: footwork and head movement are now part of
    // the state a replay has to reproduce.
    const a = run(new CpuOpponent("champion", 4242), 25, see({ opponentThrowing: true }));
    const b = run(new CpuOpponent("champion", 4242), 25, see({ opponentThrowing: true }));
    expect(a).toEqual(b);
  });

  it("does not reach for Math.random for its punch jitter", () => {
    // The jitter feeds the approach vector, which feeds the arc, which feeds
    // the rising-chin damage bonus. It is not cosmetic, so it belongs to the
    // seeded generator like everything else.
    const jitters = (seed: number) => {
      const ai = new CpuOpponent("champion", seed);
      const out: number[] = [];
      for (let i = 0; i < 60 * 30; i++) {
        const intent = ai.update(1 / 60, see());
        if (intent.strike) out.push(intent.strike.jitter);
      }
      return out;
    };
    const first = jitters(77);
    expect(first.length).toBeGreaterThan(5);
    expect(jitters(77)).toEqual(first);
    for (const j of first) {
      expect(j).toBeGreaterThanOrEqual(-0.5);
      expect(j).toBeLessThanOrEqual(0.5);
    }
  });
});
