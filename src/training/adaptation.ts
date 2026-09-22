import { ADAPT_CONFIG, TRAINING_CONFIG } from "../config/tuning";
import { HIT_ZONES, ZONE_BY_ID, type HitZone } from "./hitZones";
import type { TrainingProfile, ZoneRecord } from "./profile";

// The learning loop: what the system does with everything it has recorded.
//
// Hard rule: no automatic process may adjust a threshold that decides whether
// a punch landed. Otherwise the game quietly rewards a worse webcam, and a
// player in bad light finds it getting easier with no way to know. This file
// may only (1) correct a common-mode coordinate bias and (2) choose which
// targets to show. It may not touch reachThreshold, the accuracy falloff,
// zone radii or the damage table; adaptation.test.ts asserts the returned
// shape structurally so adding a third knob breaks a test.
//
// Every landed punch yields a signed miss vector. Averaged per zone they
// decompose into two things:
//
//   Common mode - the same on every zone. Landing 6cm low on temple, chin,
//   liver and ribs alike is not four faults that agree, it is the frame of
//   reference being off: camera mounted high, or torso scale running large.
//   A setup error, not the player's, and correcting it is calibration.
//
//   Differential - what is left. Landing low on the liver while head shots are
//   centred is technique. That is the player's to fix, so it is reported,
//   never corrected.
//
// Getting the decomposition backwards would silently "fix" the player's
// technique while leaving the camera error in place. Hence the guards below
// and minDistinctZones. The common-mode estimate is the median of the
// per-zone biases: one zone with a large real fault would drag a mean into
// every other target's correction.

export interface BiasEstimate {
  /** Median per-zone bias, torso units. */
  lateral: number;
  height: number;
  /** Zones that had enough samples to contribute. */
  contributingZones: number;
  /** Total landed punches behind the estimate. */
  samples: number;
  /** Whether the guards passed and a correction may be applied. */
  confident: boolean;
  /** Plain-language reason when it is not confident. */
  reason: string;
}

/** A bounded correction to apply to incoming impact points. */
export interface Calibration {
  lateral: number;
  height: number;
}

const ZERO: Calibration = { lateral: 0, height: 0 };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v: number, limit: number): number {
  return v > limit ? limit : v < -limit ? -limit : v;
}

/** Zones with enough landed punches for their statistics to mean anything. */
function trustedZones(profile: TrainingProfile): [string, ZoneRecord][] {
  return Object.entries(profile.zones).filter(
    ([id, r]) =>
      ZONE_BY_ID.has(id) && r.biasSamples >= TRAINING_CONFIG.minZoneSamples
  );
}

/**
 * Estimates the common-mode component of the player's miss.
 *
 * Reports its own confidence rather than returning a bare number, because the
 * caller genuinely needs to know the difference between "no bias detected" and
 * "not enough evidence to say" - they are the same number and opposite facts.
 */
export function estimateBias(profile: TrainingProfile): BiasEstimate {
  const trusted = trustedZones(profile);
  const samples = trusted.reduce((n, [, r]) => n + r.biasSamples, 0);
  const lateral = median(trusted.map(([, r]) => r.bias.lateral));
  const height = median(trusted.map(([, r]) => r.bias.height));

  let reason = "";
  if (samples < ADAPT_CONFIG.minSamples) {
    reason = `needs ${ADAPT_CONFIG.minSamples - samples} more scored punches`;
  } else if (trusted.length < ADAPT_CONFIG.minDistinctZones) {
    // The guard that stops a player teaching the system an offset by hammering
    // one target. A bias seen on one zone is technique on that shot; a bias
    // seen across the dummy is the camera. Only the second is correctable, and
    // only a spread of zones can tell them apart.
    reason = `needs ${ADAPT_CONFIG.minDistinctZones - trusted.length} more zones trained`;
  }

  return {
    lateral,
    height,
    contributingZones: trusted.length,
    samples,
    confident: reason === "",
    reason,
  };
}

/**
 * The correction to apply to incoming impact points, bounded.
 *
 * Note the sign: the bias is where punches land relative to the target, so the
 * correction is its negation - if every punch reads 6cm low, impacts must be
 * shifted UP by 6cm to sit where the player actually put them.
 *
 * Deliberately under-corrects by `gain`. The estimate is noisy, and a
 * correction applied at full strength feeds back into the next estimate and
 * oscillates. At 0.6 it converges monotonically instead.
 */
export function calibrationFrom(profile: TrainingProfile): Calibration {
  const bias = estimateBias(profile);
  if (!bias.confident) return ZERO;
  const { gain, maxCorrection } = ADAPT_CONFIG;
  return {
    lateral: clamp(-bias.lateral * gain, maxCorrection),
    height: clamp(-bias.height * gain, maxCorrection),
  };
}

