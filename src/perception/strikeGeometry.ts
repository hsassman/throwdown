// Where a strike lands and how it arrived, as continuous quantities.

import { STRIKE_CONFIG } from "../config/tuning";

/** Where a strike landed, in the target's own body frame, in torso units. */
export interface ImpactPoint {
  /**
   * Offset from the midline. Expressed from the puncher's point of view, so
   * `+` is to the puncher's right - which lands on the target's own left,
   * since they face each other. Getting this backwards puts every mark on the
   * wrong cheek, so it is asserted in the tests rather than trusted.
   */
  lateral: number;
  /**
   * Height above the hip line. The torso scale is the shoulder-to-hip
   * distance, so 0 is the belt, 1.0 is the shoulder line, and the head sits
   * between roughly 1.15 and 1.6. These are not chosen constants - they fall
   * out of the normalisation.
   */
  height: number;
}

/** How a strike arrived. Descriptive; nothing gates on it. */
export type StrikeArc = "straight" | "hooking" | "rising" | "falling";

export interface Approach {
  /** Lateral component of travel at impact, torso units/sec. */
  x: number;
  /** Vertical component. Positive is upward (image y is flipped on the way in). */
  y: number;
  /** Out-of-plane component, recovered from foreshortening - never from z. */
  z: number;
  /** 0-1: how much of the travel was forward rather than across or up. */
  directness: number;
  arc: StrikeArc;
}

/** One strikeable place on the body. */
export interface BodyRegion {
  id: string;
  /** For the HUD and commentary. */
  label: string;
  /**
   * Damage multiplier. These encode real striking knowledge, which is the
   * kind of thing that should live in one readable table rather than being
   * scattered through combat code: the chin and jaw are the classic
   * knockout targets because they rotate the head and therefore the brain;
   * the temple is thin bone over an artery; the liver and solar plexus stop
   * people without touching the head at all; the crown of the skull is the
   * hardest bone in the body and hurts the puncher more than the punched.
   */
  damage: number;
  /** False below the belt - a foul, not a hit. */
  legal: boolean;
  /** Which texture zone a bruise on this region paints into. */
  textureZone: string;
}

/** Fallback when a strike lands somewhere unmapped (a wild swing past the ear). */
const GLANCING: BodyRegion = {
  id: "air",
  label: "Glancing",
  damage: 0.15,
  legal: true,
  textureZone: "body/centre",
};

interface RegionRule extends BodyRegion {
  /** [min, max] height above the hip line, torso units. */
  h: [number, number];
  /** [min, max] absolute lateral offset, torso units. */
  lat: [number, number];
  /** Restrict to one side: -1 puncher's left, +1 puncher's right. */
  side?: -1 | 1;
}

