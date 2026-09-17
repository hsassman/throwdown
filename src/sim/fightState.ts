// The fight simulation: health, stamina, guard, knockdowns, rounds, scoring.
//
// Pure logic. No three.js, no React, no landmarks. It is handed resolved
// strikes and a clock, and it produces state plus a stream of events. That
// separation is what lets the whole thing be tested without a camera, and it
// is the layer docs/ARCHITECTURE.md calls "simulation".
//
// SCORING IS THE TEN-POINT MUST
//
// The universal system in boxing and MMA: the round winner gets 10, the loser
// 9, minus one more for each knockdown, floor of 6. It is worth using the real
// one rather than inventing a points system, because it is the thing players
// already know how to read, and because it produces draws and split decisions
// naturally — which is what makes a decision feel earned rather than arbitrary.

import {
  attributesFor,
  drainOf,
  fatigueMultiplier,
  type FighterAttributes,
} from "./attributes";
import type { WeightClass } from "../menu/menuModel";
import type { StrikeEvent } from "../perception/strikeResolver";
import { FIGHT_CONFIG } from "../config/tuning";

/** What a fighter is protecting. */
export type GuardPosture = "high" | "low" | "none";

/**
 * A committed head movement, in the EVADING fighter's own frame.
 *
 * Left and right are that fighter's own left and right, not the puncher's.
 * `ImpactPoint.lateral` is expressed from the PUNCHER's point of view (see
 * strikeGeometry.ts), so the two frames are mirrored and the conversion has to
 * happen exactly once, in `evades` below, where it is tested. Getting it
 * backwards would make every slip move the head INTO the punch, which would
 * still look like evasion and would be almost impossible to spot by eye.
 */
export type Evasion = "none" | "slipLeft" | "slipRight" | "duck";

/**
 * Whether a committed head movement takes the target off the line of a strike.
 *
 * The rules, and why they are these rules:
 *
 *   A slip moves the head sideways off the line of a punch travelling toward
 *   it. That beats a STRAIGHT or RISING punch, which have already committed to
 *   a line. It does NOT beat a HOOK, which curves around the outside and
 *   arrives where the head has just moved to — slipping into a hook is how
 *   people get knocked out, and a slip that beat everything would make the
 *   guard pointless.
 *
 *   A duck takes the head below every punch aimed at it, whatever its arc, and
 *   does nothing at all about a body shot. That makes duck and slip genuinely
 *   different choices rather than two names for the same move: the duck is
 *   the stronger answer to the head and the total non-answer to the body.
 *
 * Nothing here decides whether the punch was THROWN accurately — perception
 * already resolved that. This only asks whether the target was still there.
 */
export function evades(evasion: Evasion, strike: StrikeEvent): boolean {
  if (evasion === "none") return false;
  // Both slips and ducks are head movement. A body shot is not evaded by
  // moving the head, and pretending otherwise would let the AI slip a liver
  // shot, which reads as the game cheating.
  if (strike.zone.height !== "head") return false;
  if (evasion === "duck") return true;

  if (strike.approach.arc === "hooking" || strike.approach.arc === "falling") return false;

  // The mirror. A lane of "right" is the PUNCHER's right, which arrives on the
  // target's own LEFT — so moving to your own left carries you into it, and
  // moving to your own right carries you off it.
  const arrivesOnTargetsLeft = strike.zone.lane === "right";
  const arrivesOnTargetsRight = strike.zone.lane === "left";
  if (evasion === "slipLeft") return !arrivesOnTargetsLeft;
  return !arrivesOnTargetsRight;
}

