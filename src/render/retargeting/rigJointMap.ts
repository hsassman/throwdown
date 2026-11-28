// Verified against the real MHR export (public/models/boxer_lod3.glb) with
// tools/rig-introspect.mjs - run that script rather than guessing if the mesh
// is ever re-exported. Everything here is read off the actual asset.

import type { AnyPoseKey } from "../../pose/poseTypes";

/** Driven bones, in the order they must be updated: parents before children. */
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

/** The torso bends across four segments rather than hinging at one joint. */
export const SPINE_CHAIN = [
  { bone: "c_spine0", weight: 0.2 },
  { bone: "c_spine1", weight: 0.25 },
  { bone: "c_spine2", weight: 0.28 },
  { bone: "c_spine3", weight: 0.27 },
] as const satisfies ReadonlyArray<{ bone: DrivenBoneName; weight: number }>;

/**
 * The child each driven bone aims at - its real continuation down the chain,
 * confirmed to sit at a non-zero distance in bind pose.
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

/** How much of the full measured swing each bone actually takes, 0-1. */
export const BONE_GAIN: Partial<Record<DrivenBoneName, number>> = {
  l_clavicle: 0.55,
  r_clavicle: 0.55,
  l_wrist: 0.7,
  r_wrist: 0.7,
};

/**
 * Limb lengths in torso units (one shoulder-to-hip length), measured off the
 * exported rig: upper arm 0.2568 / 0.475 torso, forearm 0.270 / 0.475.
 */
export const LIMB_TORSO_LENGTH = {
  uparm: 0.54,
  lowarm: 0.57,
} as const;

/** A point to measure from or to: one landmark, or the midpoint of two. */
export type PointSpec = AnyPoseKey | readonly [AnyPoseKey, AnyPoseKey];

export interface LimbSource {
  from: PointSpec;
  to: PointSpec;
}

const SHOULDER_MID = ["leftShoulder", "rightShoulder"] as const;
const HIP_MID = ["leftHip", "rightHip"] as const;
const EAR_MID = ["leftEar", "rightEar"] as const;

/** Which tracked segment drives which bone, per mapping mode. */
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

/** Each bone keeps its slot and takes the opposite side's landmarks. */
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

/** The two ways of framing the character, and the mapping each one implies. */
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

/** The finger chains present on the exported rig, verified by introspection. */
export const FINGER_CHAINS = [
  { name: "thumb", segments: [0, 1, 2, 3] },
  { name: "index", segments: [1, 2, 3] },
  { name: "middle", segments: [1, 2, 3] },
  { name: "ring", segments: [1, 2, 3] },
  { name: "pinky", segments: [0, 1, 2, 3] },
] as const satisfies ReadonlyArray<{ name: string; segments: readonly number[] }>;

export type FingerName = (typeof FINGER_CHAINS)[number]["name"];

/** Curl at a full fist, radians per segment. */
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
