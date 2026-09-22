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
//
// A duck is three joints, and the third one is what makes it work:
//
//   1. The knees bend, which is where the height actually comes from.
//   2. The waist folds, which is what takes the head off the punch line.
//   3. The root drops by exactly the height the knees gave up.
//
// Without (3) the bend swings the feet up off the canvas instead of lowering
// the hips, because the rig hangs from its root - the hip is the anchor and
// the feet are the free end. The drop is therefore computed from the bones'
// own measured lengths rather than dialled in by eye, which is also what keeps
// the feet planted when the figure is re-exported at another scale.
// Composed, not overwritten
//
// The leg bones are already driven by the retargeting whenever the player's
// legs are visible. This rotation is applied on top of whatever pose they are
// already in, so a tracked step and a duck add up instead of one erasing the
// other. At a desk webcam the legs are usually out of frame and rejected by
// the hallucinated-landmark guard, so in practice they are at bind - but that
// must not be something the code relies on.

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

/**
 * Works out which way to rotate a leg so the knee goes forward.
 *
 * Measured rather than assumed, the same way the finger curl and the jaw hinge
 * are. A hardcoded sign is a coin flip that renders as a character squatting
 * backwards through its own heels, and it would have to be re-checked by hand
 * on every re-export.
 */
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

/**
 * How far the hips fall for a given crouch, world units.
 *
 * The thigh tilts `angle` forward of vertical and the shin tilts the same
 * amount back, so the leg's vertical extent goes from `a + b` to
 * `(a + b)·cos(angle)` and the horizontal offset of the ankle is
 * `(a − b)·sin(angle)` - near zero for a human's near-equal segments, which is
 * why the feet stay roughly under the body rather than sliding forward.
 */
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
  //
  //   The rig driver writes every driven bone from its solve each frame, legs
  //   included, so the legs are already reset by the time this runs.
  //
  //   The opponent animator poses only the arms, so nothing resets its legs.
  //   Composing there accumulated a fresh bend on top of the last one every
  //   frame, and within a second the figure had folded itself inside out -
  //   its feet ended up higher than its head.
  //
  // Hence `fromBind`, rather than a reset that would silently cancel a tracked
  // leg for the driver.
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

/**
 * Post-multiplies a world-space rotation onto a bone's current pose.
 *
 * Conjugated into the parent's frame, because the figure is rotated to face
 * the camera and its bones' parent frames are nowhere near world axes - using
 * the rotation directly bends the leg sideways through the other one. This is
 * the same conjugation the spine bend and the hit reaction use.
 *
 * Exported because composing rather than overwriting is what any effect laid
 * on top of a tracked pose needs, and the crouch is no longer the only one:
 * the player's flinch has exactly the same requirement, since its head and
 * neck are already being driven by the camera when the punch lands.
 */
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
