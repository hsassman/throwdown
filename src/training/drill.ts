import type { HandSide } from "../perception/punchTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import { TRAINING_CONFIG } from "../config/tuning";
import {
  accuracyOf,
  missDistance,
  zonesUpTo,
  type HitZone,
  type ZoneTier,
} from "./hitZones";

// The drill: light a target on the dummy, open a window, score what arrives.
// WHAT THIS REPLACES, AND WHY
//
// The previous training mode asked the player to throw a named punch TYPE
// (jab, cross, hook, uppercut) and graded the four-way classifier's answer.
// That trained the wrong thing, on two counts. It inherited the classifier's
// ~19% detection rate, so most correct punches scored nothing and the player
// could not tell their own technique apart from the software's failure. And a
// punch type is not really a skill in the first place — landing on a spot is.
//
// A lit zone sidesteps the classifier entirely. WHERE a punch landed and HOW
// HARD are measurements this project can already make reliably (reach and body
// frame, both proven and tested), so the drill is built only on those. A punch
// type can be displayed alongside the moment it earns its place, and nothing
// in this file has to change when it does.
// TIME IS INJECTED, NEVER READ
//
// Every method takes `now`. Nothing in this file calls `performance.now()`.
// A drill is a state machine over time, and one that reads the clock itself
// can only be tested by sleeping — which makes the suite slow, flaky, and
// unable to test the interesting cases (a punch landing 1ms before the window
// shuts) at all.

/** A target currently lit on the dummy. */
export interface LitTarget {
  zone: HitZone;
  /** When it lit. Reaction time is measured from here. */
  litAt: number;
  /** When it stops accepting punches. */
  expiresAt: number;
  /** The hand the player is asked to use, or null for either. */
  hand: HandSide | null;
  /** Position in the round, from 1. */
  index: number;
}

/** Why an outcome was produced. */
export type OutcomeKind =
  /** A punch landed inside the window. */
  | "hit"
  /** The window shut with nothing thrown. */
  | "expired"
  /** A punch landed in the window, with the wrong hand. */
  | "wrong-hand";

export interface DrillOutcome {
  kind: OutcomeKind;
  zone: HitZone;
  index: number;
  /** The strike that scored it. Null on an expiry. */
  strike: StrikeEvent | null;
  /** 0..1, how close to the zone centre. */
  accuracy: number;
  /**
   * Miss from the zone centre. The SIGNED components are kept alongside the
   * distance because a consistent direction is the valuable signal — landing
   * low on every target is a different fact from landing 8cm away on every
   * target, and only the signed form can tell them apart. See `adaptation.ts`.
   */
  miss: { distance: number; lateral: number; height: number };
  /** 0..1, how committed the punch was. */
  power: number;
  /** Reaction from the target lighting to the punch landing, ms. */
  reactionMs: number;
  /** 0..1 derived from `reactionMs`. */
  timing: number;
  /** Weighted combination of the three. 0 on an expiry. */
  score: number;
}

export interface DrillStats {
  presented: number;
  landed: number;
  /**
   * Means over LANDED targets only. A missed target pulls `landed` down rather
   * than dragging the accuracy average — otherwise standing perfectly still
   * would report 100% accuracy on zero punches, which is the most misleading
   * number the drill could possibly show.
   */
  accuracy: number;
  power: number;
  timing: number;
  score: number;
  reactionMs: number;
  /** Best unbroken run of hits. */
  bestStreak: number;
  streak: number;
  /**
   * Punches thrown while nothing was lit. Not scored — there is no target to
   * compare them against — but reported, because a high count means the player
   * is punching through the rest gap and their real accuracy is worse than the
   * scored figure suggests.
   */
  stray: number;
}

export interface DrillOptions {
  /** Hardest tier to present. */
  tier?: ZoneTier;
  /** Targets before the round ends. 0 for an endless drill. */
  targets?: number;
  /** Demand a specific hand for each target. */
  requireHand?: boolean;
  /** Target selection. Injected so the adaptation loop can weight it toward
   *  the player's weak zones, and so tests can be deterministic. */
  pick?: (zones: HitZone[], previous: HitZone | null) => HitZone;
  /** Injected randomness, for the same reason. */
  rng?: () => number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reaction time to a 0..1 score: flat at both ends, linear ramp between. */
export function timingScore(ms: number): number {
  const { perfectMs, slowMs } = TRAINING_CONFIG;
  if (ms <= perfectMs) return 1;
  if (ms >= slowMs) return 0;
  return 1 - (ms - perfectMs) / (slowMs - perfectMs);
}

/** A strike's commitment to a 0..1 score. */
export function powerScore(strike: StrikeEvent): number {
  return clamp01(strike.power / TRAINING_CONFIG.fullPowerAt);
}

export class Drill {
  private zones: HitZone[];
  private opts: {
    tier: ZoneTier;
    targets: number;
    requireHand: boolean;
    pick: NonNullable<DrillOptions["pick"]>;
    rng: () => number;
  };
  private target: LitTarget | null = null;
  /** Earliest time the next target may light. */
  private nextAt = 0;
  private index = 0;
  private previous: HitZone | null = null;
  private running = false;

  private sum = { accuracy: 0, power: 0, timing: 0, score: 0, reaction: 0 };
  private counts = { presented: 0, landed: 0, stray: 0 };
  private streak = 0;
  private bestStreak = 0;

