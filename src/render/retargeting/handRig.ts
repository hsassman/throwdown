import * as THREE from "three";
import {
  FINGER_CHAINS,
  FINGER_CURL,
  HAND_SHAPE,
  type FingerName,
  type HandSideKey,
} from "./rigJointMap";

// Closes the character's hands into fists.
//
// WHY THIS IS NOT DRIVEN BY TRACKING
//
// MediaPipe Pose gives three points per hand (wrist, index MCP, pinky MCP) and
// no finger articulation at all — the Hands model would, but running a second
// model per frame is exactly the inference budget this project does not have
// (see risk log 12: pose inference alone already caps the sample rate). So
// finger curl is not measured, it is inferred from what the arm is doing.
//
// That turns out to be the right answer anyway, because a boxer's hands are
// never open. The mesh ships in a relaxed, splayed bind pose that reads as
// wrong the moment you look at it in a boxing context.
// HOW A FIST IS ACTUALLY MADE, AND WHAT THE FIRST ATTEMPT GOT WRONG
//
// The first version curled each bone about an axis derived independently for
// that bone, and produced a splayed claw with the fingers passing through each
// other. Three distinct faults, all visible in the rig's measured geometry:
//
//  1. EVERY BONE GOT A DIFFERENT HINGE. The knuckle line was perpendicularised
//     against each bone's own direction, so no two bones rotated in the same
//     plane and the fingers fanned apart as they curled. Real finger joints are
//     near-PARALLEL hinges — that is why fingers stay in formation when you
//     close your hand. There is now ONE hinge axis per hand, shared by every
//     segment, expressed in each bone's local frame. Because a child's local
//     axis rides on its parent's rotation, the whole chain stays in plane.
//
//  2. THE DIRECTION VECTOR WAS THE WHOLE FINGER, NOT THE SEGMENT. `index1` was
//     measured toward the FINGERTIP rather than toward `index2`, tilting its
//     axis further still.
//
//  3. CURLING ALONE CANNOT CLOSE A FIST. Measured on this rig, the fingertips
//     sit 0.029-0.033 apart at bind while the knuckles are only ~0.021 apart:
//     the fingers fan outward by roughly half. Curling preserves that fan, so
//     the fist closed with visible gaps between the fingers. Each finger now
//     also ADDUCTS — swings sideways about the palm normal — by its own
//     measured splay angle, which brings it parallel to the middle finger.
//     Measured splays: index +3.9deg, middle +0.3, ring -7.7, pinky -7.9.

export interface FingerBoneBind {
  bone: THREE.Object3D;
  /** Shared curl hinge, in this bone's own local frame. */
  curlAxis: THREE.Vector3;
  /** Radians of curl at full clench. */
  curlAngle: number;
  /** Sideways swing that brings the finger into formation with its
   * neighbours, in the bone's local frame. Zero for all but the knuckles. */
  adductAxis: THREE.Vector3;
  adductAngle: number;
  /** The angle predicted from bind geometry, kept as the solver's starting
   * guess and for diagnostics. */
  adductSeed: number;
  bindLocalQuat: THREE.Quaternion;
}

export interface HandBind {
  side: HandSideKey;
  bones: FingerBoneBind[];
  /** Palm-ward direction in world space at bind — useful to callers that want
   * to place something against the palm. */
  palmNormal: THREE.Vector3;
}

/** Angle used only to probe which way the fingers curl; never applied. */
const PROBE_ANGLE = 0.2;

const _probe = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

function worldPos(o: THREE.Object3D): THREE.Vector3 {
  const v = new THREE.Vector3();
  o.getWorldPosition(v);
  return v;
}

/** Signed angle from `a` to `b` measured about `axis`, both flattened into the
 * plane `axis` is normal to. */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const flat = (v: THREE.Vector3) =>
    v.clone().addScaledVector(axis, -v.dot(axis)).normalize();
  const fa = flat(a);
  const fb = flat(b);
  if (fa.lengthSq() < 1e-12 || fb.lengthSq() < 1e-12) return 0;
  return Math.atan2(fa.clone().cross(fb).dot(axis), fa.dot(fb));
}

/**
 * Captures the curl rig for one hand. Returns null (rather than throwing) when
 * the hand's bones aren't present: fingers are cosmetic, and a mesh without
 * them should still box.
 */
