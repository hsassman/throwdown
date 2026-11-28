import type { HandSide } from "../perception/punchTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import { coarseZone, regionAt, type ImpactPoint } from "../perception/strikeGeometry";

// A builder for synthetic strikes, shared by the training tests.

export interface StrikeSpec {
  impact: ImpactPoint;
  hand?: HandSide;
  timestamp?: number;
  power?: number;
  speed?: number;
}

export function makeStrike(spec: StrikeSpec): StrikeEvent {
  const region = regionAt(spec.impact);
  const power = spec.power ?? 0.8;
  return {
    hand: spec.hand ?? "left",
    zone: coarseZone(spec.impact),
    impact: spec.impact,
    region,
    approach: { x: 0, y: 0, z: 1, directness: 1, arc: "straight" },
    damage: region.damage * power,
    power,
    speed: spec.speed ?? 3.2,
    contactReach: 1.2,
    timestamp: spec.timestamp ?? 0,
  };
}

/** A strike aimed at a point offset from a zone centre. */
export function strikeNear(
  centre: ImpactPoint,
  offset: { lateral?: number; height?: number },
  spec: Omit<StrikeSpec, "impact"> = {}
): StrikeEvent {
  return makeStrike({
    ...spec,
    impact: {
      lateral: centre.lateral + (offset.lateral ?? 0),
      height: centre.height + (offset.height ?? 0),
    },
  });
}