/**
 * How competent the player is on a zone, 0..1.
 *
 * Landing rate is folded in alongside accuracy, because they fail differently
 * and both matter: a player can be pinpoint on the three targets they answer
 * while ignoring the other nine, and an accuracy-only score would call that
 * mastery.
 */
export function zoneSkill(profile: TrainingProfile, zoneId: string): number {
  const r = profile.zones[zoneId];
  if (!r || r.presented === 0) return 0;
  const landRate = r.landed / r.presented;
  return r.accuracy * 0.6 + landRate * 0.25 + r.timing * 0.15;
}

/** The player's weakest trained zones first. Untrained zones rank as weakest. */
export function weakestZones(profile: TrainingProfile): HitZone[] {
  return [...HIT_ZONES].sort(
    (a, b) => zoneSkill(profile, a.id) - zoneSkill(profile, b.id)
  );
}

/**
 * Selection weights for the drill, favouring what the player is bad at.
 *
 * A weight floor of 1 is deliberate: even a mastered zone keeps appearing.
 * Drilling only weaknesses produces a player who has drilled away their
 * strengths, and it makes the session monotonous at exactly the moment the
 * player is struggling most.
 */
export function zoneWeights(profile: TrainingProfile): Map<string, number> {
  const out = new Map<string, number>();
  for (const z of HIT_ZONES) {
    const skill = zoneSkill(profile, z.id);
    out.set(z.id, 1 + (1 - skill) * ADAPT_CONFIG.weaknessBias);
  }
  return out;
}

/**
 * A `pick` function for `Drill`, weighted by the profile.
 *
 * This is how the drill gets smarter with use, and it is intentionally the
 * only place the profile changes what happens during a round. Scoring stays
 * identical no matter how much the player has trained - a 90% on the liver
 * means the same thing in session one and session fifty. A system that
 * silently raised its own standards would make improvement invisible.
 */
export function adaptivePick(
  profile: TrainingProfile,
  rng: () => number = Math.random
): (zones: HitZone[], previous: HitZone | null) => HitZone {
  return (zones, previous) => {
    const weights = zoneWeights(profile);
    const choices =
      zones.length > 1 && previous ? zones.filter((z) => z.id !== previous.id) : zones;
    let total = 0;
    for (const z of choices) total += weights.get(z.id) ?? 1;
    let roll = rng() * total;
    for (const z of choices) {
      roll -= weights.get(z.id) ?? 1;
      if (roll <= 0) return z;
    }
    return choices[choices.length - 1];
  };
}

export interface CoachingNote {
  zoneId: string | null;
  text: string;
  /** "setup" notes are the software's problem; "technique" is the player's. */
  kind: "setup" | "technique" | "progress";
}

/**
 * What the system has to say about the player's training.
 *
 * The `kind` field is the important part. A note that reads "you are landing
 * low" is actively harmful when the real cause is a high camera - the player
 * changes a technique that was fine. So the common-mode component is reported
 * as setup and the residual as technique, and the two are never mixed.
 */
export function coachingNotes(profile: TrainingProfile): CoachingNote[] {
  const notes: CoachingNote[] = [];
  const bias = estimateBias(profile);

  if (bias.confident) {
    const vertical = Math.abs(bias.height) > 0.06;
    const lateral = Math.abs(bias.lateral) > 0.06;
    if (vertical || lateral) {
      const parts: string[] = [];
      if (vertical) parts.push(bias.height < 0 ? "low" : "high");
      if (lateral) parts.push(bias.lateral < 0 ? "left" : "right");
      notes.push({
        zoneId: null,
        kind: "setup",
        text: `Everything is landing ${parts.join(" and ")} by the same amount across ${bias.contributingZones} targets - that is the camera framing, not your punches. Corrected automatically.`,
      });
    }
  }

  // Differential faults: what is left once common mode is removed.
  for (const [id, r] of trustedZones(profile)) {
    const dh = r.bias.height - bias.height;
    const dl = r.bias.lateral - bias.lateral;
    const zone = ZONE_BY_ID.get(id);
    if (!zone) continue;
    if (Math.abs(dh) > 0.1) {
      notes.push({
        zoneId: id,
        kind: "technique",
        text: `${zone.label}: you land ${dh < 0 ? "under" : "over"} it specifically, while the rest are centred. Check your hand height on that shot.`,
      });
    } else if (Math.abs(dl) > 0.12) {
      notes.push({
        zoneId: id,
        kind: "technique",
        text: `${zone.label}: drifting ${dl < 0 ? "inside" : "outside"} the mark. Square up before you throw.`,
      });
    }
  }

  const weakest = weakestZones(profile)[0];
  if (weakest && profile.totalStrikes >= ADAPT_CONFIG.minSamples) {
    notes.push({
      zoneId: weakest.id,
      kind: "progress",
      text: `Weakest target: ${weakest.label}. It will come up more often until it improves.`,
    });
  }

  return notes;
}
