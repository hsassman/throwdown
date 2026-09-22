import * as THREE from "three";
import { applyBoneTarget, type BoneBindData } from "./mediapipeToMhrRig";
import type { DrivenBoneName } from "./rigJointMap";

// Two-bone inverse kinematics for a leg: given where the ankle has to BE, work
// out where the thigh and shin have to point.
// WHY THE LEGS NEEDED INVERTING AT ALL
//
// Every other bone in this project is driven FORWARD: a direction is measured
// from the camera and the bone is aimed along it. That works because the
// measurement is of the bone itself.
//
// A foot is different. What matters about a planted foot is that it does not
// move — it is a constraint on the END of the chain, and the joints above it
// have to be solved to satisfy it. Driven forward, a hip that descends during a
// duck carries the whole straight leg down through the canvas; driven inverse,
// the knee bends by exactly the amount that keeps the ankle where it was. Same
// rig, same bones, opposite direction of reasoning.
//
// This is also what makes a STEP possible rather than a slide. The body's
// travel is decided elsewhere (footwork.ts); this is what makes the legs
// account for it instead of hanging below it like a mannequin on a stand.
// THE KNEE ONLY BENDS ONE WAY
//
// Two-bone IK has a circle of valid solutions — the knee can sit anywhere on a
// ring around the hip-to-ankle axis — and picking the wrong point on that ring
// is how a character ends up with its knee in its own other leg, or bending
// backwards. The ring is collapsed to a single answer by a POLE direction: the
// knee is placed as far toward the pole as the segment lengths allow. For a
// human leg the pole is the figure's own forward, which is measured off the rig
// rather than assumed, for the same reason crouch.ts solves its sign.

export interface LegRig {
  thigh: BoneBindData;
  shin: BoneBindData;
  /** Bind-pose segment lengths, world units. */
  thighLength: number;
  shinLength: number;
}

const _hip = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _thighDir = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _shinDir = new THREE.Vector3();
const _fallback = new THREE.Vector3();
const _basisQuat = new THREE.Quaternion();

export function captureLeg(
  binds: Map<DrivenBoneName, BoneBindData>,
  side: "l" | "r"
): LegRig | null {
  const thigh = binds.get(`${side}_upleg` as DrivenBoneName);
  const shin = binds.get(`${side}_lowleg` as DrivenBoneName);
  if (!thigh || !shin) return null;
  return {
    thigh,
    shin,
    thighLength: thigh.bindChildDistance,
    shinLength: shin.bindChildDistance,
  };
}

/**
 * Aims a bone along a world-space direction.
 *
 * `applyBoneTarget` does NOT take a plain world vector, and handing it one is a
 * quiet way to get a direction that is close to right and never exactly right.
 * Its contract is the one the camera path produces: x and y are a direction in
 * the IMAGE plane and z is the out-of-plane component, so it rescales x and y
 * by sqrt(1 - z^2) on the way in. A unit 3D vector passed straight through
 * therefore comes out with its horizontal part squashed against its vertical.
 * Normalising x and y to unit length first is what cancels that rescale.
 */
export function aimAlongWorld(bind: BoneBindData, dir: THREE.Vector3): void {
  const planar = Math.hypot(dir.x, dir.y);
  if (planar < 1e-6) {
    // Straight along z: x and y are meaningless, and any unit pair survives the
    // rescale to zero. Pass a fixed one rather than dividing by ~0.
    applyBoneTarget(bind, { x: 1, y: 0, z: dir.z >= 0 ? 1 : -1 });
    return;
  }
  applyBoneTarget(bind, { x: dir.x / planar, y: dir.y / planar, z: dir.z });
}

/**
 * Solves one leg so its ankle reaches `target`.
 *
 * `poleWorld` is the direction the knee is pushed toward — the figure's own
 * forward. Both vectors are in WORLD space, which is the frame the planted
 * feet are tracked in; solving in the figure's local frame would mean the legs
 * un-planting themselves the moment the figure turned.
 *
 * An out-of-reach target is NOT an error and is not clamped away: the leg
 * simply straightens along the line to it and comes up short, which is what a
 * real leg does and what keeps a too-wide stance readable instead of snapping.
 */
