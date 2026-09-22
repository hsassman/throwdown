import * as THREE from "three";
import {
  midpoint,
  EXTRA_POSE_KEYS,
  type AnyPoseKey,
  type Keypoint,
  type PoseFrame,
} from "../../pose/poseTypes";
import { PERCEPTION_CONFIG } from "../../config/tuning";
import {
  BONE_AIM_CHILD,
  BONE_GAIN,
  BONE_SOURCES,
  DRIVEN_BONES,
  SPINE_CHAIN,
  type AimedBoneName,
  type DrivenBoneName,
  type PointSpec,
} from "./rigJointMap";

// Purely cosmetic retargeting - see docs/ARCHITECTURE.md's "Why retargeting/
// lives under render/ and not perception/": this consumes the same landmark
// stream perception reads, but its output never feeds back into hit
// resolution, punch classification, or the simulation.
// How this works, and why the obvious approach doesn't
//
// Only the in-plane (screen x/y) direction of each limb is measurable. z is
// never used - the project-wide rule from the gesture-classification notes, since
// MediaPipe's depth is least reliable exactly along the axis punches travel.
//
// The naive fix - aim each bone at a direction with z forced to 0 - flattens
// the character, because real bind directions carry a substantial out-of-plane
// component (l_lowarm's is 0.557; the forearm genuinely angles forward). So
// instead each bone keeps its bind-pose out-of-plane component and only its
// in-plane azimuth is driven. That has a property worth stating: when the
// measured in-plane direction equals the bind in-plane direction, the computed
// target is exactly the bind direction, so the bone does not move at all. Rest
// pose is preserved perfectly rather than approximately.
//
// The solve is done entirely in the bone's parent space, against the parent's
// current world orientation, read fresh each frame. An earlier version cached
// the parent orientation as a constant "because the parent is never itself
// retargeted" - false for the forearms, whose parents are the driven upper
// arms. That produced a forearm hinging off a stale shoulder, one of the
// causes of the visibly broken first attempt. Bones are therefore solved in
// DRIVEN_BONES order, parents first.

/**
 * Where a bone should point. `x`/`y` are a unit 2D direction in world x/y.
 *
 * `z` is the out-of-plane component, and is optional: when omitted the bone
 * keeps its bind-pose depth (the safe default for joints we can't reason about
 *), and when present it overrides that. `x`/`y` are rescaled so the resulting
 * 3D direction stays unit length.
 *
 * Note this `z` is not MediaPipe's z landmark, which this project never reads.
 * It is recovered from foreshortening of x/y alone - see recoverDepth().
 */
export interface BoneTarget {
  x: number;
  y: number;
  z?: number;
}

export type BoneTargets = Partial<Record<DrivenBoneName, BoneTarget>>;

/** Arm bones whose depth can be recovered from foreshortening. */
export const ARM_BONES = ["l_uparm", "l_lowarm", "r_uparm", "r_lowarm"] as const;
export type ArmBoneName = (typeof ARM_BONES)[number];

/** Full limb lengths in torso units, refined per player by RigDriver. */
export type LimbLengths = Record<ArmBoneName, number>;

/**
 * Recovers how far a limb points out of the image plane, from how much its
 * projection has shortened. A limb of known length L whose projection measures
 * P is angled out of the plane by acos(P/L), giving an out-of-plane unit
 * component of sqrt(1 - (P/L)^2).
 *
 * This is the one signal that makes a punch thrown AT the camera actually
 * extend toward the viewer instead of barely moving - the exact motion a
 * frontal webcam otherwise cannot see, and the one that matters most in a
 * boxing game.
 *
 * Two honest limitations:
 *  - Sign is ambiguous. A limb pointing away foreshortens identically to one
 *    pointing forward, so the caller decides; for boxing, forward is right
 *    nearly always, and that is what RigDriver assumes.
 *  - It degrades when the limb points almost straight down the camera axis:
 *    P approaches 0, and small landmark noise swings the result. The value is
 *    clamped, and RigDriver smooths it over time.
 */
