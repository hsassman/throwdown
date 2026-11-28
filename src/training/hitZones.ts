import type { ImpactPoint } from "../perception/strikeGeometry";
import { DUMMY, halfWidthAt, onDummy, type DummySpec } from "./dummySpec";

// The lit target zones on the dummy - the "heat points" the player is asked to
// hit, and the thing accuracy is measured against.
// One coordinate system, not two

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
    // The target's own right side, which appears on the puncher's left - hence
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

/** Accuracy of a punch against the zone it was asked to hit, 0..1. */
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

/** Every zone whose centre lies outside the dummy's silhouette. */
export function zonesOffTheBody(spec: DummySpec = DUMMY): HitZone[] {
  return HIT_ZONES.filter((z) => {
    // Vertical first: below the cut there is no body at all, and halfWidthAt
    // already returns 0 there - but checking it explicitly says which fault
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

