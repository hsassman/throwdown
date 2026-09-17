import type { DrillOutcome } from "./drill";
import { HIT_ZONES } from "./hitZones";

// The persistent training record: what the player has thrown, and how it went.
// WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
//
// Stored: aggregate statistics per target zone. Counts, means, and a running
// mean of the SIGNED miss vector.
//
// Not stored: pose landmarks, frames, video, or anything from which a body
// could be reconstructed. The project's standing rule is that raw landmarks
// never cross the network; writing them to disk instead would honour the
// letter of that and miss the point entirely. Everything here is a scalar
// summary of a punch, and there is no path back to the person who threw it.
// WHY RUNNING MEANS RATHER THAN A LOG
//
// A log of every punch grows without bound, and localStorage has a hard quota
// that fails by THROWING on write. A profile that breaks the game after three
// weeks of training would be a spectacular way to punish the most engaged
// player. Running means are O(1) in storage and answer every question the
// adaptation loop actually asks.
//
// The cost is that means forget nothing, so a player who improves is averaged
// against their beginner self forever. `DECAY` fixes that: each update pulls
// the mean toward the new sample by a fixed fraction, which makes it an
// exponential moving average with a half-life of roughly 20 punches per zone.
// Recent form dominates, and old form fades instead of anchoring.

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
   * Running mean of the SIGNED miss, torso units. This is the whole reason the
   * record exists: an unsigned distance says "you are 6cm out" and a signed
   * vector says "you are 6cm LOW", which is the difference between a statistic
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
    // Seeded at 0, not at 0.5. An unproven zone must not look competent — the
    // adaptation loop weights drilling toward WEAK zones, and a neutral seed
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

/**
 * Folds one drill outcome into the profile, in place.
 *
 * Returns the profile for chaining. Mutates rather than copying because this
 * runs once per punch and the profile is not React state — it is persisted
 * state that a hook snapshots when it wants to render.
 */
export function recordOutcome(
  profile: TrainingProfile,
  outcome: DrillOutcome,
  now = 0
): TrainingProfile {
  const rec = (profile.zones[outcome.zone.id] ??= freshZone());
  rec.presented += 1;
  profile.updatedAt = now;

  if (outcome.kind !== "hit") {
    // A miss updates the accuracy mean toward zero — it is real evidence about
    // this zone — but contributes NOTHING to the bias, because a punch that
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

/**
 * Rebuilds a profile from parsed JSON, tolerating anything.
 *
 * Deliberately total: it never throws and never returns null. This reads from
 * localStorage, which means the input can be a profile from a future version,
 * a half-written string from a browser killed mid-write, or something a user
 * pasted in by hand. Every one of those must degrade to "start fresh" rather
 * than taking the training mode down, because a corrupted profile that crashes
 * the app is unrecoverable without devtools.
 */
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