export function recoverDepth(projected: number, full: number): number {
  if (!(full > 1e-6) || !(projected >= 0)) return 0;
  const ratio = THREE.MathUtils.clamp(projected / full, 0, 1);
  return Math.sqrt(Math.max(0, 1 - ratio * ratio));
}

/**
 * How far outside the frame a cosmetic landmark may sit before it is rejected.
 *
 * BlazePose does not report "absent" for a body part below the bottom of the
 * frame - it extrapolates one, often with a healthy visibility score. At a
 * seated desk webcam that is the normal state of the legs, so a confidence
 * gate alone is not enough: the character would stand on invented knees that
 * twitch with every torso wobble. Positions are normalized to [0,1] over the
 * image, so anything well outside that is a guess, not a measurement.
 *
 * Applied only to the optional (cosmetic) landmarks. The arm chain is
 * deliberately exempt: a punch thrown at the camera legitimately pushes a
 * wrist to the very edge of frame, and that is the motion the game is about.
 */
const OUT_OF_FRAME_MARGIN = 0.12;

function inFrame(k: Keypoint): boolean {
  return (
    k.x >= -OUT_OF_FRAME_MARGIN &&
    k.x <= 1 + OUT_OF_FRAME_MARGIN &&
    k.y >= -OUT_OF_FRAME_MARGIN &&
    k.y <= 1 + OUT_OF_FRAME_MARGIN
  );
}

const OPTIONAL_KEYS = new Set<string>(EXTRA_POSE_KEYS);

function pointOf(pose: PoseFrame, key: AnyPoseKey, minConfidence: number): Keypoint | null {
  const k = pose[key];
  if (!k || k.confidence < minConfidence) return null;
  if (OPTIONAL_KEYS.has(key) && !inFrame(k)) return null;
  return k;
}

/**
 * Resolves a PointSpec against a pose: either one landmark or the midpoint of
 * two. Returns null when anything it needs is missing, below confidence, or
 * (for the cosmetic landmarks) outside the frame.
 *
 * The absence check is load-bearing rather than defensive: the leg and hand
 * landmarks genuinely are missing for most desk-webcam framings, and every
 * caller treats null as "leave this bone at rest".
 */
function resolvePoint(
  pose: PoseFrame,
  spec: PointSpec,
  minConfidence: number
): Keypoint | null {
  if (Array.isArray(spec)) {
    const a = pointOf(pose, spec[0] as AnyPoseKey, minConfidence);
    const b = pointOf(pose, spec[1] as AnyPoseKey, minConfidence);
    if (!a || !b) return null;
    return midpoint(a, b);
  }
  return pointOf(pose, spec as AnyPoseKey, minConfidence);
}

/**
 * In-plane direction between two points, in world orientation: image y is
 * flipped (it grows downward, world y grows up) and x is negated when the view
 * is mirrored, matching the mirrored webcam preview. Returns null when the two
 * coincide - a zero-length direction would normalize to NaN and silently wreck
 * every bone downstream.
 */
function planarDirection(
  from: Keypoint,
  to: Keypoint,
  mirrored: boolean
): BoneTarget | null {
  const dx = (to.x - from.x) * (mirrored ? -1 : 1);
  const dy = -(to.y - from.y);
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  return { x: dx / len, y: dy / len };
}

/** The landmark pair spanning each arm bone, per mirroring mode. */
function armPair(bone: ArmBoneName, mirrored: boolean) {
  return BONE_SOURCES[mirrored ? "mirrored" : "direct"][bone]!;
}

const ARM_BONE_SET = new Set<string>(ARM_BONES);

/**
 * Projected length of each arm bone this frame, in torso units - the input to
 * depth recovery. Torso-normalized so it means the same thing at any distance
 * from the camera, matching how every perception threshold is expressed.
 * Bones whose landmarks aren't tracked are omitted.
 */
