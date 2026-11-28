// The fight simulation: health, stamina, guard, knockdowns, rounds, scoring.

import {
  attributesFor,
  drainOf,
  fatigueMultiplier,
  type FighterAttributes,
} from "./attributes";
import type { WeightClass } from "./attributes";
import type { PunchKind, StrikeEvent } from "../perception/strikeResolver";
import type { BodyMotion } from "../perception/bodyMotion";
import { FIGHT_CONFIG } from "../config/tuning";

/** What a fighter is protecting. */
export type GuardPosture = "high" | "low" | "none";

/** A committed head movement, in the evading fighter's own frame. */
export type Evasion = "none" | "slipLeft" | "slipRight" | "duck";

/** Whether a committed head movement takes the target off the line of a strike. */
export function evades(evasion: Evasion, strike: StrikeEvent): boolean {
  if (evasion === "none") return false;
  // Both slips and ducks are head movement. A body shot is not evaded by
  // moving the head, and pretending otherwise would let the CPU slip a liver
  // shot, which reads as the game cheating.
  if (strike.zone.height !== "head") return false;
  if (evasion === "duck") return true;

  if (strike.approach.arc === "hooking" || strike.approach.arc === "falling") return false;

  // The mirror. A lane of "right" is the puncher's right, which arrives on the
  // target's own left - so moving to your own left carries you into it, and
  // moving to your own right carries you off it.
  const arrivesOnTargetsLeft = strike.zone.lane === "right";
  const arrivesOnTargetsRight = strike.zone.lane === "left";
  if (evasion === "slipLeft") return !arrivesOnTargetsLeft;
  return !arrivesOnTargetsRight;
}

/** Turns the player's measured body movement into a committed evasion. */
export function evasionFromBody(motion: BodyMotion, current: Evasion): Evasion {
  if (!motion.tracked) return "none";

  // A duck outranks a slip when the body is doing both. It is the stronger
  // answer to a head shot, and a player who has dropped into a crouch while
  // drifting sideways has ducked.
  const duckBar = current === "duck" ? FIGHT_CONFIG.duckExit : FIGHT_CONFIG.duckEnter;
  if (motion.crouch >= duckBar) return "duck";

  const slipping = current === "slipLeft" || current === "slipRight";
  const slipBar = slipping ? FIGHT_CONFIG.slipExit : FIGHT_CONFIG.slipEnter;
  if (Math.abs(motion.lateral) >= slipBar) {
    // `lateral` is positive toward the player's own right, and `slipRight`
    // means the fighter moved to their own right - the same frame, so no
    // mirror here. The mirror that does matter is in `evades`, which converts
    // the puncher's lane into the target's side.
    return motion.lateral > 0 ? "slipRight" : "slipLeft";
  }
  return "none";
}

/** Turns the player's measured hand height into a guard posture. */
export function guardFromBody(
  motion: BodyMotion,
  current: GuardPosture
): GuardPosture {
  if (!motion.tracked) return "none";
  const h = motion.guardHeight;

  const highBar =
    current === "high" ? FIGHT_CONFIG.guardHighExit : FIGHT_CONFIG.guardHighEnter;
  if (h >= highBar) return "high";

  // A hand on its way down from a high guard should pass through low rather
  // than falling straight to nothing, so the low bar is read against whether
  // any guard is currently held at all.
  const lowBar =
    current === "none" ? FIGHT_CONFIG.guardLowEnter : FIGHT_CONFIG.guardLowExit;
  if (h >= lowBar) return "low";
  return "none";
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
  /** Knockdowns taken this round - three ends it. */
  knockdowns: number;
  /** Knockdowns taken across the whole fight, for the scorecard. */
  totalKnockdowns: number;
  /** Seconds left of being unable to act. */
  stunned: number;
  /** Committed head movement, if any. Set by whoever drives this fighter: the
   *  CPU from its own state machine, the player from their tracked body via
   *  `evasionFromBody`. The sim only reads it; it never decides to evade on a
   *  fighter's behalf. */
  evasion: Evasion;
  landed: number;
  thrown: number;
  /** Damage dealt this round, for scoring a round nobody was dropped in. */
  roundDamage: number;
}

export type FightPhase = "idle" | "fighting" | "between" | "stopped" | "decision";

export type FightEvent =
  | { type: "land"; target: string; damage: number; region: string; power: number; punch?: PunchKind }
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

export const DEFAULT_RULES: FightRules = {
  rounds: 3,
  roundSeconds: 180,
  damageScale: 1,
  enforceFouls: true,
  stoppages: true,
};

/** The part of a fighter a strike is judged against. */
export interface DefenceSnapshot {
  guard: GuardPosture;
  evasion: Evasion;
  stunned: number;
}