export function captureHandBind(
  root: THREE.Object3D,
  side: HandSideKey
): HandBind | null {
  const find = (name: string) => root.getObjectByName(name) ?? null;

  const wrist = find(`${side}_wrist`);
  const index1 = find(`${side}_index1`);
  const middle1 = find(`${side}_middle1`);
  const pinky1 = find(`${side}_pinky1`);
  const middleTip = find(`${side}_middle_null`);
  if (!wrist || !index1 || !middle1 || !pinky1 || !middleTip) return null;

  root.updateMatrixWorld(true);

  const wristW = worldPos(wrist);
  const index1W = worldPos(index1);
  const middle1W = worldPos(middle1);
  const pinky1W = worldPos(pinky1);
  const middleTipW = worldPos(middleTip);

  // The middle finger defines the hand's "forward"; the knuckle line defines
  // its "across". Perpendicularising across against forward ONCE gives the
  // single hinge every joint shares.
  const forward = middleTipW.clone().sub(middle1W);
  if (forward.lengthSq() < 1e-12) return null;
  forward.normalize();

  const hinge = index1W.clone().sub(pinky1W);
  if (hinge.lengthSq() < 1e-12) return null;
  hinge.addScaledVector(forward, -hinge.dot(forward));
  if (hinge.lengthSq() < 1e-10) return null;
  hinge.normalize();

  const palmNormal = hinge.clone().cross(forward).normalize();

  // Which way round the hinge is "curl"? Measured, not assumed: rotate the
  // middle fingertip a probe amount and keep whichever sign brings it toward
  // the wrist. Fingers close toward the palm; that is the whole definition.
  _probe.setFromAxisAngle(hinge, PROBE_ANGLE);
  const probed = _tmp
    .copy(middleTipW)
    .sub(middle1W)
    .applyQuaternion(_probe)
    .add(middle1W);
  const curlSign = probed.distanceTo(wristW) < middleTipW.distanceTo(wristW) ? 1 : -1;
  const curlHinge = hinge.clone().multiplyScalar(curlSign);

  // Each finger's splay relative to the middle finger, about the palm normal.
  // Rotating by +splay brings the finger parallel to the middle one, which is
  // what closes the gaps between the fingertips.
  const splayOf = (finger: FingerName): number => {
    const a = find(`${side}_${finger}1`);
    const b = find(`${side}_${finger}2`);
    if (!a || !b) return 0;
    const dir = worldPos(b).sub(worldPos(a));
    if (dir.lengthSq() < 1e-12) return 0;
    return signedAngle(dir.normalize(), forward, palmNormal);
  };

  const bones: FingerBoneBind[] = [];

  for (const chain of FINGER_CHAINS) {
    if (chain.name === "thumb") continue; // wrapped separately, below
    const splay = splayOf(chain.name) * HAND_SHAPE.adductGain;

    for (const segment of chain.segments) {
      const bone = find(`${side}_${chain.name}${segment}`);
      if (!bone) continue;

      const boneWorldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(boneWorldQuat);
      const toLocal = boneWorldQuat.clone().invert();

      // Adduction belongs at the knuckle only. Segment 1 is the knuckle for
      // every finger — the pinky's segment 0 is a metacarpal, which barely
      // moves and must not be swung sideways.
      const isKnuckle = segment === 1;

      bones.push({
        bone,
        curlAxis: curlHinge.clone().applyQuaternion(toLocal).normalize(),
        curlAngle: FINGER_CURL[chain.name][segment] ?? 0,
        adductAxis: palmNormal.clone().applyQuaternion(toLocal).normalize(),
        adductAngle: isKnuckle ? splay : 0,
        adductSeed: isKnuckle ? splay : 0,
        bindLocalQuat: bone.quaternion.clone().normalize(),
      });
    }
  }

  const thumb = captureThumb(root, side, palmNormal, curlSign);
  if (thumb) bones.push(...thumb);

  if (bones.length === 0) return null;
  const hand: HandBind = { side, bones, palmNormal };

  // The splay angles above are only a SEED. Cancelling the knuckle's splay
  // gets most of the way but not all: each finger also carries its own
  // curvature in segments 2 and 3, which survives the knuckle correction and
  // leaves the fingertips further apart than the knuckles. Measured before
  // this step, the middle-ring fingertip gap closed to 0.0298 against a
  // knuckle spacing of 0.0203 — still half a finger too wide.
  //
  // So the final angle is SOLVED for, against the closed fist itself.
  calibrateAdduction(root, hand, hinge);
  applyClench(hand, 0);
  root.updateMatrixWorld(true);

  return hand;
}

/** Fingers whose adduction is solved. The middle finger is the reference every
 * other finger is positioned against, so it stays where it is. */
const SOLVED_FINGERS: FingerName[] = ["index", "ring", "pinky"];