export interface FighterState {
  id: string;
  weightClass: WeightClass;
  attrs: FighterAttributes;
  /** 0-100. Reaching 0 is a knockdown, not an instant loss. */
  health: number;
  stamina: number;
  maxStamina: number;
  guard: GuardPosture;
  /** Knockdowns taken THIS round — three ends it. */
  knockdowns: number;
  /** Knockdowns taken across the whole fight, for the scorecard. */
  totalKnockdowns: number;
  /** Seconds left of being unable to act. */
  stunned: number;
  /** Committed head movement, if any. Set by whoever drives this fighter —
   *  the AI today, the player's own tracked dodges later. The sim only reads
   *  it; it never decides to evade on a fighter's behalf. */
  evasion: Evasion;
  landed: number;
  thrown: number;
  /** Damage dealt this round, for scoring a round nobody was dropped in. */
  roundDamage: number;
}

export type FightPhase = "idle" | "fighting" | "between" | "stopped" | "decision";

export type FightEvent =
  | { type: "land"; target: string; damage: number; region: string; power: number }
  | { type: "block"; target: string; region: string }
  | { type: "miss"; target: string; evasion: Evasion; region: string }
  | { type: "foul"; by: string; region: string }
  | { type: "knockdown"; target: string; count: number }
  | { type: "roundEnd"; round: number; scores: Record<string, number> }
  | { type: "stoppage"; winner: string; reason: "ko" | "tko" }
  | { type: "decision"; winner: string | null; cards: Record<string, number> };

export interface FightRules {
  rounds: number;
  roundSeconds: number;
  damageScale: number;
  enforceFouls: boolean;
  stoppages: boolean;
}

function freshFighter(id: string, weightClass: WeightClass): FighterState {
  const attrs = attributesFor(weightClass);
  return {
    id,
    weightClass,
    attrs,
    health: 100,
    stamina: attrs.stamina,
    maxStamina: attrs.stamina,
    guard: "high",
    knockdowns: 0,
    totalKnockdowns: 0,
    stunned: 0,
    evasion: "none",
    landed: 0,
    thrown: 0,
    roundDamage: 0,
  };
}

export class FightSim {
  readonly rules: FightRules;
  fighters: Record<string, FighterState>;
  phase: FightPhase = "idle";
  round = 1;
  clock: number;
  /** Per-round, per-fighter scores. */
  cards: Record<string, number>[] = [];
  /** Points deducted for fouls, per fighter. */
  deductions: Record<string, number> = {};

  private listeners = new Set<(e: FightEvent) => void>();
  private betweenTimer = 0;

  constructor(
    rules: FightRules,
    a: { id: string; weightClass: WeightClass },
    b: { id: string; weightClass: WeightClass }
  ) {
    this.rules = rules;
    this.fighters = {
      [a.id]: freshFighter(a.id, a.weightClass),
      [b.id]: freshFighter(b.id, b.weightClass),
    };
    this.deductions = { [a.id]: 0, [b.id]: 0 };
    this.clock = rules.roundSeconds;
  }

