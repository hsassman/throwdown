// Verified against the real MHR export (public/models/boxer_lod3.glb) with
// tools/rig-introspect.mjs - run that script rather than guessing if the mesh
// is ever re-exported. Everything here is read off the actual asset.
//
// Ground truth that matters, and cost a broken first attempt to learn:
//
// 1. The rig is anatomically correct and faces +Z. `l_*` bones sit at world
//    +X, `r_*` at world -X. Re-measured with full world transforms (not just
//    summed translations, which ignore rotation and give nonsense): l_uparm
//    +0.176, r_uparm -0.176; eyes at z=+0.105 and the balls of the feet at
//    z=+0.075 against ankles at z=-0.062, so the figure genuinely faces +Z.
//
// 2. Which side of the screen a bone appears on depends on the camera, and
//    this project now places it behind the character (see VIEW_MODES). From
//    behind, world -X is screen-right, so `r_*` renders screen-right - which
//    is what makes the player's right arm drive a bone on the same side of the
//    screen and the anatomically matching side. See the note on VIEW_MODES.
//
// 3. Several joints have a child at distance exactly zero (`*_twist0_proc`
//    helpers, and `Collision_75` under c_neck). Normalizing a zero-length
//    vector yields NaN, which silently propagates through every quaternion
//    downstream and destroys the pose. That is why the child of each driven
//    bone is named explicitly below instead of picked by a "first bone child"
//    heuristic - that heuristic happened to work here by luck, which is not a
//    property worth depending on.
//
// 4. Bind directions carry a real out-of-plane (Z) component - `l_lowarm`'s is
//    0.557, a forearm angled substantially forward. Retargeting must preserve
//    that, not flatten it to zero; see mediapipeToMhrRig.ts.

import type { AnyPoseKey } from "../../pose/poseTypes";

/**
 * Driven bones, in the order they must be updated: parents before children.
 *
 * `c_spine0` moves the whole upper body, so it leads; the clavicles must be
 * solved before the upper arms that hang off them; each `*_lowarm` depends on
 * its `*_uparm`, and each `*_wrist` on its `*_lowarm` (via the undriven
 * `*_wrist_twist` it is parented under). Reordering this list silently
 * produces a wrong pose rather than an error.
 */
export const DRIVEN_BONES = [
  "c_spine0",
  "c_spine1",
  "c_spine2",
  "c_spine3",
  "l_clavicle",
  "r_clavicle",
  "c_neck",
  "c_head",
  "l_uparm",
  "l_lowarm",
  "l_wrist",
  "r_uparm",
  "r_lowarm",
  "r_wrist",
  "l_upleg",
  "l_lowleg",
  "r_upleg",
  "r_lowleg",
] as const;

export type DrivenBoneName = (typeof DRIVEN_BONES)[number];

/**
 * The torso bends across four segments rather than hinging at one joint.
 *
 * All four share one measured direction (hips -> shoulders); each takes a
 * fraction of the total bend, summing to 1. Driving only `c_spine0` put the
 * entire lean on a single joint, which reads as a hinge at the waist instead
 * of a spine. Weights rise toward the top because a boxer's slip comes more
 * from the upper back than the lumbar spine.
 *
 * Two things this got wrong on the first attempt, both measured rather than
 * reasoned, and both now covered by tests:
 *
 *  - The fractional rotation must be conjugated into each bone's own parent
 *    frame. Computing it once in c_spine0's parent space and reusing it looked
 *    reasonable - c_spine1/2/3 do have identity local rotations - but c_spine0
 *    itself carries a ~90 degree bind rotation, so the axis was wrong for the
 *    rest of the chain and the torso reached barely a sixth of the requested
 *    lean.
 *  - Distributing a bend makes the visible torso lean less than asked. What
 *    the eye reads is the chord from spine base to neck, and the lower
 *    segments have only rotated partway. On this rig that came to a consistent
 *    60%, so applySpineBend() scales it back out, using a factor derived from
 *    the rig's own segment lengths.
 */