/** The anatomical map. First match wins, so narrower entries come first. */
const REGIONS: RegionRule[] = [
  // --- Head -------------------------------------------------------------
  {
    id: "crown",
    label: "Crown",
    h: [1.58, 2.2],
    lat: [0, 0.3],
    damage: 0.35,
    legal: true,
    textureZone: "head/centre",
  },
  {
    id: "temple_left",
    label: "Temple",
    h: [1.3, 1.62],
    lat: [0.13, 0.5],
    side: -1,
    damage: 1.55,
    legal: true,
    textureZone: "head/left",
  },
  {
    id: "temple_right",
    label: "Temple",
    h: [1.3, 1.62],
    lat: [0.13, 0.5],
    side: 1,
    damage: 1.55,
    legal: true,
    textureZone: "head/right",
  },
  {
    id: "forehead",
    label: "Forehead",
    h: [1.4, 1.62],
    lat: [0, 0.13],
    damage: 0.55,
    legal: true,
    textureZone: "head/centre",
  },
  {
    id: "nose",
    label: "Nose",
    h: [1.28, 1.42],
    lat: [0, 0.1],
    damage: 1.0,
    legal: true,
    textureZone: "head/centre",
  },
  {
    id: "jaw_left",
    label: "Jaw",
    h: [1.14, 1.34],
    lat: [0.1, 0.42],
    side: -1,
    damage: 1.85,
    legal: true,
    textureZone: "head/left",
  },
  {
    id: "jaw_right",
    label: "Jaw",
    h: [1.14, 1.34],
    lat: [0.1, 0.42],
    side: 1,
    damage: 1.85,
    legal: true,
    textureZone: "head/right",
  },
  {
    id: "chin",
    label: "Chin",
    h: [1.12, 1.3],
    lat: [0, 0.1],
    // The single highest multiplier in the table. An upward strike to the
    // point of the chin is the archetypal knockout, and the arc bonus below
    // compounds it.
    damage: 2.1,
    legal: true,
    textureZone: "head/centre",
  },
  // --- Neck and shoulders -----------------------------------------------
  {
    id: "throat",
    label: "Throat",
    h: [1.0, 1.15],
    lat: [0, 0.11],
    damage: 1.3,
    legal: true,
    textureZone: "head/centre",
  },
  {
    id: "shoulder_left",
    label: "Shoulder",
    h: [0.9, 1.15],
    lat: [0.24, 0.7],
    side: -1,
    // Deliberately near-zero. Blocking with the shoulder is correct technique
    // and should be rewarded by the damage model, not merely tolerated.
    damage: 0.12,
    legal: true,
    textureZone: "body/left",
  },
  {
    id: "shoulder_right",
    label: "Shoulder",
    h: [0.9, 1.15],
    lat: [0.24, 0.7],
    side: 1,
    damage: 0.12,
    legal: true,
    textureZone: "body/right",
  },
  // --- Torso ------------------------------------------------------------
  {
    id: "chest",
    label: "Chest",
    h: [0.72, 1.05],
    lat: [0, 0.24],
    damage: 0.5,
    legal: true,
    textureZone: "body/centre",
  },
  {
    id: "liver",
    label: "Liver",
    // The target's own right side, under the ribs - which appears on the
    // puncher's left, hence side -1. This asymmetry is real anatomy and is
    // the reason a left hook to the body ends fights more often than a right.
    h: [0.42, 0.72],
    lat: [0.14, 0.45],
    side: -1,
    damage: 1.9,
    legal: true,
    textureZone: "body/left",
  },
  {
    id: "ribs_right",
    label: "Ribs",
    h: [0.42, 0.85],
    lat: [0.14, 0.45],
    side: 1,
    damage: 1.15,
    legal: true,
    textureZone: "body/right",
  },
  {
    id: "ribs_left",
    label: "Ribs",
    h: [0.72, 0.9],
    lat: [0.14, 0.45],
    side: -1,
    damage: 1.15,
    legal: true,
    textureZone: "body/left",
  },
  {
    id: "solar_plexus",
    label: "Solar plexus",
    h: [0.48, 0.74],
    lat: [0, 0.14],
    damage: 1.7,
    legal: true,
    textureZone: "body/centre",
  },
  {
    id: "gut",
    label: "Body",
    h: [0.22, 0.5],
    lat: [0, 0.4],
    damage: 0.95,
    legal: true,
    textureZone: "body/centre",
  },
  // --- Below the belt ---------------------------------------------------
  {
    id: "low",
    label: "Low blow",
    h: [-1.0, 0.22],
    lat: [0, 0.6],
    damage: 0,
    legal: false,
    textureZone: "body/centre",
  },
];

/** Resolves a landing point to an anatomical region. */
export function regionAt(point: ImpactPoint): BodyRegion {
  const abs = Math.abs(point.lateral);
  const side = point.lateral >= 0 ? 1 : -1;
  for (const r of REGIONS) {
    if (r.side !== undefined && r.side !== side) continue;
    if (point.height < r.h[0] || point.height > r.h[1]) continue;
    if (abs < r.lat[0] || abs > r.lat[1]) continue;
    return r;
  }
  return GLANCING;
}

/** Every region, for the damage-table UI and for tests that sweep the map. */
export function allRegions(): BodyRegion[] {
  return REGIONS.map((r) => ({
    id: r.id,
    label: r.label,
    damage: r.damage,
    legal: r.legal,
    textureZone: r.textureZone,
  }));
}

/** Classifies how a strike arrived, from its velocity at impact. */
export function approachOf(vx: number, vy: number, vz: number): Approach {
  const mag = Math.hypot(vx, vy, vz);
  if (mag < 1e-6) {
    return { x: 0, y: 0, z: 1, directness: 1, arc: "straight" };
  }
  const nx = vx / mag;
  const ny = vy / mag;
  const nz = vz / mag;

  // Forward share of the motion. A straight punch is nearly all z.
  const directness = Math.max(0, nz);

  let arc: StrikeArc;
  if (directness >= STRIKE_CONFIG.straightDirectness) {
    arc = "straight";
  } else if (Math.abs(nx) >= Math.abs(ny)) {
    arc = "hooking";
  } else {
    arc = ny > 0 ? "rising" : "falling";
  }
  return { x: nx, y: ny, z: nz, directness, arc };
}

/** Damage for a landed strike. */
export function damageOf(
  region: BodyRegion,
  power: number,
  approach: Approach
): number {
  if (!region.legal) return 0;
  const rotational =
    (region.id === "chin" || region.id.startsWith("jaw")) && approach.arc === "rising"
      ? STRIKE_CONFIG.risingChinBonus
      : 1;
  return region.damage * power * rotational;
}

/** Coarse 2x3 zone for the landing point. */
export function coarseZone(point: ImpactPoint): {
  height: "head" | "body";
  lane: "left" | "centre" | "right";
} {
  const height = point.height >= 1 - STRIKE_CONFIG.headBandBelowShoulders ? "head" : "body";
  const edge = STRIKE_CONFIG.laneHalfWidth;
  const lane =
    point.lateral > edge ? "right" : point.lateral < -edge ? "left" : "centre";
  return { height, lane };
}
