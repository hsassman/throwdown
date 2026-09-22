import * as THREE from "three";
import { applyBoneTarget, type BoneBindData } from "./retargeting/mediapipeToMhrRig";
import type { DrivenBoneName } from "./retargeting/rigJointMap";
import type { GuardPosture } from "../sim/fightState";

// ONE guard, one implementation, for both fighters.
//
// These tables lived inside opponentAnimator.ts, which meant only the CPU
// fighter had a rest pose. The player's figure is driven from the camera, and
// when there is nobody in frame — before they step in, or any time tracking
// drops — every bone eased back toward its BIND rotation. The rig's bind pose
// is a T-pose, so the first thing a new player saw of their own fighter was a
// man standing with his arms out sideways.
//
// Extracted rather than duplicated for the reason crouch.ts was: two copies of
// a guard drift, and a guard that differs between the two fighters is a guard
// the player learns wrong.
//
// The angles are anatomical, not decorative. The upper arm hangs down and
// slightly FORWARD and the forearm comes up and slightly IN, which leaves
// about 55 degrees at the elbow — a real guard. An earlier version had the
// upper arm dead vertical with the elbow flared and the forearm folded back on
// it, which reads as a shrug and left the gloves at the sides of the head
// rather than in front of it.

/** An arm pose, as unit-ish directions in the FIGURE's own frame. */
export interface ArmPose {
  uparm: THREE.Vector3;
  lowarm: THREE.Vector3;
}

/**
 * The three arm poses everything is interpolated between.
 *
 * Expressed for the LEFT arm and mirrored in x for the right, so a change to
 * the guard cannot accidentally be made to one side only — precisely the
 * mirrored-handedness bug this project has already hit twice.
 */
export const POSES: Record<"cocked" | "guard" | "extended", ArmPose> = {
  // Drawn back: elbow behind the ribs, glove up beside the ear. This is the
  // telegraph, and it has to be large — it is the only warning the player
  // gets, and their own input arrives through a webcam at ~15 FPS, so a subtle
  // wind-up is not a wind-up.
  cocked: {
    uparm: new THREE.Vector3(0.22, -0.82, -0.53),
    lowarm: new THREE.Vector3(-0.24, 0.73, -0.64),
  },
  // Hands at the cheekbones, elbows down and tucked against the ribs.
  guard: {
    uparm: new THREE.Vector3(0.12, -0.93, 0.35),
    lowarm: new THREE.Vector3(-0.18, 0.8, 0.57),
  },
  // Committed: the arm straight out along the punch. The `z` here is nominal —
  // the opponent's `throw()` replaces the vertical component so the punch
  // actually points at what it is aimed at.
  extended: {
    uparm: new THREE.Vector3(0.1, -0.12, 0.99),
    lowarm: new THREE.Vector3(0.02, -0.02, 1),
  },
};

/** Forearms across the belly. The low guard, which the CPU really uses. */
export const LOW_GUARD: ArmPose = {
  uparm: new THREE.Vector3(0.1, -0.96, 0.26),
  lowarm: new THREE.Vector3(-0.55, 0.3, 0.78),
};

/** Hands down. What a fighter drops into when they commit to a punch, and
 *  what makes counter-punching work. */
export const NO_GUARD: ArmPose = {
  uparm: new THREE.Vector3(0.14, -0.97, 0.18),
  lowarm: new THREE.Vector3(0.05, -0.75, 0.66),
};

/**
 * The two bones each hand's arm poses through.
 *
 * Named ARM_CHAIN, not ARM_BONES: mediapipeToMhrRig already exports an
 * ARM_BONES, which is a flat list of the four arm bones for limb measurement.
 * Two different shapes under one name is how a wrong-constant bug starts.
 */
export const ARM_CHAIN: Record<
  "left" | "right",
  { uparm: DrivenBoneName; lowarm: DrivenBoneName }
> = {
  left: { uparm: "l_uparm", lowarm: "l_lowarm" },
  right: { uparm: "r_uparm", lowarm: "r_lowarm" },
};

/** Every bone a guard pose writes. Callers use this to tell which bones they
 *  have handed over to the guard and must not also fade back toward bind. */
export const GUARD_BONES: readonly DrivenBoneName[] = [
  "l_uparm",
  "l_lowarm",
  "r_uparm",
  "r_lowarm",
];

export function restPoseFor(guard: GuardPosture): ArmPose {
  return guard === "low" ? LOW_GUARD : guard === "none" ? NO_GUARD : POSES.guard;
}

const _world = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/**
 * Writes one arm's guard straight onto the rig.
 *
 * `figure` supplies the frame: the pose table is in the FIGURE's own axes, and
 * asking the rig for its world rotation rather than assuming one means a stage
 * that places a fighter at any angle still poses correctly. The rig's `l_*`
 * bones sit at +X, so the right arm is the left arm with x negated — mirrored
 * HERE, once, rather than by authoring two tables that could drift apart.
 */
export function applyGuardArm(
  figure: THREE.Object3D,
  binds: Map<DrivenBoneName, BoneBindData>,
  hand: "left" | "right",
  guard: GuardPosture = "high"
): void {
  const rest = restPoseFor(guard);
  const mirror = hand === "right" ? -1 : 1;
  const bones = ARM_CHAIN[hand];
  figure.getWorldQuaternion(_quat);
  for (const part of ["uparm", "lowarm"] as const) {
    const bind = binds.get(bones[part]);
    if (!bind) continue;
    const local = rest[part];
    _world.set(local.x * mirror, local.y, local.z).applyQuaternion(_quat);
    applyBoneTarget(bind, { x: _world.x, y: _world.y, z: _world.z });
  }
}

/** Both arms, which is what a fighter at rest is doing. */
export function applyGuard(
  figure: THREE.Object3D,
  binds: Map<DrivenBoneName, BoneBindData>,
  guard: GuardPosture = "high"
): void {
  applyGuardArm(figure, binds, "left", guard);
  applyGuardArm(figure, binds, "right", guard);
}