export const SPINE_CHAIN = [
  { bone: "c_spine0", weight: 0.2 },
  { bone: "c_spine1", weight: 0.25 },
  { bone: "c_spine2", weight: 0.28 },
  { bone: "c_spine3", weight: 0.27 },
] as const satisfies ReadonlyArray<{ bone: DrivenBoneName; weight: number }>;

/**
 * The child each driven bone aims at - its real continuation down the chain,
 * confirmed to sit at a non-zero distance in bind pose.
 *
 * `null` means the bone is not aimed at anything. `c_head` is the only one:
 * turning your head is a twist about the neck axis, and a swing-only aim
 * solve cannot express a twist at all - pointing a bone at a target leaves
 * rotation about that bone's own axis completely undetermined. So the head is
 * driven by an explicit yaw/pitch rotation instead; see applyHeadOrientation().
 *
 * `*_lowarm` aims at `*_wrist_twist` rather than `*_wrist`: the wrist bone is
 * parented under the twist helper, and the twist helper is the joint that
 * actually carries the forearm's length (0.270 units).
 */
export const BONE_AIM_CHILD: Record<DrivenBoneName, string | null> = {
  c_spine0: "c_spine1",
  c_spine1: "c_spine2",
  c_spine2: "c_spine3",
  c_spine3: "c_neck",
  l_clavicle: "l_uparm",
  r_clavicle: "r_uparm",
  c_neck: "c_head",
  c_head: null,
  l_uparm: "l_lowarm",
  l_lowarm: "l_wrist_twist",
  l_wrist: "l_middle1",
  r_uparm: "r_lowarm",
  r_lowarm: "r_wrist_twist",
  r_wrist: "r_middle1",
  l_upleg: "l_lowleg",
  l_lowleg: "l_foot",
  r_upleg: "r_lowleg",
  r_lowleg: "r_foot",
};

/**
 * How much of the full measured swing each bone actually takes, 0-1.
 *
 * Not every joint should track its measurement one-for-one. The clavicle is
 * the clear case: the direction from the shoulder midpoint to a shoulder moves
 * far more than the collarbone under it does, so aiming the clavicle straight
 * at it throws the shoulder around. The wrist is damped because MediaPipe's
 * hand points are the noisiest landmarks in the set - they sit at the end of
 * the longest kinematic chain, and at a desk webcam they are small and often
 * motion-blurred.
 *
 * Bones absent from this map take the full swing.
 */
export const BONE_GAIN: Partial<Record<DrivenBoneName, number>> = {
  l_clavicle: 0.55,
  r_clavicle: 0.55,
  l_wrist: 0.7,
  r_wrist: 0.7,
};

/**
 * Limb lengths in torso units (one shoulder-to-hip length), measured off the
 * exported rig: upper arm 0.2568 / 0.475 torso, forearm 0.270 / 0.475.
 *
 * Used as the starting estimate for depth recovery (see mediapipeToMhrRig.ts).
 * They are only a seed - the driver refines them per player from what it
 * actually observes, because real limb-to-torso proportion varies by body.
 */
export const LIMB_TORSO_LENGTH = {
  uparm: 0.54,
  lowarm: 0.57,
} as const;

/**
 * A point to measure from or to: one landmark, or the midpoint of two.
 *
 * Midpoints matter more than they look. The spine is measured hip-midpoint to
 * shoulder-midpoint, and the neck is measured shoulder-midpoint to ear
 * midpoint rather than to the nose. The nose was the obvious choice and is the
 * wrong one: it swings sideways when you merely turn your head, so head yaw
 * leaked into neck tilt and the character bent sideways whenever the player
 * looked to one side. The ear midpoint sits close to the axis the head turns
 * about, so it stays put under yaw and moves only under real tilt.
 */
export type PointSpec = AnyPoseKey | readonly [AnyPoseKey, AnyPoseKey];

export interface LimbSource {
  from: PointSpec;
  to: PointSpec;
}

const SHOULDER_MID = ["leftShoulder", "rightShoulder"] as const;
const HIP_MID = ["leftHip", "rightHip"] as const;
const EAR_MID = ["leftEar", "rightEar"] as const;

