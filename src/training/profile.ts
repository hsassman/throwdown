import type { DrillOutcome } from "./drill";
import { HIT_ZONES } from "./hitZones";

// The persistent training record: what the player has thrown, and how it went.
// What is stored, and what deliberately is not

/** Bumped whenever the shape below changes incompatibly. */
export const PROFILE_VERSION = 1;

/** Weight given to each new sample in the running means. */
const DECAY = 0.035;

export interface ZoneRecord {
  /** Targets presented on this zone. */
  presented: number;
  /** Targets answered with a punch. */
  landed: number;
  /** Exponential moving averages, 0..1. */
  accuracy: number;
  power: number;
  timing: number;
  /**
   * Running mean of the signed miss, torso units. This is the whole reason the
   * record exists: an unsigned distance says "you are 6cm out" and a signed
   * vector says "you are 6cm low", which is the difference between a statistic
   * and a coaching note.
   */
  bias: { lateral: number; height: number };
  /** Samples contributing to `bias`. Guards the adaptation loop. */
  biasSamples: number;
}

export interface TrainingProfile {
  version: number;
  /** Total scored punches across the profile's life. */
  totalStrikes: number;
  /** Drill rounds completed. */
  rounds: number;
  /** Wall-clock ms of the last update, for the UI only. */
  updatedAt: number;
  zones: Record<string, ZoneRecord>;
  /** Best round score ever recorded, 0..1. */
  bestRoundScore: number;
}

function freshZone(): ZoneRecord {
  return {
    presented: 0,
    landed: 0,
    // Seeded at 0, not at 0.5. An unproven zone must not look competent - the
    // adaptation loop weights drilling toward weak zones, and a neutral seed
    // would make untrained zones look average and stop them being drilled.
    accuracy: 0,
    power: 0,
    timing: 0,
    bias: { lateral: 0, height: 0 },
    biasSamples: 0,
  };
}

export function freshProfile(now = 0): TrainingProfile {
  const zones: Record<string, ZoneRecord> = {};
  for (const z of HIT_ZONES) zones[z.id] = freshZone();
  return {
    version: PROFILE_VERSION,
    totalStrikes: 0,
    rounds: 0,
    updatedAt: now,
    zones,
    bestRoundScore: 0,
  };
}

/** Pulls a running mean toward a new sample. */
function ema(mean: number, sample: number, n: number): number {
  // The first few samples use a plain average, so a zone with three punches on
  // it reports something close to what actually happened rather than 3.5% of
  // it. After that it crosses over to the fixed decay.
  const rate = Math.max(DECAY, 1 / Math.max(1, n));
  return mean + (sample - mean) * rate;
}

/** Folds one drill outcome into the profile, in place. */
export function recordOutcome(
  profile: TrainingProfile,
  outcome: DrillOutcome,
  now = 0
): TrainingProfile {
  const rec = (profile.zones[outcome.zone.id] ??= freshZone());
  rec.presented += 1;
  profile.updatedAt = now;

  if (outcome.kind !== "hit") {
    // A miss updates the accuracy mean toward zero - it is real evidence about
    // this zone - but contributes nothing to the bias, because a punch that
    // was never thrown has no landing point and an expired target would
    // otherwise drag the bias toward the origin.
    rec.accuracy = ema(rec.accuracy, 0, rec.presented);
    return profile;
  }

  rec.landed += 1;
  profile.totalStrikes += 1;
  rec.accuracy = ema(rec.accuracy, outcome.accuracy, rec.landed);
  rec.power = ema(rec.power, outcome.power, rec.landed);
  rec.timing = ema(rec.timing, outcome.timing, rec.landed);

  rec.biasSamples += 1;
  rec.bias.lateral = ema(rec.bias.lateral, outcome.miss.lateral, rec.biasSamples);
  rec.bias.height = ema(rec.bias.height, outcome.miss.height, rec.biasSamples);
  return profile;
}

/** Records the end of a round. */
export function recordRound(
  profile: TrainingProfile,
  roundScore: number,
  now = 0
): TrainingProfile {
  profile.rounds += 1;
  profile.updatedAt = now;
  if (roundScore > profile.bestRoundScore) profile.bestRoundScore = roundScore;
  return profile;
}

/** Rebuilds a profile from parsed JSON, tolerating anything. */
export function reviveProfile(raw: unknown, now = 0): TrainingProfile {
  const fresh = freshProfile(now);
  if (typeof raw !== "object" || raw === null) return fresh;
  const obj = raw as Partial<TrainingProfile>;
  if (obj.version !== PROFILE_VERSION) return fresh;

  const num = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  fresh.totalStrikes = num(obj.totalStrikes);
  fresh.rounds = num(obj.rounds);
  fresh.updatedAt = num(obj.updatedAt, now);
  fresh.bestRoundScore = num(obj.bestRoundScore);

  const zones = (obj.zones ?? {}) as Record<string, Partial<ZoneRecord>>;
  for (const id of Object.keys(fresh.zones)) {
    const z = zones[id];
    if (!z) continue;
    const rec = fresh.zones[id];
    rec.presented = num(z.presented);
    rec.landed = num(z.landed);
    rec.accuracy = num(z.accuracy);
    rec.power = num(z.power);
    rec.timing = num(z.timing);
    rec.biasSamples = num(z.biasSamples);
    rec.bias = {
      lateral: num(z.bias?.lateral),
      height: num(z.bias?.height),
    };
  }
  // Zones present in the saved profile but no longer in HIT_ZONES are dropped
  // silently, which is correct: `gut` existed before the dummy's real cut line
  // was measured, and carrying a record for a target that no longer exists
  // would feed a phantom zone into the bias estimate.
  return fresh;
}
