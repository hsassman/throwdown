import type { Difficulty } from "../sim/cpuOpponent";
import type { WeightClass } from "../menu/menuModel";

// A career: a fixed ladder of opponents, fought in order. Groundwork only —
// no cutscenes, no belts, just the one thing a career actually needs to be
// worth repeating: a record that persists, and a reason the next fight is
// different from the last.
//
// WHY A FIXED LADDER, NOT GENERATED OPPONENTS
//
// The CPU only has three difficulty tiers (cpuOpponent.ts's `Difficulty`) and
// eight weight classes exist purely as a stat multiplier — there is no roster
// of named fighters with distinct styles yet. Pretending otherwise with
// randomly-generated names would be exactly the kind of claim this project's
// own honesty rule exists to catch. So the ladder is short, each rung is
// named for what it actually is, and it ends rather than looping forever.

export interface CareerOpponent {
  id: string;
  name: string;
  weightClass: WeightClass;
  difficulty: Difficulty;
  blurb: string;
}

export const CAREER_LADDER: CareerOpponent[] = [
  {
    id: "tune-up",
    name: "The Tune-Up",
    weightClass: "welterweight",
    difficulty: "rookie",
    blurb: "Slow hands, wide guard. Everyone's first win.",
  },
  {
    id: "swarm",
    name: "The Swarmer",
    weightClass: "lightweight",
    difficulty: "contender",
    blurb: "Comes forward behind a high guard and does not stop punching.",
  },
  {
    id: "boxer-puncher",
    name: "The Boxer-Puncher",
    weightClass: "middleweight",
    difficulty: "contender",
    blurb: "Sound footwork, picks its spots, punishes a lazy guard.",
  },
  {
    id: "champion",
    name: "The Champion",
    weightClass: "lightheavy",
    difficulty: "champion",
    blurb: "The best the CPU currently has. Everything, all the time.",
  },
];

/** Bumped whenever the shape below changes incompatibly. */
export const CAREER_VERSION = 1;

export interface CareerRecord {
  wins: number;
  losses: number;
  draws: number;
}

export interface CareerProfile {
  version: number;
  /** Index into CAREER_LADDER of the next fight. Equal to the ladder's length
   *  once every rung has been won — the career is complete, not stuck. */
  rank: number;
  record: CareerRecord;
  updatedAt: number;
}

export function freshCareerProfile(now = 0): CareerProfile {
  return {
    version: CAREER_VERSION,
    rank: 0,
    record: { wins: 0, losses: 0, draws: 0 },
    updatedAt: now,
  };
}

/** The opponent the player is about to face, or null once the ladder is cleared. */
export function currentOpponent(profile: CareerProfile): CareerOpponent | null {
  return CAREER_LADDER[profile.rank] ?? null;
}

export function isComplete(profile: CareerProfile): boolean {
  return profile.rank >= CAREER_LADDER.length;
}

export type FightOutcome = "win" | "loss" | "draw";

/**
 * Folds one fight's result into the profile, in place. A win advances the
 * rank; a loss or draw does not — the same opponent is fought again, rather
 * than the ladder quietly getting easier to keep the player moving.
 */
export function recordResult(
  profile: CareerProfile,
  outcome: FightOutcome,
  now = 0
): CareerProfile {
  profile.updatedAt = now;
  if (outcome === "win") {
    profile.record.wins += 1;
    profile.rank = Math.min(CAREER_LADDER.length, profile.rank + 1);
  } else if (outcome === "loss") {
    profile.record.losses += 1;
  } else {
    profile.record.draws += 1;
  }
  return profile;
}

/**
 * Rebuilds a profile from parsed JSON, tolerating anything. Same contract as
 * training/profile.ts's reviveProfile — see there for why this never throws.
 */
export function reviveCareerProfile(raw: unknown, now = 0): CareerProfile {
  const fresh = freshCareerProfile(now);
  if (typeof raw !== "object" || raw === null) return fresh;
  const obj = raw as Partial<CareerProfile>;
  if (obj.version !== CAREER_VERSION) return fresh;

  const num = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  fresh.rank = Math.max(0, Math.min(CAREER_LADDER.length, Math.floor(num(obj.rank))));
  fresh.updatedAt = num(obj.updatedAt, now);
  const rec = obj.record as Partial<CareerRecord> | undefined;
  fresh.record = {
    wins: num(rec?.wins),
    losses: num(rec?.losses),
    draws: num(rec?.draws),
  };
  return fresh;
}