/**
 * Tunes each finger's adduction so that, at a full fist, the fingertips sit
 * the same distance apart as the knuckles they hang from — which is what
 * "the fingers are touching" means geometrically.
 *
 * A secant solve rather than a formula, because the relationship between a
 * knuckle's sideways swing and where its fingertip ends up after three chained
 * rotations has no clean closed form. It is smooth and monotonic over the
 * range that matters, so a handful of iterations converge tightly, and the
 * cost is paid once when the mesh loads.
 */
function calibrateAdduction(
  root: THREE.Object3D,
  hand: HandBind,
  kAxis: THREE.Vector3
): void {
  const side = hand.side;
  const lateralOf = (name: string): number | null => {
    const o = root.getObjectByName(name);
    if (!o) return null;
    return worldPos(o).dot(kAxis);
  };

  const knuckleBoneFor = (finger: FingerName) =>
    hand.bones.find((b) => b.bone.name === `${side}_${finger}1`) ?? null;

  /**
   * How far the finger's PIP joint sits from where it should, sideways.
   *
   * The PIP joint — the far end of the proximal phalanx — is the right target,
   * and the fingertip is not. Solving for the tip failed instructively: at a
   * full fist the fingertip folds back to within 0.033 of its own knuckle, so
   * its lever arm has collapsed and closing a 0.012 gap there demanded about
   * 29 degrees of knuckle adduction, which pinned the solver against its
   * clamp and is not something a finger can do. The proximal phalanx keeps its
   * full 0.039 lever arm whatever the curl, needs only the ~8 degrees the bind
   * splay already implies, and is the part you actually SEE: in a closed fist
   * the tips are buried in the palm and are not in a neat row in a real hand
   * either.
   */
  const errorFor = (finger: FingerName): number => {
    applyClench(hand, 1);
    root.updateMatrixWorld(true);
    const joint = lateralOf(`${side}_${finger}2`);
    const midJoint = lateralOf(`${side}_middle2`);
    const knuckle = lateralOf(`${side}_${finger}1`);
    const midKnuckle = lateralOf(`${side}_middle1`);
    if (joint === null || midJoint === null || knuckle === null || midKnuckle === null) {
      return 0;
    }
    return joint - midJoint - (knuckle - midKnuckle);
  };

  for (const finger of SOLVED_FINGERS) {
    const knuckle = knuckleBoneFor(finger);
    if (!knuckle) continue;

    let a0 = 0;
    knuckle.adductAngle = a0;
    let e0 = errorFor(finger);
    // Seed the second sample with the measured splay, which is the right order
    // of magnitude, falling back to a fixed step if that splay is ~zero.
    let a1 = Math.abs(knuckle.adductSeed) > 1e-4 ? knuckle.adductSeed : 0.15;

    // Track the best angle SEEN, not the last one proposed. A secant step
    // produces an untested guess, so ending the loop on one would ship an
    // angle that was never evaluated — and silently undo a good solve.
    let bestAngle = a0;
    let bestError = Math.abs(e0);

    for (let i = 0; i < HAND_SHAPE.adductSolveIterations; i++) {
      knuckle.adductAngle = a1;
      const e1 = errorFor(finger);
      if (Math.abs(e1) < bestError) {
        bestError = Math.abs(e1);
        bestAngle = a1;
      }
      if (Math.abs(e1) < HAND_SHAPE.adductTolerance) break;
      const slope = e1 - e0;
      if (Math.abs(slope) < 1e-9) break;
      const next = a1 - e1 * ((a1 - a0) / slope);
      a0 = a1;
      e0 = e1;
      // Clamped: an unconstrained solve can swing a knuckle far past anything
      // a finger can do, if the geometry is ever degenerate.
      a1 = THREE.MathUtils.clamp(next, -HAND_SHAPE.adductMax, HAND_SHAPE.adductMax);
    }
    knuckle.adductAngle = bestAngle;
  }
}

/**
 * The thumb does not curl into the palm like a finger — it wraps ACROSS the
 * front of the folded index and middle fingers, which is what makes a fist a
 * fist rather than a cup. Curling it like a finger drives it straight through
 * the other bones.
 *
 * So it is solved toward a target instead: the point where a real boxing thumb
 * lies, just off the middle phalanges of the index and middle fingers, on the
 * palm side. The whole thumb is swung to aim there and the last two joints
 * curl to wrap around.
 */