export function measureLimbs(
  pose: PoseFrame,
  mirrored: boolean,
  torsoScale: number
): Partial<Record<ArmBoneName, number>> {
  const out: Partial<Record<ArmBoneName, number>> = {};
  if (!(torsoScale > 1e-6)) return out;
  const minConf = PERCEPTION_CONFIG.minLandmarkConfidence;

  for (const bone of ARM_BONES) {
    const { from, to } = armPair(bone, mirrored);
    const a = resolvePoint(pose, from, minConf);
    const b = resolvePoint(pose, to, minConf);
    if (!a || !b) continue;
    out[bone] = Math.hypot(b.x - a.x, b.y - a.y) / torsoScale;
  }
  return out;
}

/**
 * Head yaw and pitch, as raw normalized signals rather than angles.
 *
 * Yaw cannot come from a swing solve. Aiming a bone at a target fixes two
 * degrees of freedom and leaves rotation about that bone's own axis entirely
 * undetermined - and turning your head is exactly that rotation. So it is
 * measured separately here, from how the nose sits between the two ears:
 * face the camera and the nose is centred; turn away and it slides toward the
 * ear on the side you turned toward while that ear closes in behind the head.
 * The ratio is self-normalizing, so it needs no torso scale and holds at any
 * distance.
 *
 * Pitch is the nose's height relative to the ear line, in torso units. It
 * carries a per-person offset (where your nose sits relative to your ear
 * canals is anatomy, not posture), so the caller must subtract a learned
 * neutral - RigDriver does. Returns null if the head isn't tracked.
 */
export interface HeadSignals {
  /** -1 (turned fully one way) to +1. Positive = toward the character's left. */
  yaw: number;
  /** Nose below the ear line, torso units. Uncalibrated; subtract a neutral. */
  pitch: number;
}

export function measureHeadSignals(
  pose: PoseFrame,
  mirrored: boolean,
  torsoScale: number
): HeadSignals | null {
  const minConf = PERCEPTION_CONFIG.minLandmarkConfidence;
  const nose = pose.nose;
  const le = pose.leftEar;
  const re = pose.rightEar;
  if (
    nose.confidence < minConf ||
    le.confidence < minConf ||
    re.confidence < minConf ||
    !(torsoScale > 1e-6)
  ) {
    return null;
  }

  // Horizontal gap from the nose to each ear, in the raw image.
  const dLeft = Math.abs(le.x - nose.x);
  const dRight = Math.abs(nose.x - re.x);
  const sum = dLeft + dRight;
  if (sum < 1e-6) return null;

  // Positive when the player turns toward their own left. Under the mirrored
  // mapping the character's sides are swapped, so the sense flips with it -
  // the same rule every other signal here follows.
  const yaw = ((dRight - dLeft) / sum) * (mirrored ? -1 : 1);

  const earMidY = (le.y + re.y) / 2;
  const pitch = (nose.y - earMidY) / torsoScale;

  return { yaw, pitch };
}

/**
 * Computes the in-plane direction each driven bone should point this frame.
 * Bones whose source landmarks aren't confidently tracked are simply absent
 * from the result; callers leave those at rest pose rather than guessing.
 */