/**
 * Which tracked segment drives which bone, per mapping mode.
 *
 * `direct` is the anatomical mapping and is what the game uses: the player's
 * right arm drives the character's right arm. Paired with the camera sitting
 * behind the character (VIEW_MODES.behind), that is also the same side of the
 * screen the player sees their own arm on in the mirrored preview - so
 * anatomy and screen position agree, which is why every boxing game frames it
 * this way.
 *
 * `mirrored` is the reflection mapping, kept for the front-on "facing" view:
 * there the character faces the player, so its left side is what renders on
 * the same screen side as the player's right arm.
 *
 * Bones with no entry (the spine, which uses midpoints, and c_head, which is
 * twist-driven) are handled directly in computeBoneTargets().
 */
export type AimedBoneName = Exclude<DrivenBoneName, "c_head">;

type SourceTable = Partial<Record<AimedBoneName, LimbSource>>;

const DIRECT_SOURCES: SourceTable = {
  c_spine0: { from: HIP_MID, to: SHOULDER_MID },
  c_neck: { from: SHOULDER_MID, to: EAR_MID },

  l_clavicle: { from: SHOULDER_MID, to: "leftShoulder" },
  r_clavicle: { from: SHOULDER_MID, to: "rightShoulder" },

  l_uparm: { from: "leftShoulder", to: "leftElbow" },
  l_lowarm: { from: "leftElbow", to: "leftWrist" },
  l_wrist: { from: "leftWrist", to: ["leftIndex", "leftPinky"] },
  r_uparm: { from: "rightShoulder", to: "rightElbow" },
  r_lowarm: { from: "rightElbow", to: "rightWrist" },
  r_wrist: { from: "rightWrist", to: ["rightIndex", "rightPinky"] },

  l_upleg: { from: "leftHip", to: "leftKnee" },
  l_lowleg: { from: "leftKnee", to: "leftAnkle" },
  r_upleg: { from: "rightHip", to: "rightKnee" },
  r_lowleg: { from: "rightKnee", to: "rightAnkle" },
};

/** Swaps every `left*`/`right*` landmark in a spec - the whole difference
 * between the two mapping modes, derived rather than retyped so the two tables
 * can never drift apart. */
function swapSide<T extends PointSpec>(spec: T): PointSpec {
  const flip = (k: AnyPoseKey): AnyPoseKey =>
    (k.startsWith("left")
      ? `right${k.slice(4)}`
      : k.startsWith("right")
        ? `left${k.slice(5)}`
        : k) as AnyPoseKey;
  return Array.isArray(spec)
    ? ([flip(spec[0]), flip(spec[1])] as const)
    : flip(spec as AnyPoseKey);
}

/**
 * Each bone keeps its slot and takes the opposite side's landmarks.
 *
 * Swapping the landmarks is enough on its own. Swapping the bone as well -
 * which reads like the more thorough thing to do - applies the reflection
 * twice and lands back exactly on `direct`, silently producing a "mirrored"
 * table identical to the unmirrored one.
 */
const MIRRORED_SOURCES: SourceTable = Object.fromEntries(
  Object.entries(DIRECT_SOURCES).map(([bone, src]) => [
    bone,
    { from: swapSide(src.from), to: swapSide(src.to) },
  ])
) as SourceTable;

export const BONE_SOURCES: Record<"mirrored" | "direct", SourceTable> = {
  direct: DIRECT_SOURCES,
  mirrored: MIRRORED_SOURCES,
};

/**
 * The two ways of framing the character, and the mapping each one implies.
 *
 * These two settings are not independent, which is the whole reason they live
 * in one object. Changing the camera side without changing the mapping (or the
 * reverse) puts the character's arms on the wrong side of the screen - the
 * exact symptom that prompted this rework. `cameraSide` is the sign of the Z
 * offset the camera is placed at; the character faces +Z.
 */
export const VIEW_MODES = {
  /** Over-the-shoulder, the standard fighting-game view. Camera behind the
   * character at -Z, so world -X is screen-right and the anatomically-correct
   * `r_*` bones render on the same side as the player's own right arm. */
  behind: { cameraSide: -1, mirrored: false },
  /** Front-on, character faces the player like a reflection. */
  facing: { cameraSide: +1, mirrored: true },
} as const;

