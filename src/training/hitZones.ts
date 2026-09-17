import { regionAt, type ImpactPoint } from "../perception/strikeGeometry";
import { DUMMY, halfWidthAt, onDummy, type DummySpec } from "./dummySpec";

// The lit target zones on the dummy — the "heat points" the player is asked to
// hit, and the thing accuracy is measured against.
// ONE COORDINATE SYSTEM, NOT TWO
//
// Every zone centre is an `ImpactPoint`: the exact type `strikeResolver.ts`
// produces when a punch lands. So scoring a punch against a lit zone is a
// subtraction, with no transform in between and therefore no transform to get
// wrong.
//
// Each zone also declares the anatomical region it is supposed to BE, and
// `hitZones.test.ts` asserts that `regionAt(zone.centre).id === zone.region`
// for every one of them. That test is the whole reason this file is safe to
// edit: the region table in strikeGeometry.ts and the target positions here
// are two descriptions of the same anatomy, and nothing but a test keeps them
// honest. Nudge a zone off its organ and the suite says so.
//
// WHY THE LATERAL BANDS HERE ARE TIGHTER THAN THE REGION TABLE'S
//
// The region table's bands are deliberately generous — they must catch
// glancing blows and wild swings, so `temple` accepts anything from 0.13 to
// 0.50 out from the midline. A person's temple is not 0.5 torso units wide;
// that band is a catchment, not an anatomy. Target zones are the opposite
// problem — they mark where the organ actually IS, so they sit near the inner
// edge of each band and are checked against the dummy's real silhouette by
// `zonesAreOnTheBody` below. A temple target at 0.26 would have floated in the
// air beside the head.

/** How hard a zone is to hit, which drives drill progression. */
export type ZoneTier = "open" | "precise" | "expert";

export interface HitZone {
  id: string;
  label: string;
  /** Where the zone sits, in the target's body frame. */
  centre: ImpactPoint;
  /**
   * Radius in torso units. A landed punch inside this scores full accuracy;
   * outside, accuracy falls off. Sized against a glove, which is ~0.17 torso
   * units across, so a `precise` zone is about one glove wide.
   */
  radius: number;
  /** The region this zone must resolve to. Asserted in tests. */
  region: string;
  tier: ZoneTier;
  /** Head or body, for drill composition and the HUD. */
  band: "head" | "body";
}

export const HIT_ZONES: HitZone[] = [
  // --- Head -------------------------------------------------------------
  {
    id: "nose",
    label: "Nose",
    centre: { lateral: 0, height: 1.35 },
    radius: 0.1,
    region: "nose",
    tier: "open",
    band: "head",
  },
  {
    id: "chin",
    label: "Chin",
    centre: { lateral: 0, height: 1.2 },
    radius: 0.09,
    region: "chin",
    tier: "precise",
    band: "head",
  },
  {
    id: "jaw_left",
    label: "Left jaw",
    centre: { lateral: -0.13, height: 1.24 },
    radius: 0.1,
    region: "jaw_left",
    tier: "precise",
    band: "head",
  },
  {
    id: "jaw_right",
    label: "Right jaw",
    centre: { lateral: 0.13, height: 1.24 },
    radius: 0.1,
    region: "jaw_right",
    tier: "precise",
    band: "head",
  },
  {
    id: "temple_left",
    label: "Left temple",
    centre: { lateral: -0.15, height: 1.46 },
    radius: 0.09,
    region: "temple_left",
    tier: "expert",
    band: "head",
  },
  {
    id: "temple_right",
    label: "Right temple",
    centre: { lateral: 0.15, height: 1.46 },
    radius: 0.09,
    region: "temple_right",
    tier: "expert",
    band: "head",
  },
  // --- Body -------------------------------------------------------------
  {
    id: "chest",
    label: "Chest",
    centre: { lateral: 0, height: 0.88 },
    radius: 0.14,
    region: "chest",
    tier: "open",
    band: "body",
  },
  {
    id: "solar_plexus",
    label: "Solar plexus",
    centre: { lateral: 0, height: 0.61 },
    radius: 0.11,
    region: "solar_plexus",
    tier: "precise",
    band: "body",
  },
  {
    id: "liver",
    label: "Liver",
    // The target's own right side, which appears on the PUNCHER's left — hence
    // a negative lateral. This is the asymmetry that makes a left hook to the
    // body the fight-ender it is, and it is real anatomy rather than a
    // balancing decision.
    centre: { lateral: -0.26, height: 0.57 },
    radius: 0.12,
    region: "liver",
    tier: "expert",
    band: "body",
  },
  {
    id: "ribs_right",
    label: "Right ribs",
    centre: { lateral: 0.27, height: 0.62 },
    radius: 0.12,
    region: "ribs_right",
    tier: "precise",
    band: "body",
  },
];