/**
 * Whether a guard takes a strike. A high guard covers the head, a low guard
 * the body; a stunned fighter's guard is down. The one definition, shared by
 * the sim and by anything (the fight's audio) that has to agree with it.
 */
export function guardCovers(d: DefenceSnapshot, strike: StrikeEvent): boolean {
  return (
    d.stunned <= 0 &&
    ((d.guard === "high" && strike.zone.height === "head") ||
      (d.guard === "low" && strike.zone.height === "body"))
  );
}

/**
 * A fighter's recent defence, so a strike can be judged against the defence
 * that was in place when it was thrown.
 */
export class DefenceHistory {
  private samples: { t: number; d: DefenceSnapshot }[] = [];

  record(t: number, d: DefenceSnapshot): void {
    this.samples.push({ t, d: { guard: d.guard, evasion: d.evasion, stunned: d.stunned } });
    const horizon = t - 2 * FIGHT_CONFIG.maxRewindMs;
    while (this.samples.length > 1 && this.samples[0].t < horizon) this.samples.shift();
  }

  /** The defence in force at `t`, rewound no further than the cap from `now`.
   *  Null when nothing that old was recorded. */
  at(t: number, now: number): DefenceSnapshot | null {
    const when = Math.max(t, now - FIGHT_CONFIG.maxRewindMs);
    for (let i = this.samples.length - 1; i >= 0; i--) {
      if (this.samples[i].t <= when) return this.samples[i].d;
    }
    return null;
  }

  /**
   * The defence that best answers `strike` between `from` and `to`: the first
   * one that evades or blocks it, else the one in force at `to`. Gives a remote
   * defender, whose state arrives late, the benefit of the doubt.
   */
  bestAgainst(strike: StrikeEvent, from: number, to: number): DefenceSnapshot | null {
    let inForce: DefenceSnapshot | null = null;
    for (const { t, d } of this.samples) {
      if (t > to) break;
      if (t <= from) {
        inForce = d;
        continue;
      }
      if (inForce && answers(inForce, strike)) return inForce;
      inForce = d;
    }
    return inForce;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

function answers(d: DefenceSnapshot, strike: StrikeEvent): boolean {
  return (d.stunned <= 0 && evades(d.evasion, strike)) || guardCovers(d, strike);
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

  /** Applies a resolved strike from `byId` to the other fighter. */
  applyStrike(byId: string, strike: StrikeEvent, defence?: DefenceSnapshot): void {
    if (this.phase !== "fighting") return;
    const attacker = this.fighters[byId];
    const target = this.other(byId);
    if (!attacker || !target) return;
    // The defence the strike is judged against: the target as it was when the
    // punch was thrown, when the caller knows that (see DefenceHistory), or
    // as it is now.
    const d: DefenceSnapshot = defence ?? target;

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
    // miss is a hit that never arrived. A stunned fighter evades nothing -
    // the same rule the guard follows, and the reason a knockdown is a real
    // turning point.
    if (d.stunned <= 0 && evades(d.evasion, strike)) {
      this.emit({
        type: "miss",
        target: target.id,
        evasion: d.evasion,
        region: strike.region.id,
      });
      return;
    }

    // Guard. A high guard covers the head, a low guard the body - the classic
    // trade, and the reason feinting upstairs to go downstairs works at all.
    // A stunned fighter's guard is down, which is what makes a knockdown a
    // real turning point rather than a cosmetic pause.
    const covered = guardCovers(d, strike);

    let damage = strike.damage * fatigue * this.rules.damageScale;
    damage *= attacker.attrs.power;
    damage /= target.attrs.chin;

    if (covered) {
      damage *= FIGHT_CONFIG.blockedDamage;
      // Blocking is not free - it drains the blocker, which is what stops a
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
      punch: strike.kind,
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

  /** Commits a fighter to a head movement, or clears one. */
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

  /**
   * Stands a stunned fighter back up now rather than at the end of their
   * stun. Only ever shortens the stun; a fighter who isn't stunned is left
   * alone. Used by the get-up mechanic (see getUp.ts).
   */
  rise(id: string): void {
    const f = this.fighters[id];
    if (!f || f.stunned <= 0) return;
    f.stunned = 0;
    f.guard = "high";
  }

  /** Advances the clock. `dt` in seconds. */
  tick(dt: number): void {
    if (this.phase === "between") {
      this.betweenTimer -= dt;
      for (const f of Object.values(this.fighters)) {
        // The corner. A full minute back recovers a real chunk of gas and a
        // little health - which is why a fighter who survives to the bell gets
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

  /** Ten-point must for the round just finished. */
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
