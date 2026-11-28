// Fighter attributes, and what a weight class actually changes.
// The one that crosses a layer boundary

export type WeightClass =
  | "flyweight"
  | "bantamweight"
  | "featherweight"
  | "lightweight"
  | "welterweight"
  | "middleweight"
  | "lightheavy"
  | "heavyweight";

/** Upper bound of each class, kg. Standard commission limits. */
export const WEIGHT_LIMITS: Record<WeightClass, number> = {
  flyweight: 56.7,
  bantamweight: 61.2,
  featherweight: 65.8,
  lightweight: 70.3,
  welterweight: 77.1,
  middleweight: 83.9,
  lightheavy: 93.0,
  heavyweight: 120.2,
};

export interface FighterAttributes {
  /**
   * Multiplier on the perception reach threshold. Below 1 means the fighter
   * is longer-limbed and lands sooner. Deliberately a narrow band.
   */
  reachScale: number;
  /** Multiplier on all outgoing damage. */
  power: number;
  /** Divisor on incoming damage. A strong chin takes less. */
  chin: number;
  /**
   * Multiplier on the refractory gap between strikes from one hand. Below 1
   * means faster hands.
   */
  handSpeed: number;
  /** Stamina pool, in the same units drainOf() produces. */
  stamina: number;
  /** Stamina recovered per second while not throwing. */
  recovery: number;
  /** Mass, kg - drives knockback and how far a fighter is moved by a hit. */
  mass: number;
}

/** Attributes derived from the weight limit rather than hand-tuned per class. */
const REFERENCE_KG = WEIGHT_LIMITS.middleweight;

export function attributesFor(weightClass: WeightClass): FighterAttributes {
  const kg = WEIGHT_LIMITS[weightClass];
  // Ratio to the reference fighter. ~0.68 for a flyweight, ~1.43 for a
  // heavyweight.
  const r = kg / REFERENCE_KG;

  // Limb length scales with roughly the cube root of mass, not with mass - a
  // fighter 43% heavier is not 43% longer-armed, they are about 13% longer.
  // Using the linear ratio here was the first thing I wrote and it gave a
  // heavyweight a reach advantage so large that nothing else mattered.
  const linear = Math.cbrt(r);

  return {
    // Longer arms land sooner, so the threshold goes down as size goes up.
    // Damped to half the linear effect, for the balance reason in the header.
    reachScale: 1 / (1 + (linear - 1) * 0.5),
    // Power tracks mass fairly directly - it is momentum.
    power: 0.55 + 0.45 * r,
    // Chin tracks mass but flattens: past a point, more weight stops buying
    // more resilience.
    chin: 0.7 + 0.3 * Math.min(r, 1.35),
    // Lighter hands are faster. Inverse of the linear ratio, damped.
    handSpeed: 1 / (1 + (1 - linear) * 0.8),
    // Lighter fighters carry proportionally more gas.
    stamina: 100 / (0.7 + 0.3 * r),
    recovery: 6 / (0.75 + 0.25 * r),
    mass: kg,
  };
}

/** Stamina cost of a strike. */
export function drainOf(power: number, attrs: FighterAttributes): number {
  const base = 1.2 + 7.5 * power * power;
  // Heavier fighters spend more per punch - the other half of why they tire.
  return base * (0.75 + 0.25 * (attrs.mass / REFERENCE_KG));
}

/** How much a fighter's output degrades as they tire. */
export function fatigueMultiplier(stamina: number, max: number): number {
  const frac = Math.max(0, Math.min(1, stamina / max));
  // Cubic in the depleted fraction: 1.0 at full, ~0.94 at half, 0.55 at empty.
  const spent = 1 - frac;
  return 1 - 0.45 * spent * spent * spent;
}

/** Body-shape morph weights for a weight class, 0-1. */
export interface BodyMorphWeights {
  /** Overall mass: girth of torso and limbs. */
  bulk: number;
  /** Height and limb length. */
  stature: number;
  /** Muscle definition. Peaks in the middle classes, where fighters cut hard
   *  to make weight; it drops at both ends for different reasons. */
  definition: number;
}

export function morphWeightsFor(weightClass: WeightClass): BodyMorphWeights {
  const r = WEIGHT_LIMITS[weightClass] / REFERENCE_KG;
  const linear = Math.cbrt(r);
  return {
    bulk: clamp01((r - 0.6) / 0.95),
    stature: clamp01((linear - 0.85) / 0.35),
    definition: clamp01(1 - Math.abs(r - 1) * 1.4),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