export const ZONE_BY_ID: ReadonlyMap<string, HitZone> = new Map(
  HIT_ZONES.map((z) => [z.id, z])
);

/** Straight-line distance from a landing point to a zone centre, torso units. */
export function missDistance(p: ImpactPoint, zone: HitZone): number {
  const dx = p.lateral - zone.centre.lateral;
  const dy = p.height - zone.centre.height;
  return Math.hypot(dx, dy);
}

/**
 * Accuracy of a punch against the zone it was asked to hit, 0..1.
 *
 * Full marks anywhere inside the circle, then a smooth falloff to zero over a
 * further `FALLOFF` radii. It is deliberately NOT a step function: a punch
 * that lands a centimetre outside the ring is a better punch than one that
 * lands on the other shoulder, and a pass/fail score cannot say so — which
 * makes the resulting training data far less useful for the adaptation loop.
 */
const FALLOFF = 2.2;
export function accuracyOf(p: ImpactPoint, zone: HitZone): number {
  const d = missDistance(p, zone);
  if (d <= zone.radius) return 1;
  const over = (d - zone.radius) / (zone.radius * FALLOFF);
  return Math.max(0, 1 - over);
}

/** The zone a punch is closest to, or null if it missed the dummy entirely. */
export function nearestZone(
  p: ImpactPoint,
  spec: DummySpec = DUMMY
): HitZone | null {
  if (!onDummy(p, spec)) return null;
  let best: HitZone | null = null;
  let bestD = Infinity;
  for (const z of HIT_ZONES) {
    const d = missDistance(p, z);
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  return best;
}

/**
 * Every zone whose centre lies outside the dummy's silhouette.
 *
 * Exported rather than kept private because it is asserted to be empty in the
 * tests. A target painted on thin air is invisible to the player and
 * unhittable in principle, and the failure is entirely silent otherwise — the
 * drill would just look unfairly hard.
 */
export function zonesOffTheBody(spec: DummySpec = DUMMY): HitZone[] {
  return HIT_ZONES.filter((z) => {
    // Vertical first: below the cut there is no body at all, and halfWidthAt
    // already returns 0 there — but checking it explicitly says WHICH fault
    // was hit, and a zone hanging off the side is a different mistake from one
    // painted on the stand.
    const low = z.centre.height - z.radius < spec.base;
    const high = z.centre.height + z.radius > spec.crown;
    const wide = Math.abs(z.centre.lateral) > halfWidthAt(z.centre.height, spec);
    return low || high || wide;
  });
}

/** Zones of at most the given tier, for progressive drills. */
const TIER_ORDER: ZoneTier[] = ["open", "precise", "expert"];
export function zonesUpTo(tier: ZoneTier): HitZone[] {
  const max = TIER_ORDER.indexOf(tier);
  return HIT_ZONES.filter((z) => TIER_ORDER.indexOf(z.tier) <= max);
}

/** Region ids that this zone set covers. Used by the coverage test. */
export function coveredRegions(): Set<string> {
  return new Set(HIT_ZONES.map((z) => regionAt(z.centre).id));
}