  on(cb: (e: FightEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: FightEvent) {
    for (const cb of this.listeners) cb(e);
  }

  get ids(): string[] {
    return Object.keys(this.fighters);
  }

  private other(id: string): FighterState {
    const o = this.ids.find((k) => k !== id);
    return this.fighters[o!];
  }

  start(): void {
    this.phase = "fighting";
  }

  /**
   * Applies a resolved strike from `byId` to the other fighter.
   *
   * Takes the StrikeEvent from the perception layer directly, which is the
   * whole payoff of the phase-2 rework: it already carries a region and a
   * damage value derived from geometry, so this layer does no classification
   * and cannot fail to understand a punch it has no name for.
   */
  applyStrike(byId: string, strike: StrikeEvent): void {
    if (this.phase !== "fighting") return;
    const attacker = this.fighters[byId];
    const target = this.other(byId);
    if (!attacker || !target) return;

    attacker.thrown++;

    // Throwing costs gas whether or not it lands. That is the point of
    // stamina: a missed power shot is worse than a landed jab.
    const fatigue = fatigueMultiplier(attacker.stamina, attacker.maxStamina);
    attacker.stamina = Math.max(
      0,
      attacker.stamina - drainOf(strike.power, attacker.attrs)
    );

    if (!strike.region.legal) {
      if (this.rules.enforceFouls) {
        this.deductions[byId] += FIGHT_CONFIG.foulDeduction;
        this.emit({ type: "foul", by: byId, region: strike.region.id });
      }
      return;
    }

    // Evasion beats guard, and is checked first. A punch that missed cannot
    // also have been blocked, and the two produce different events because
    // they are different things to watch: a block is a hit you absorbed, a
    // miss is a hit that never arrived. A stunned fighter evades nothing —
    // the same rule the guard follows, and the reason a knockdown is a real
    // turning point.
    if (target.stunned <= 0 && evades(target.evasion, strike)) {
      this.emit({
        type: "miss",
        target: target.id,
        evasion: target.evasion,
        region: strike.region.id,
      });
      return;
    }

    // Guard. A high guard covers the head, a low guard the body — the classic
    // trade, and the reason feinting upstairs to go downstairs works at all.
    // A stunned fighter's guard is down, which is what makes a knockdown a
    // real turning point rather than a cosmetic pause.
    const covered =
      target.stunned <= 0 &&
      ((target.guard === "high" && strike.zone.height === "head") ||
        (target.guard === "low" && strike.zone.height === "body"));

    let damage = strike.damage * fatigue * this.rules.damageScale;
    damage *= attacker.attrs.power;
    damage /= target.attrs.chin;

    if (covered) {
      damage *= FIGHT_CONFIG.blockedDamage;
      // Blocking is not free — it drains the blocker, which is what stops a
      // permanent high guard being a winning strategy.
      target.stamina = Math.max(
        0,
        target.stamina - damage * FIGHT_CONFIG.blockStaminaCost
      );
      this.emit({ type: "block", target: target.id, region: strike.region.id });
    }

    attacker.landed++;
    attacker.roundDamage += damage;
    target.health -= damage;
    if (!covered) {
      target.stunned = Math.max(
        target.stunned,
        damage * FIGHT_CONFIG.stunSecondsPerDamage
      );
    }

    this.emit({
      type: "land",
      target: target.id,
      damage,
      region: strike.region.id,
      power: strike.power,
    });

    if (target.health <= 0) this.knockdown(target);
  }

  private knockdown(target: FighterState): void {
    target.knockdowns++;
    target.totalKnockdowns++;
    // Back up, but not to full and less each time. A fighter who has been
    // dropped twice should be visibly on the way out.
    target.health =
      FIGHT_CONFIG.riseHealth *
      Math.pow(FIGHT_CONFIG.riseDecay, target.totalKnockdowns - 1);
    target.stunned = FIGHT_CONFIG.knockdownSeconds;
    target.guard = "none";
    target.evasion = "none";
    this.emit({ type: "knockdown", target: target.id, count: target.knockdowns });

    if (this.rules.stoppages && target.knockdowns >= FIGHT_CONFIG.threeKnockdownRule) {
      this.stop(this.other(target.id).id, "tko");
    }
  }

  private stop(winner: string, reason: "ko" | "tko"): void {
    this.phase = "stopped";
    this.emit({ type: "stoppage", winner, reason });
  }

  setGuard(id: string, guard: GuardPosture): void {
    const f = this.fighters[id];
    if (f && f.stunned <= 0) f.guard = guard;
  }

  /**
   * Commits a fighter to a head movement, or clears one.
   *
   * Starting an evasion costs stamina. It has to: a fighter who slips
   * everything for free is strictly better than one who blocks, and the whole
   * point of having both is that they are different trades. This is also why
   * the cost is charged on ENTERING the state rather than per second — it
   * prices the decision, not the duration, so holding a slip an extra frame is
   * not punished and spamming slips is.
   */
  setEvasion(id: string, evasion: Evasion): void {
    const f = this.fighters[id];
    if (!f) return;
    if (f.stunned > 0) {
      f.evasion = "none";
      return;
    }
    if (evasion !== "none" && f.evasion === "none") {
      f.stamina = Math.max(0, f.stamina - FIGHT_CONFIG.evadeStaminaCost);
    }
    f.evasion = evasion;
  }

  /** Advances the clock. `dt` in seconds. */
  tick(dt: number): void {
    if (this.phase === "between") {
      this.betweenTimer -= dt;
      for (const f of Object.values(this.fighters)) {
        // The corner. A full minute back recovers a real chunk of gas and a
        // little health — which is why a fighter who survives to the bell gets
        // a genuine reprieve.
        f.stamina = Math.min(
          f.maxStamina,
          f.stamina + f.attrs.recovery * FIGHT_CONFIG.cornerRecoveryRate * dt
        );
        f.health = Math.min(100, f.health + FIGHT_CONFIG.cornerHealthPerSecond * dt);
        f.stunned = 0;
      }
      if (this.betweenTimer <= 0) {
        this.round++;
        this.clock = this.rules.roundSeconds;
        for (const f of Object.values(this.fighters)) {
          f.knockdowns = 0;
          f.roundDamage = 0;
          f.guard = "high";
        }
        this.phase = "fighting";
      }
      return;
    }

    if (this.phase !== "fighting") return;

    for (const f of Object.values(this.fighters)) {
      f.stunned = Math.max(0, f.stunned - dt);
      if (f.stunned > 0) f.evasion = "none";
      if (f.stunned <= 0) {
        f.stamina = Math.min(f.maxStamina, f.stamina + f.attrs.recovery * dt);
      }
    }

    this.clock -= dt;
    if (this.clock <= 0) this.endRound();
  }

  private endRound(): void {
    const scores = this.scoreRound();
    this.cards.push(scores);
    this.emit({ type: "roundEnd", round: this.round, scores });

    if (this.round >= this.rules.rounds) {
      this.phase = "decision";
      const cards = this.totals();
      const [a, b] = this.ids;
      const winner = cards[a] === cards[b] ? null : cards[a] > cards[b] ? a : b;
      this.emit({ type: "decision", winner, cards });
      return;
    }
    this.phase = "between";
    this.betweenTimer = FIGHT_CONFIG.betweenRoundSeconds;
  }

  /**
   * Ten-point must for the round just finished.
   *
   * Winner 10, loser 9, minus one per knockdown taken, floored at 6. A round
   * with no knockdowns and effectively equal damage is scored 10-10 rather
   * than being forced to a winner — real judges avoid it, but a simulation
   * that invents a winner from a 0.3% damage difference is producing noise and
   * calling it a decision.
   */
  scoreRound(): Record<string, number> {
    const [a, b] = this.ids;
    const fa = this.fighters[a];
    const fb = this.fighters[b];
    const out: Record<string, number> = {};

    const total = fa.roundDamage + fb.roundDamage;
    const margin = total > 0 ? Math.abs(fa.roundDamage - fb.roundDamage) / total : 0;
    const even =
      fa.knockdowns === fb.knockdowns && margin < FIGHT_CONFIG.evenRoundMargin;

    if (even) {
      out[a] = 10 - fa.knockdowns;
      out[b] = 10 - fb.knockdowns;
    } else {
      const aWins =
        fa.knockdowns < fb.knockdowns ||
        (fa.knockdowns === fb.knockdowns && fa.roundDamage > fb.roundDamage);
      out[a] = aWins ? 10 - fa.knockdowns : 9 - fa.knockdowns;
      out[b] = aWins ? 9 - fb.knockdowns : 10 - fb.knockdowns;
    }
    out[a] = Math.max(FIGHT_CONFIG.minRoundScore, out[a]);
    out[b] = Math.max(FIGHT_CONFIG.minRoundScore, out[b]);
    return out;
  }

  /** Running scorecard, fouls included. */
  totals(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.ids) {
      out[id] =
        this.cards.reduce((sum, card) => sum + (card[id] ?? 0), 0) -
        this.deductions[id];
    }
    return out;
  }
}