export function computeBoneTargets(
  pose: PoseFrame,
  mirrored: boolean,
  /** Supplying measured limb lengths enables depth recovery on the arms. Omit
   * it and every bone simply keeps its bind-pose depth. */
  limbFull?: LimbLengths,
  torsoScale?: number
): BoneTargets {
  const minConf = PERCEPTION_CONFIG.minLandmarkConfidence;
  const out: BoneTargets = {};

  const table = BONE_SOURCES[mirrored ? "mirrored" : "direct"];
  const measured =
    limbFull && torsoScale ? measureLimbs(pose, mirrored, torsoScale) : null;

  for (const [name, src] of Object.entries(table)) {
    const bone = name as AimedBoneName;
    const a = resolvePoint(pose, src.from, minConf);
    const b = resolvePoint(pose, src.to, minConf);
    // Absent or low-confidence landmarks mean this bone simply isn't driven
    // this frame. That is the normal case for legs and hands at a desk webcam,
    // not an error - the caller leaves those bones at rest.
    if (!a || !b) continue;

    const dir = planarDirection(a, b, mirrored);
    if (!dir) continue;

    if (ARM_BONE_SET.has(bone) && limbFull) {
      const projected = measured?.[bone as ArmBoneName];
      if (projected !== undefined) {
        // Positive z = toward the camera. The character faces +Z (verified from
        // foot geometry), and a foreshortened arm in boxing is nearly always
        // reaching forward rather than behind - see recoverDepth()'s note on
        // the sign ambiguity this resolves by assumption.
        dir.z = recoverDepth(projected, limbFull[bone as ArmBoneName]);
      }
    }
    out[bone] = dir;
  }

  return out;
}

/** Bind-pose data captured once, immediately after the rig loads and before
 * any retargeting has touched it. */
export interface BoneBindData {
  bone: THREE.Object3D;
  parent: THREE.Object3D;
  /** False for bones with no aim child (c_head), whose direction fields are
   * meaningless and which are driven by an explicit rotation instead. */
  aimed: boolean;
  /** Bone->child direction expressed in the parent's space, bind pose, unit. */
  bindDirParent: THREE.Vector3;
  /** Bone->child direction in world space, bind pose, unit. Only its z is
   * used - as the out-of-plane component to preserve. */
  bindDirWorld: THREE.Vector3;
  /** The bone's own bind-pose local quaternion. */
  bindLocalQuat: THREE.Quaternion;
  /** Bind-pose distance to the aim child - the segment's length. Used to
   * work out how much of a spine bend actually reaches the top of the chain. */
  bindChildDistance: number;
}

export class RetargetError extends Error {}

/**
 * Captures bind data for every driven bone. Throws rather than warning if the
 * rig doesn't match rigJointMap.ts: a silently half-bound rig renders as a
 * mangled character, which is far harder to diagnose than a thrown error
 * naming the exact bone.
 */
export function captureBindPose(root: THREE.Object3D): Map<DrivenBoneName, BoneBindData> {
  root.updateMatrixWorld(true);

  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name && !byName.has(o.name)) byName.set(o.name, o);
  });

  const binds = new Map<DrivenBoneName, BoneBindData>();

  for (const name of DRIVEN_BONES) {
    const bone = byName.get(name);
    if (!bone) throw new RetargetError(`rig is missing driven bone "${name}"`);
    const parent = bone.parent;
    if (!parent) throw new RetargetError(`driven bone "${name}" has no parent`);

    // Normalized deliberately: the exported asset's rotations are a hair off
    // unit length (c_spine0's is 0.999999991). That is harmless for rendering,
    // but it makes quaternion comparisons misbehave - Quaternion.angleTo() on
    // a slightly-short quaternion reports ~4e-4 radians against its own exact
    // copy, because acos amplifies a 1e-8 dot deficit. Normalizing here keeps
    // everything downstream exactly comparable.
    const bindLocalQuat = bone.quaternion.clone().normalize();

    const childName = BONE_AIM_CHILD[name];
    if (childName === null) {
      // Twist-driven bone (c_head): it has no meaningful continuation to aim
      // at, and its direction fields are never read. Recorded explicitly so a
      // future caller that does try to aim it fails loudly in applyBoneTarget
      // rather than quietly rotating toward a zero vector.
      binds.set(name, {
        bone,
        parent,
        aimed: false,
        bindDirParent: new THREE.Vector3(),
        bindDirWorld: new THREE.Vector3(),
        bindLocalQuat,
        bindChildDistance: 0,
      });
      continue;
    }

    const child = bone.children.find((c) => c.name === childName);
    if (!child) {
      throw new RetargetError(
        `driven bone "${name}" is missing its aim child "${childName}"`
      );
    }

    // Bone-local direction toward the child is just the child's local offset.
    const dLocal = child.position.clone();
    if (dLocal.lengthSq() < 1e-12) {
      throw new RetargetError(
        `aim child "${childName}" of "${name}" sits at zero distance; ` +
          `normalizing it would produce NaN`
      );
    }
    dLocal.normalize();

    const bindDirParent = dLocal.clone().applyQuaternion(bindLocalQuat).normalize();

    const boneWorld = new THREE.Vector3();
    const childWorld = new THREE.Vector3();
    bone.getWorldPosition(boneWorld);
    child.getWorldPosition(childWorld);
    const segment = childWorld.sub(boneWorld);
    const bindChildDistance = segment.length();
    const bindDirWorld = segment.normalize();

    binds.set(name, {
      bone,
      parent,
      aimed: true,
      bindDirParent,
      bindDirWorld,
      bindLocalQuat,
      bindChildDistance,
    });
  }

  return binds;
}

