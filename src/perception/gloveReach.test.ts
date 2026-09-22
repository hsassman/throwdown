import { describe, it, expect } from "vitest";
import { STRIKE_CONFIG, TARGET_CONFIG } from "../config/tuning";

// Guards the one number that ties perception to the render layer.
// Hit detection reads landmarks only and never the character mesh, so it
// cannot see the glove. The glove's reach therefore enters as a constant
// measured offline (STRIKE_CONFIG.gloveNoseReach), while the distance the
// target stands at lives in the render layer (TARGET_CONFIG.distance).
//
// Those two are only correct together. Nothing in the type system relates
// them, and the last time they drifted the symptom was the glove passing
// straight through the opponent's head on every straight punch -- the target
// distance had been derived for a bare fist, before gloves existed, and was
// never revisited when they arrived.
//
// So the geometry is recomputed here from the measured rig numbers and checked
// against both constants. If either is edited alone, this fails.

/** Measured once from blender/out/boxer.blend. See TARGET_CONFIG.distance. */
const RIG = {
  /** Shoulder-midpoint to hip-midpoint, world units. The unit of "torso". */
  torso: 0.51518,
  /** Shoulder joint to wrist, world units. */
  armLength: 0.5268,
  /** Player shoulder height along the punch axis, world units. */
  shoulderZ: -0.0322,
  /** Glove nose beyond the wrist, world units. */
  gloveNose: 0.17561,
  /** Bare fingertip beyond the wrist, world units. */
  bareFist: 0.15009,
  /** Target's head front surface, forward of that figure's own centre. */
  headFront: 0.1551,
  /** Allowed glove compression at full extension. A padded glove squashes on
   *  impact; one that stops dead on the skin reads as a mime. */
  maxCompression: 0.05,
};

describe("glove reach against the target distance", () => {
  it("states the glove's reach in torso units, matching the rig", () => {
    expect(STRIKE_CONFIG.gloveNoseReach).toBeCloseTo(
      RIG.gloveNose / RIG.torso,
      3
    );
    expect(STRIKE_CONFIG.bareFistReach).toBeCloseTo(
      RIG.bareFist / RIG.torso,
      3
    );
  });

  it("gives the glove more reach than a bare fist, but not much", () => {
    // 0.0495 torso -- about 2.5cm. A glove is padding, not a weapon extension.
    const gain = STRIKE_CONFIG.gloveNoseReach - STRIKE_CONFIG.bareFistReach;
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(0.1);
  });

  it("puts the GLOVE on the target's face at the moment a hit registers", () => {
    // This is the whole point: the strike lands from the end of the glove, not
    // from the wrist with the glove already buried in the head.
    const extensionFraction =
      STRIKE_CONFIG.reachThreshold / (RIG.armLength / RIG.torso);
    const wrist = RIG.armLength * extensionFraction;
    const nose = RIG.shoulderZ + wrist + RIG.gloveNose;
    const faceAt = TARGET_CONFIG.distance - RIG.headFront;
    expect(nose).toBeCloseTo(faceAt, 2);
  });

  it("does not drive the glove through the head at full extension", () => {
    const nose = RIG.shoulderZ + RIG.armLength + RIG.gloveNose;
    const faceAt = TARGET_CONFIG.distance - RIG.headFront;
    const overlap = nose - faceAt;
    expect(overlap).toBeGreaterThan(0); // must still make contact
    expect(overlap).toBeLessThan(RIG.maxCompression);
  });

  it("would have clipped at the pre-glove distance, which is why this exists", () => {
    // Regression guard on the actual bug: 0.72 was derived for a bare fist.
    const nose = RIG.shoulderZ + RIG.armLength + RIG.gloveNose;
    const oldFaceAt = 0.72 - RIG.headFront;
    expect(nose - oldFaceAt).toBeGreaterThan(RIG.maxCompression);
  });

  it("keeps the target at arm's length, not inside the player", () => {
    // Two bodies ~0.39 deep must not interpenetrate.
    expect(TARGET_CONFIG.distance).toBeGreaterThan(0.39);
  });
});