export function solveLegIk(
  leg: LegRig,
  target: THREE.Vector3,
  poleWorld: THREE.Vector3
): void {
  leg.thigh.bone.updateWorldMatrix(true, false);
  leg.thigh.bone.getWorldPosition(_hip);

  _toTarget.copy(target).sub(_hip);
  const distance = _toTarget.length();
  if (distance < 1e-5) return;
  _dir.copy(_toTarget).divideScalar(distance);

  const a = leg.thighLength;
  const b = leg.shinLength;

  // Law of cosines for the angle between the thigh and the hip-to-ankle line.
  // Clamped because the target can sit outside the leg's reach in both
  // directions: too far (the leg straightens, angle 0) and too close (it folds
  // as far as the segments allow).
  const reach = THREE.MathUtils.clamp(distance, Math.abs(a - b) + 1e-4, a + b);
  const cosAngle = THREE.MathUtils.clamp(
    (a * a + reach * reach - b * b) / (2 * a * reach),
    -1,
    1
  );
  const angle = Math.acos(cosAngle);

  // The pole, made perpendicular to the hip-to-ankle line. Rotating within the
  // plane those two span is what guarantees the knee ends up on the forward
  // side of the leg rather than somewhere on the ring around it.
  _pole.copy(poleWorld).addScaledVector(_dir, -poleWorld.dot(_dir));
  if (_pole.lengthSq() < 1e-8) {
    // Leg pointing straight along the pole — degenerate, and any perpendicular
    // is as good as any other. Build one rather than leaving the knee's
    // direction to whatever the previous frame happened to hold.
    _fallback.set(0, 1, 0);
    if (Math.abs(_dir.y) > 0.9) _fallback.set(1, 0, 0);
    _pole.copy(_fallback).addScaledVector(_dir, -_fallback.dot(_dir));
  }
  _pole.normalize();

  _thighDir
    .copy(_dir)
    .multiplyScalar(Math.cos(angle))
    .addScaledVector(_pole, Math.sin(angle))
    .normalize();

  aimAlongWorld(leg.thigh, _thighDir);

  // The shin is solved AFTER the thigh is applied, and against where the knee
  // actually ended up rather than where the maths said it would. The two agree
  // when the thigh reached its target exactly; they do not when the aim solve
  // was partial, and trusting the prediction there leaves a visible kink at the
  // knee. Reading the rig back is a frame's worth of extra work and removes the
  // whole class of disagreement.
  leg.thigh.bone.updateWorldMatrix(true, false);
  leg.shin.bone.updateWorldMatrix(true, false);
  leg.shin.bone.getWorldPosition(_knee);
  _shinDir.copy(target).sub(_knee);
  if (_shinDir.lengthSq() < 1e-10) return;
  _shinDir.normalize();
  aimAlongWorld(leg.shin, _shinDir);
}

/**
 * The figure's own forward, in world space — the knee's pole direction.
 *
 * Read off the rig rather than assumed, so a stage that stands the fighters at
 * some angle other than facing each other down the z axis still bends their
 * knees forwards. The figure's local +Z is its forward; see the frame notes in
 * opponentAnimator.ts.
 */
export function figureForward(
  figure: THREE.Object3D,
  out = new THREE.Vector3()
): THREE.Vector3 {
  figure.getWorldQuaternion(_basisQuat);
  return out.set(0, 0, 1).applyQuaternion(_basisQuat).setY(0).normalize();
}

/** The figure's own LEFT, in world space and flattened to the ground plane. */
export function figureLeft(
  figure: THREE.Object3D,
  out = new THREE.Vector3()
): THREE.Vector3 {
  // The rig's `l_*` bones sit at +X in the figure's own frame, so local +X IS
  // its left — see the frame notes in opponentAnimator.ts.
  figure.getWorldQuaternion(_basisQuat);
  return out.set(1, 0, 0).applyQuaternion(_basisQuat).setY(0).normalize();
}