// Scratch objects, reused every frame so the render loop allocates nothing.
const _parentQuat = new THREE.Quaternion();
const _targetWorld = new THREE.Vector3();
const _targetParent = new THREE.Vector3();
const _swing = new THREE.Quaternion();

/**
 * Aims one bone along a measured in-plane direction, preserving its bind-pose
 * out-of-plane tilt. Reads the parent's current world orientation, so callers
 * must solve parents before children (DRIVEN_BONES is ordered for this).
 */
/**
 * The rotation, in the bone's parent space, that takes its bind direction to
 * the requested target. Written into `_swing` and returned; not reentrant.
 * Returns null when the target degenerates.
 */
/**
 * The unit world-space direction a bone should point, combining the measured
 * in-plane direction with either the recovered depth or the bind-pose depth.
 * Written into `_targetWorld`.
 */
function buildTargetWorld(bind: BoneBindData, target: BoneTarget): THREE.Vector3 {
  const bz = THREE.MathUtils.clamp(target.z ?? bind.bindDirWorld.z, -1, 1);
  const bxy = Math.sqrt(Math.max(0, 1 - bz * bz));
  return _targetWorld.set(target.x * bxy, target.y * bxy, bz);
}

function computeSwing(bind: BoneBindData, target: BoneTarget): THREE.Quaternion | null {
  buildTargetWorld(bind, target);

  // Solve in the parent's frame, against where the parent actually is now.
  bind.parent.updateWorldMatrix(true, false);
  bind.parent.getWorldQuaternion(_parentQuat);
  _targetParent.copy(_targetWorld).applyQuaternion(_parentQuat.invert());

  if (_targetParent.lengthSq() < 1e-12) return null;
  _targetParent.normalize();

  return _swing.setFromUnitVectors(bind.bindDirParent, _targetParent);
}

const _noSwing = new THREE.Quaternion();

/**
 * Aims one bone at a measured direction. `gain` below 1 takes a fraction of
 * the swing, for joints whose measured direction moves further than the joint
 * itself does (the clavicles) or whose landmarks are noisy (the wrists).
 */
export function applyBoneTarget(
  bind: BoneBindData,
  target: BoneTarget,
  gain = 1
): void {
  if (!bind.aimed) return;
  const swing = computeSwing(bind, target);
  if (!swing) return;
  if (gain < 1) _noSwing.identity().slerp(swing, THREE.MathUtils.clamp(gain, 0, 1));
  bind.bone.quaternion
    .copy(gain < 1 ? _noSwing : swing)
    .multiply(bind.bindLocalQuat);
}

const _yawQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
const _headWorld = new THREE.Quaternion();
const _headLocal = new THREE.Quaternion();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldRight = new THREE.Vector3(1, 0, 0);

