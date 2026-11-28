import * as THREE from "three";
import type { BoneBindData } from "./mediapipeToMhrRig";
import type { DrivenBoneName } from "./rigJointMap";
import { CROUCH_CONFIG } from "../../config/tuning";

// Ducking, with legs.
// The crouch channel used to move the character by translating its root
// downward. Everything about that is wrong except the height: the figure sank
// through the floor with its legs perfectly straight, which reads as
// levitating rather than ducking. It was the most visible thing left in the
// character's motion.

export interface CrouchRig {
  thighs: BoneBindData[];
  shins: BoneBindData[];
  waist: BoneBindData | null;
  /** Bind-pose segment lengths, world units. The drop is derived from these. */
  thighLength: number;
  shinLength: number;
  /** Which way round the lateral axis takes a knee forward. Solved, not
   *  assumed - see below. */
  sign: number;
}

const _axis = new THREE.Vector3();
const _probe = new THREE.Quaternion();
const _rot = new THREE.Quaternion();
const _parent = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _moved = new THREE.Vector3();
const _forward = new THREE.Vector3();

/** Works out which way to rotate a leg so the knee goes forward. */
function solveSign(
  root: THREE.Object3D,
  thigh: BoneBindData,
  knee: THREE.Object3D
): number {
  root.updateMatrixWorld(true);
  thigh.bone.getWorldPosition(_hip);
  knee.getWorldPosition(_knee);
  // The figure's own forward, in world.
  _forward.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_parent));
  _axis.set(1, 0, 0).applyQuaternion(_parent);

  _probe.setFromAxisAngle(_axis, 0.2);
  _moved.copy(_knee).sub(_hip).applyQuaternion(_probe).add(_hip).sub(_knee);
  return _moved.dot(_forward) >= 0 ? 1 : -1;
}

export function captureCrouch(
  root: THREE.Object3D,
  binds: Map<DrivenBoneName, BoneBindData>
): CrouchRig | null {
  const thighs = [binds.get("l_upleg"), binds.get("r_upleg")].filter(
    (b): b is BoneBindData => !!b
  );
  const shins = [binds.get("l_lowleg"), binds.get("r_lowleg")].filter(
    (b): b is BoneBindData => !!b
  );
  if (thighs.length === 0 || shins.length === 0) return null;

  const knee = shins[0].bone;
  return {
    thighs,
    shins,
    waist: binds.get("c_spine0") ?? null,
    thighLength: thighs[0].bindChildDistance,
    shinLength: shins[0].bindChildDistance,
    sign: solveSign(root, thighs[0], knee),
  };
}

/** How far the hips fall for a given crouch, world units. */
export function crouchDrop(rig: CrouchRig, crouch: number): number {
  const angle = THREE.MathUtils.clamp(crouch, 0, 1) * CROUCH_CONFIG.kneeAngle;
  return (rig.thighLength + rig.shinLength) * (1 - Math.cos(angle));
}

/**
 * Applies one frame of crouch and returns the hip drop the caller must subtract
 * from the root's height to keep the feet on the canvas.
 */
export function applyCrouch(
  root: THREE.Object3D,
  rig: CrouchRig,
  crouch: number,
  options: { fromBind?: boolean } = {}
): number {
  const c = THREE.MathUtils.clamp(crouch, 0, 1);
  const angle = c * CROUCH_CONFIG.kneeAngle;

  // This rotation composes onto whatever the bones are already holding, which
  // makes the base pose the caller's responsibility - and the two callers
  // genuinely differ:
  if (options.fromBind) {
    for (const b of rig.thighs) b.bone.quaternion.copy(b.bindLocalQuat);
    for (const b of rig.shins) b.bone.quaternion.copy(b.bindLocalQuat);
    if (rig.waist) rig.waist.bone.quaternion.copy(rig.waist.bindLocalQuat);
  }

  root.getWorldQuaternion(_parent);
  _axis.set(1, 0, 0).applyQuaternion(_parent).normalize();

  for (const thigh of rig.thighs) composeWorldRotation(thigh, _axis, angle * rig.sign);
  // Twice the thigh's angle, because the shin inherits the thigh's rotation
  // and has to come back through it to end up tilted the other way.
  for (const shin of rig.shins) composeWorldRotation(shin, _axis, -2 * angle * rig.sign);
  if (rig.waist) {
    // The opposite sign to the legs, and not as a correction - as geometry.
    // `sign` was solved for a thigh, which points down, so rotating it that
    // way about the lateral axis carries the knee forward. The spine points
    // UP, so the same rotation carries the head backward. Using the leg's sign
    // here folded the figure over backwards while its knees bent forwards.
    composeWorldRotation(rig.waist, _axis, -c * CROUCH_CONFIG.waistFold * rig.sign);
  }

  return (rig.thighLength + rig.shinLength) * (1 - Math.cos(angle));
}

/** Post-multiplies a world-space rotation onto a bone's current pose. */
export function composeWorldRotation(
  bind: BoneBindData,
  axisWorld: THREE.Vector3,
  angle: number
): void {
  if (Math.abs(angle) < 1e-6) return;
  _rot.setFromAxisAngle(axisWorld, angle);
  bind.parent.updateWorldMatrix(true, false);
  bind.parent.getWorldQuaternion(_parent);
  _local.copy(_parent).invert().multiply(_rot).multiply(_parent);
  bind.bone.quaternion.premultiply(_local);
}