export type ViewMode = keyof typeof VIEW_MODES;

export type HandSideKey = "l" | "r";

/**
 * The finger chains present on the exported rig, verified by introspection.
 *
 * Every finger carries three phalanges plus a `*_null` tip marker, and the
 * pinky and thumb additionally have a metacarpal (`*0`). The tip marker is not
 * a segment - nothing is skinned to it - but it is what makes the curl
 * direction measurable, so it is found separately in handRig.ts.
 */
export const FINGER_CHAINS = [
  { name: "thumb", segments: [0, 1, 2, 3] },
  { name: "index", segments: [1, 2, 3] },
  { name: "middle", segments: [1, 2, 3] },
  { name: "ring", segments: [1, 2, 3] },
  { name: "pinky", segments: [0, 1, 2, 3] },
] as const satisfies ReadonlyArray<{ name: string; segments: readonly number[] }>;

export type FingerName = (typeof FINGER_CHAINS)[number]["name"];

/**
 * Curl at a full fist, radians per segment.
 *
 * These follow real hand anatomy and the rig's own measured proportions. The
 * middle finger's segments are 0.0429 / 0.0275 / 0.0235 long and its knuckle
 * sits 0.082 from the wrist, so a fully closed fist needs the cumulative
 * rotation to carry the fingertip right back into the palm - roughly
 * 90 + 100 + 72 degrees. Anything much shallower leaves the hand cupped, which
 * is exactly what the first attempt looked like.
 *
 * The thumb is deliberately shallow here because it does not curl into the
 * palm at all: captureThumb() aims it across the folded fingers, and these
 * angles only wrap the last joints around once it is there.
 */
export const FINGER_CURL: Record<FingerName, Record<number, number>> = {
  thumb: { 0: 0.0, 1: 0.35, 2: 0.5, 3: 0.4 },
  index: { 1: 1.57, 2: 1.75, 3: 1.25 },
  middle: { 1: 1.6, 2: 1.78, 3: 1.28 },
  ring: { 1: 1.57, 2: 1.75, 3: 1.25 },
  pinky: { 0: 0.18, 1: 1.5, 2: 1.7, 3: 1.2 },
};

/**
 * Shape constants for closing the hand, separate from the per-joint curl.
 */
export const HAND_SHAPE = {
  /**
   * How much of each finger's measured splay is cancelled when the fist
   * closes. 1.0 brings every finger exactly parallel to the middle one.
   *
   * Slightly under 1 on purpose: real fingers converge but do not become
   * perfectly parallel, and driving them to exactly parallel makes the
   * outer two visibly interpenetrate at the knuckles, since the mesh has
   * real thickness the skeleton knows nothing about.
   */
  adductGain: 0.9,

  /** Secant iterations used to solve each finger's adduction against the
   * closed fist. Converges well inside this; the cap only bounds the cost. */
  adductSolveIterations: 12,

  /** Fingertip placement accuracy the solve aims for, world units. The mesh's
   * fingers are ~0.02 thick, so this is well inside a tenth of a finger. */
  adductTolerance: 0.0004,

  /** Hard limit on how far a knuckle may be swung sideways, radians (~17deg).
   * Real knuckle adduction is small; the solve should land near 8 degrees, and
   * anything pressing against this limit means the target is wrong rather than
   * the finger being stubborn - which is exactly how solving for the buried
   * fingertip was caught. */
  adductMax: 0.3,

  /** How far off the index/middle phalanges the thumb sits, world units.
   * The mesh's fingers are ~0.02 thick, so this clears them without floating. */
  thumbPalmOffset: 0.012,

  /** Fraction of the full aim rotation the thumb takes. Under 1 because the
   * aim is measured to the tip but applied at the base joint, so taking all of
   * it overshoots once the outer joints wrap as well. */
  thumbAimGain: 0.78,
} as const;

/** Everything else - jaw, eyes, feet, twist helpers and the collision
 * markers - has no tracked source and stays at its exported rest pose.
 * See docs/asset-pipeline.md's joint-coverage table. */