/**
 * Turns and nods the head. Angles are in radians, already calibrated and
 * clamped by the caller.
 *
 * This exists because a swing solve structurally cannot produce it: aiming a
 * bone at a point pins two degrees of freedom and leaves rotation about the
 * bone's own axis free, and head yaw is that rotation. So the head is the one
 * driven bone with no aim child (BONE_AIM_CHILD maps it to null) and is
 * rotated explicitly instead.
 *
 * Positive `yaw` turns the head toward the character's own left (+X); positive
 * `pitch` drops the chin. Both are built in world space - the character stands
 * upright, so world Y and X really are its turn and nod axes - then conjugated
 * into the head's parent frame, the same way applySpineBend() does, because
 * `c_neck` carries a bind rotation that would otherwise send the axes askew.
 */
export function applyHeadOrientation(
  binds: Map<DrivenBoneName, BoneBindData>,
  yaw: number,
  pitch: number
): void {
  const bind = binds.get("c_head");
  if (!bind) return;

  _yawQuat.setFromAxisAngle(_worldUp, yaw);
  _pitchQuat.setFromAxisAngle(_worldRight, pitch);
  // Nod first, then turn about the vertical: composing the other way swings
  // the nod axis with the yaw and tilts the head as it turns.
  _headWorld.copy(_yawQuat).multiply(_pitchQuat);

  bind.parent.updateWorldMatrix(true, false);
  bind.parent.getWorldQuaternion(_parentQuat);
  _headLocal
    .copy(_parentQuat)
    .invert()
    .multiply(_headWorld)
    .multiply(_parentQuat);

  bind.bone.quaternion.copy(_headLocal).multiply(bind.bindLocalQuat);
}

const _identity = new THREE.Quaternion();
const _partial = new THREE.Quaternion();
const _spineLocal = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** Largest torso lean we'll ask for, radians. Compensation multiplies the
 * requested angle, so this stops a tracking glitch folding the body in half. */
const MAX_SPINE_ANGLE = (75 * Math.PI) / 180;

/** Multiplies a rotation's angle about its own axis, in place. */
function scaleRotation(q: THREE.Quaternion, gain: number): void {
  const w = THREE.MathUtils.clamp(q.w, -1, 1);
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (angle < 1e-6 || s < 1e-6) return; // no rotation; axis is undefined
  _axis.set(q.x / s, q.y / s, q.z / s);
  q.setFromAxisAngle(
    _axis,
    THREE.MathUtils.clamp(angle * gain, -MAX_SPINE_ANGLE, MAX_SPINE_ANGLE)
  );
}

/**
 * How much of a distributed bend survives to the visible torso chord, inverted
 * so it can be used as a gain.
 *
 * Each segment ends up rotated by the cumulative weight up to and including
 * it, and the chord is those segment directions averaged by length - so a
 * top-heavy weighting (which looks natural) systematically under-leans.
 */
function chordCompensation(binds: Map<DrivenBoneName, BoneBindData>): number {
  let weighted = 0;
  let total = 0;
  let cumulative = 0;
  for (const { bone, weight } of SPINE_CHAIN) {
    cumulative += weight;
    const bind = binds.get(bone);
    if (!bind) continue;
    weighted += bind.bindChildDistance * cumulative;
    total += bind.bindChildDistance;
  }
  if (total < 1e-9) return 1;
  const reach = weighted / total;
  return reach > 1e-3 ? 1 / reach : 1;
}

/**
 * Leans the whole torso rather than hinging it at the waist. One measured
 * direction (hips -> shoulders) is turned into a single swing, and each spine
 * segment takes a fraction of it, so the chain's bind-pose curvature survives
 * instead of being straightened out. See SPINE_CHAIN for the weights and the
 * approximation they rely on.
 */