  constructor(options: DrillOptions = {}) {
    const rng = options.rng ?? Math.random;
    this.zones = zonesUpTo(options.tier ?? "precise");
    this.opts = {
      tier: options.tier ?? "precise",
      targets: options.targets ?? TRAINING_CONFIG.targetsPerRound,
      requireHand: options.requireHand ?? false,
      rng,
      pick:
        options.pick ??
        ((zones, previous) => {
          // Never light the same target twice running. A repeat measures
          // nothing — the player already has their hand there — and it reads
          // as the drill being broken.
          const choices =
            zones.length > 1 && previous
              ? zones.filter((z) => z.id !== previous.id)
              : zones;
          const i = Math.floor(rng() * choices.length);
          return choices[Math.min(i, choices.length - 1)];
        }),
    };
  }

  start(now: number): void {
    this.running = true;
    this.target = null;
    this.index = 0;
    this.previous = null;
    this.nextAt = now;
    this.sum = { accuracy: 0, power: 0, timing: 0, score: 0, reaction: 0 };
    this.counts = { presented: 0, landed: 0, stray: 0 };
    this.streak = 0;
    this.bestStreak = 0;
  }

  stop(): void {
    this.running = false;
    this.target = null;
  }

  get lit(): LitTarget | null {
    return this.target;
  }

  get finished(): boolean {
    return (
      this.opts.targets > 0 &&
      this.counts.presented >= this.opts.targets &&
      this.target === null
    );
  }

  /**
   * Advances the clock. Returns any outcome produced by time alone — which is
   * only ever an expiry.
   */
  update(now: number): DrillOutcome | null {
    if (!this.running) return null;

    if (this.target) {
      if (now < this.target.expiresAt) return null;
      const expired = this.expire(this.target);
      this.target = null;
      this.nextAt = now + TRAINING_CONFIG.restMs;
      return expired;
    }

    if (this.finished) return null;
    if (now >= this.nextAt) this.light(now);
    return null;
  }

  private light(now: number): void {
    const zone = this.opts.pick(this.zones, this.previous);
    this.index += 1;
    this.counts.presented += 1;
    this.previous = zone;
    this.target = {
      zone,
      litAt: now,
      expiresAt: now + TRAINING_CONFIG.windowMs,
      hand: this.opts.requireHand ? this.handFor(zone) : null,
      index: this.index,
    };
  }

  /**
   * Which hand a zone should be thrown with, when the drill demands one.
   *
   * Derived from the anatomy rather than randomised. A target on the puncher's
   * LEFT (negative lateral — the liver, or the target's right jaw) is what a
   * left hook reaches; one on the right is what a right hand reaches. Asking
   * for the crossing hand on a wide target would drill a punch that cannot
   * physically land, and the player would rightly read that as a bug.
   */
  private handFor(zone: HitZone): HandSide {
    if (zone.centre.lateral < -0.05) return "left";
    if (zone.centre.lateral > 0.05) return "right";
    return this.opts.rng() < 0.5 ? "left" : "right";
  }

  private expire(t: LitTarget): DrillOutcome {
    this.streak = 0;
    return {
      kind: "expired",
      zone: t.zone,
      index: t.index,
      strike: null,
      accuracy: 0,
      miss: { distance: Infinity, lateral: 0, height: 0 },
      power: 0,
      reactionMs: TRAINING_CONFIG.windowMs,
      timing: 0,
      score: 0,
    };
  }

  /**
   * Feeds a resolved strike in. Returns an outcome if it was scored against a
   * lit target, or null if it was a stray.
   */
  onStrike(strike: StrikeEvent, now: number): DrillOutcome | null {
    if (!this.running) return null;
    const t = this.target;
    if (!t || now > t.expiresAt) {
      this.counts.stray += 1;
      return null;
    }

    if (t.hand && strike.hand !== t.hand) {
      // Reported, but it deliberately does NOT clear the target: the player
      // still has the rest of the window to throw the correct hand. Clearing
      // it would punish a twitch far more harshly than missing outright.
      this.streak = 0;
      return {
        kind: "wrong-hand",
        zone: t.zone,
        index: t.index,
        strike,
        accuracy: 0,
        miss: { distance: Infinity, lateral: 0, height: 0 },
        power: 0,
        reactionMs: Math.max(0, strike.timestamp - t.litAt),
        timing: 0,
        score: 0,
      };
    }

    const accuracy = accuracyOf(strike.impact, t.zone);
    const power = powerScore(strike);
    const reactionMs = Math.max(0, strike.timestamp - t.litAt);
    const timing = timingScore(reactionMs);
    const w = TRAINING_CONFIG.weight;
    const score = accuracy * w.accuracy + timing * w.timing + power * w.power;

    this.sum.accuracy += accuracy;
    this.sum.power += power;
    this.sum.timing += timing;
    this.sum.score += score;
    this.sum.reaction += reactionMs;
    this.counts.landed += 1;
    this.streak += 1;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;

    this.target = null;
    this.nextAt = now + TRAINING_CONFIG.restMs;

    return {
      kind: "hit",
      zone: t.zone,
      index: t.index,
      strike,
      accuracy,
      miss: {
        distance: missDistance(strike.impact, t.zone),
        lateral: strike.impact.lateral - t.zone.centre.lateral,
        height: strike.impact.height - t.zone.centre.height,
      },
      power,
      reactionMs,
      timing,
      score,
    };
  }

  get stats(): DrillStats {
    const n = this.counts.landed;
    const mean = (v: number) => (n > 0 ? v / n : 0);
    return {
      presented: this.counts.presented,
      landed: n,
      accuracy: mean(this.sum.accuracy),
      power: mean(this.sum.power),
      timing: mean(this.sum.timing),
      score: mean(this.sum.score),
      reactionMs: mean(this.sum.reaction),
      bestStreak: this.bestStreak,
      streak: this.streak,
      stray: this.counts.stray,
    };
  }
}
