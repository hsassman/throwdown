import * as THREE from "three";
import { applyBoneTarget, type BoneBindData } from "./mediapipeToMhrRig";
import type { DrivenBoneName } from "./rigJointMap";

// Two-bone inverse kinematics for a leg: given where the ankle has to BE, work
// out where the thigh and shin have to point.
// WHY THE LEGS NEEDED INVERTING AT ALL

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

/** Aims a bone along a world-space direction. */
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

/** Solves one leg so its ankle reaches `target`. */
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
    // Leg pointing straight along the pole - degenerate, and any perpendicular
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

/** The figure's own forward, in world space - the knee's pole direction. */
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
  // its left - see the frame notes in opponentAnimator.ts.
  figure.getWorldQuaternion(_basisQuat);
  return out.set(1, 0, 0).applyQuaternion(_basisQuat).setY(0).normalize();
}