export function applySpineBend(
  binds: Map<DrivenBoneName, BoneBindData>,
  target: BoneTarget
): void {
  const base = binds.get("c_spine0");
  if (!base) return;

  // The lean is defined in world space - one rotation taking the torso's bind
  // direction to where it should now point.
  const targetWorld = buildTargetWorld(base, target);
  if (targetWorld.lengthSq() < 1e-12) return;
  const totalWorld = new THREE.Quaternion().setFromUnitVectors(
    base.bindDirWorld,
    targetWorld.clone().normalize()
  );

  // Distributing a bend across a chain makes the torso lean less than the
  // requested angle: what is visible is the chord from the base of the spine
  // to the neck, and the lower segments have only rotated by part of the
  // total. Measured on this rig it came out at a consistent 60% across 10-45
  // degrees, so the shortfall is scaled back out here. The factor is derived
  // from the rig's own segment lengths rather than hardcoded, so a re-export
  // with different proportions stays correct.
  scaleRotation(totalWorld, chordCompensation(binds));

  for (const { bone, weight } of SPINE_CHAIN) {
    const bind = binds.get(bone);
    if (!bind) continue;

    // This segment's share of the lean, still in world space.
    _partial.copy(_identity).slerp(totalWorld, weight);

    // Conjugate it into this bone's own parent frame. Doing this per bone
    // matters: an earlier version reused c_spine0's parent-space swing for
    // every segment, but c_spine0 carries a ~90 degree bind rotation, so the
    // axis was wrong for the rest of the chain and the torso reached barely a
    // sixth of the requested lean. Read the parent's current orientation, so
    // each segment's share composes on top of the ones already applied.
    bind.parent.updateWorldMatrix(true, false);
    bind.parent.getWorldQuaternion(_parentQuat);
    _spineLocal
      .copy(_parentQuat)
      .invert()
      .multiply(_partial)
      .multiply(_parentQuat);

    bind.bone.quaternion.copy(_spineLocal).multiply(bind.bindLocalQuat);
    bind.bone.updateWorldMatrix(false, false);
  }
}

/** Returns a bone to its exact exported rest rotation. */
export function resetBoneToBind(bind: BoneBindData): void {
  bind.bone.quaternion.copy(bind.bindLocalQuat);
}

/**
 * Solves every driven bone for one frame. Bones with no tracked target this
 * frame snap back to rest rather than freezing at a stale rotation.
 */
const SPINE_BONES = new Set<DrivenBoneName>(SPINE_CHAIN.map((s) => s.bone));

export function applyPoseToRig(
  binds: Map<DrivenBoneName, BoneBindData>,
  targets: BoneTargets,
  /** Calibrated head angles in radians. Omitted or null returns the head to
   * its rest orientation, which is what "untracked" should look like. */
  head?: { yaw: number; pitch: number } | null
): void {
  // The spine is solved as one unit - the measured direction arrives under
  // c_spine0 and is shared across the chain - so it runs before anything
  // hanging off it (neck, arms) reads its orientation.
  const spineTarget = targets.c_spine0;
  if (spineTarget) {
    applySpineBend(binds, spineTarget);
  } else {
    for (const name of SPINE_BONES) {
      const bind = binds.get(name);
      if (bind) resetBoneToBind(bind);
    }
  }

  for (const name of DRIVEN_BONES) {
    if (SPINE_BONES.has(name)) continue;
    const bind = binds.get(name);
    if (!bind) continue;
    // c_head is never aimed - applyHeadOrientation() drives it, and it is
    // called unconditionally below so the head still returns to rest when the
    // player isn't tracked.
    if (!bind.aimed) continue;
    const target = targets[name];
    if (target) applyBoneTarget(bind, target, BONE_GAIN[name] ?? 1);
    else resetBoneToBind(bind);
  }

  applyHeadOrientation(binds, head?.yaw ?? 0, head?.pitch ?? 0);
}

export { DRIVEN_BONES };