function captureThumb(
  root: THREE.Object3D,
  side: HandSideKey,
  palmNormal: THREE.Vector3,
  curlSign: number
): FingerBoneBind[] | null {
  const find = (name: string) => root.getObjectByName(name) ?? null;
  const thumb0 = find(`${side}_thumb0`);
  const thumbTip = find(`${side}_thumb_null`);
  const index2 = find(`${side}_index2`);
  const middle2 = find(`${side}_middle2`);
  if (!thumb0 || !thumbTip || !index2 || !middle2) return null;

  const base = worldPos(thumb0);
  const tip = worldPos(thumbTip);

  // Where the thumb should end up. The palm normal points AWAY from the palm
  // when curlSign is negative, so it is oriented by the same measured sign the
  // fingers use rather than by assumption.
  const palmWard = palmNormal.clone().multiplyScalar(-curlSign);
  const target = worldPos(index2)
    .add(worldPos(middle2))
    .multiplyScalar(0.5)
    .addScaledVector(palmWard, HAND_SHAPE.thumbPalmOffset);

  const fromDir = tip.clone().sub(base);
  const toDir = target.clone().sub(base);
  if (fromDir.lengthSq() < 1e-12 || toDir.lengthSq() < 1e-12) return null;
  fromDir.normalize();
  toDir.normalize();

  // The swing that aims the thumb at its target, as an axis and angle so it
  // can be scaled by clench.
  const swing = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
  const swingAxis = new THREE.Vector3();
  let swingAngle = 2 * Math.acos(THREE.MathUtils.clamp(swing.w, -1, 1));
  const s = Math.sqrt(Math.max(0, 1 - swing.w * swing.w));
  if (s < 1e-6) {
    swingAxis.copy(palmNormal);
    swingAngle = 0;
  } else {
    swingAxis.set(swing.x / s, swing.y / s, swing.z / s).normalize();
  }

  // Wrapping hinge for the outer joints: perpendicular to both the thumb and
  // the palm, so they curl the tip around the fingers rather than into them.
  const wrapAxis = fromDir.clone().cross(palmNormal);
  if (wrapAxis.lengthSq() < 1e-10) return null;
  wrapAxis.normalize();
  // Same measured test as the fingers: keep the sign that shortens the reach
  // to the target.
  _probe.setFromAxisAngle(wrapAxis, PROBE_ANGLE);
  const probed = _tmp.copy(tip).sub(base).applyQuaternion(_probe).add(base);
  if (probed.distanceTo(target) > tip.distanceTo(target)) wrapAxis.negate();

  const out: FingerBoneBind[] = [];
  for (const segment of [0, 1, 2, 3]) {
    const bone = find(`${side}_thumb${segment}`);
    if (!bone) continue;
    const q = new THREE.Quaternion();
    bone.getWorldQuaternion(q);
    const toLocal = q.invert();

    // thumb0 does the aiming; the outer joints do the wrapping.
    const aim = segment === 0 ? swingAngle * HAND_SHAPE.thumbAimGain : 0;

    out.push({
      bone,
      curlAxis: wrapAxis.clone().applyQuaternion(toLocal).normalize(),
      curlAngle: FINGER_CURL.thumb[segment] ?? 0,
      adductAxis: swingAxis.clone().applyQuaternion(toLocal).normalize(),
      adductAngle: aim,
      adductSeed: aim,
      bindLocalQuat: bone.quaternion.clone().normalize(),
    });
  }
  return out;
}

const _adduct = new THREE.Quaternion();
const _curl = new THREE.Quaternion();

/**
 * Sets how closed the hand is. 0 is the exported rest pose, 1 a full fist.
 * Values outside that are clamped rather than extrapolated — overshooting
 * drives phalanges through each other.
 *
 * ORDER MATTERS, and getting it backwards is silent. Composing
 * `bind * adduct * curl` applies the CURL first in world terms, because
 * `Wb * A * C == R_palm(a) * R_hinge(c) * Wb`. At a ~90 degree curl the finger
 * points along the palm normal, and rotating a vector about an axis it is
 * parallel to does nothing at all — so adduction had EXACTLY ZERO effect on a
 * closed fist, which is why the first fix still left gaps between the fingers.
 *
 * `bind * curl * adduct` gives `R_hinge(c) * R_palm(a) * Wb`: the finger swings
 * sideways into formation while it is still pointing forward, then folds. That
 * is also the anatomical order — abduction at the knuckle, then flexion.
 */
export function applyClench(hand: HandBind, clench: number): void {
  const t = THREE.MathUtils.clamp(clench, 0, 1);
  for (const f of hand.bones) {
    _adduct.setFromAxisAngle(f.adductAxis, f.adductAngle * t);
    _curl.setFromAxisAngle(f.curlAxis, f.curlAngle * t);
    f.bone.quaternion.copy(f.bindLocalQuat).multiply(_curl).multiply(_adduct);
  }
}
