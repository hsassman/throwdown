// Fighter attributes, and what a weight class actually changes.
// The one that crosses a layer boundary
//
// Three of the four weight-class effects are simulation-layer scaling: damage,
// chin, speed, stamina. They are cheap, they live entirely in sim/, and
// nothing outside this folder has to know about them.
//
// Reach is different, and it is worth being explicit about why, because it is
// the one place this file reaches into the perception layer.
//
// Reach changes what lands. A heavyweight's arm is longer, so the same
// physical extension by the player in front of the camera should resolve as a
// strike sooner. That means scaling STRIKE_CONFIG.reachThreshold per fighter -
// a perception threshold, set by a simulation concept.
//
// This does not breach the architecture's separation, and the distinction
// matters: perception is still handed a number and still measures landmarks
// against it. What it must never do is read the character mesh to decide what
// lands - that would make hit resolution depend on how you are drawn. A scalar
// passed in from the fighter's stats is configuration, the same as any other
// tuning constant; the mesh is still never consulted.
//
// The honest caveat, recorded rather than hidden: a lower threshold makes
// strikes easier to land for the player, not just longer-ranged in fiction.
// Against a CPU that is fine. In a 1v1 it is a balance lever with real
// consequences, and risk log 13 already says there is no shared physical space
// to appeal to. So reach scaling is deliberately narrow - a few percent, not a
// multiplier - and 1v1 should probably lock both fighters to one class until
// it has been played.

import type { WeightClass } from "../menu/menuModel";
import { WEIGHT_LIMITS } from "../menu/menuModel";

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

/**
 * Attributes derived from the weight limit rather than hand-tuned per class.
 *
 * Written as a curve so that adding a class is one line in WEIGHT_LIMITS and
 * nothing here, and so the progression is guaranteed monotonic - a
 * hand-written table of eight rows is eight chances to make a middleweight
 * faster than a flyweight by accident.
 *
 * Middleweight is the reference point at 1.0 across the board, because that is
 * what the one existing mesh is.
 */
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

/**
 * Stamina cost of a strike.
 *
 * Scales with power and with how committed the extension was, so a flicked
 * range-finder is nearly free and a fully committed hook is not. Superlinear
 * in power on purpose: the whole tactical point of stamina is that head-hunting
 * with everything you have is a choice with a cost.
 */
export function drainOf(power: number, attrs: FighterAttributes): number {
  const base = 1.2 + 7.5 * power * power;
  // Heavier fighters spend more per punch - the other half of why they tire.
  return base * (0.75 + 0.25 * (attrs.mass / REFERENCE_KG));
}

/**
 * How much a fighter's output degrades as they tire.
 *
 * Returns a multiplier on power. Deliberately not linear: the first half of
 * the gas tank costs almost nothing, and the last quarter costs a lot. A
 * linear curve makes every round feel identically sluggish; this one makes
 * round three feel different from round one, which is the point.
 */
export function fatigueMultiplier(stamina: number, max: number): number {
  const frac = Math.max(0, Math.min(1, stamina / max));
  // Cubic in the depleted fraction: 1.0 at full, ~0.94 at half, 0.55 at empty.
  //
  // The obvious `sqrt(frac)` is wrong here and a test caught it - sqrt is
  // steep early and flat late, which is precisely backwards. It made the first
  // few punches of a round cost more output than the last few, so a fighter
  // felt worst at the start and acclimatised, which is not how gassing works.
  const spent = 1 - frac;
  return 1 - 0.45 * spent * spent * spent;
}

/**
 * Body-shape morph weights for a weight class, 0-1.
 *
 * Not wired to the mesh yet, and this is the honest part: the exported figure
 * has 20 body-identity morph targets but FBX2glTF dropped their names, so
 * there is nothing addressable to drive. Re-exporting through Blender restores
 * the names (its glTF exporter preserves shape keys), at which point these
 * weights have somewhere to go.
 *
 * Computed here anyway, rather than waiting, because it makes the dependency
 * explicit and because the curve is the part worth getting right - it is the
 * same cube-root reasoning as reach, and discovering that after wiring up a
 * mesh would mean re-tuning against a moving target.
 */
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
