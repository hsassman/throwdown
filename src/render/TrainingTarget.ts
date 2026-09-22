import * as THREE from "three";
import { captureBindPose, type BoneBindData } from "./retargeting/mediapipeToMhrRig";
import { applyBoneTarget } from "./retargeting/mediapipeToMhrRig";
import { applyClench, captureHandBind, type HandBind } from "./retargeting/handRig";
import { BONE_GAIN, type DrivenBoneName } from "./retargeting/rigJointMap";
import { TARGET_CONFIG } from "../config/tuning";
import type { StrikeEvent } from "../perception/strikeResolver";

// The second humanoid: a training target that reacts to being hit.
//
// It is the same mesh asset as the player's boxer, cloned. That is a deliberate
// choice rather than a shortcut - a second 0.40MB download and a second set of
// bind data would buy nothing while the only thing being tested is whether hits
// register and read correctly. Tinting it apart is enough to tell them apart.
//
// Layering this respects
//
// Risk log 13: damage state belongs to the simulation, the appearance of damage
// belongs to the render layer. Nothing here decides whether a hit landed - it
// is told, via hit(), and only turns that into motion. It never reads the
// player's mesh, and the player's hit resolution never reads this one.
//
// Why the reaction is bone-driven
//
// The shipped mesh carries 14 facial bones including `c_jaw` as a real skin
// joint (established when the 117 morph targets were identified). So head snap
// and jaw drop cost nothing in asset size - the 72 expression blendshapes,
// at ~64KB each, are only needed for what bones genuinely cannot do, like a
// wince or a squint. Bones first was the right order.

/** Bones this reacts with. All present in the shipped mesh. */
const REACT_HEAD: DrivenBoneName = "c_head";
const REACT_NECK: DrivenBoneName = "c_neck";
const REACT_SPINE: DrivenBoneName = "c_spine2";

/**
 * A static guard, applied once while the target still stands at identity so
 * the world-space aim solve is easy to reason about - the root is rotated to
 * face the player afterwards, and the baked local rotations come with it.
 *
 * Directions are world-space in-plane unit vectors, the same convention the
 * live retargeting uses.
 */
const GUARD_POSE: Partial<Record<DrivenBoneName, { x: number; y: number }>> = {
  l_uparm: { x: 0.28, y: -0.96 },
  l_lowarm: { x: -0.42, y: 0.91 },
  r_uparm: { x: -0.28, y: -0.96 },
  r_lowarm: { x: 0.42, y: 0.91 },
};

/**
 * Arms hanging at the sides, for the punching dummy.
 *
 * The mesh's bind pose is a T-pose, arms straight out sideways. Simply not
 * posing the dummy therefore leaves it standing like a scarecrow with its arms
 * through the space the player is punching into - which is worse than a guard,
 * not better. A real free-standing dummy has no arms at all; arms down at the
 * sides is the closest this mesh can get without cutting geometry out of a
 * skinned buffer.
 *
 * Slightly out from the body rather than dead vertical, so the upper arms do
 * not intersect the ribs.
 */
const DUMMY_POSE: Partial<Record<DrivenBoneName, { x: number; y: number }>> = {
  l_uparm: { x: 0.2, y: -0.98 },
  l_lowarm: { x: 0.1, y: -0.99 },
  r_uparm: { x: -0.2, y: -0.98 },
  r_lowarm: { x: -0.1, y: -0.99 },
};

const _up = new THREE.Vector3(0, 1, 0);
const _axis = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _local = new THREE.Quaternion();
const _probe = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

/**
 * Finds which way round an axis has to be to move `tip` in `desired`.
 *
 * The same measure-don't-assume trick the finger curl uses. The jaw's hinge
 * orientation is not something to guess at from bone names, and getting it
 * backwards clamps the mouth shut through the skull instead of opening it.
 */
function signedAxis(
  pivot: THREE.Vector3,
  tip: THREE.Vector3,
  axisWorld: THREE.Vector3,
  desired: THREE.Vector3
): THREE.Vector3 {
  _probe.setFromAxisAngle(axisWorld, 0.2);
  const moved = _tmp.copy(tip).sub(pivot).applyQuaternion(_probe).add(pivot).sub(tip);
  return moved.dot(desired) >= 0 ? axisWorld.clone() : axisWorld.clone().negate();
}

export interface TargetDebugState {
  /** Total hits taken since the last reset. */
  hits: number;
  /** Per-zone tally, so it is visible that zones actually discriminate. */
  byZone: Record<string, number>;
  /** Current reaction magnitude, 0-1 - the visible recoil. */
  shake: number;
}

export class TrainingTarget {
  readonly root: THREE.Object3D;
  private binds: Map<DrivenBoneName, BoneBindData>;
  private hands: HandBind[] = [];
  private jaw: THREE.Object3D | null = null;
  private jawBind = new THREE.Quaternion();
  private jawAxis = new THREE.Vector3(1, 0, 0);
  private homePosition = new THREE.Vector3();

  /** Reaction state. `shown` chases `impulse`, which decays on its own. */
  private impulse = 0;
  private shown = 0;
  private direction = new THREE.Vector3(0, 0, 1);
  private headShare = 1;

  private hitCount = 0;
  private byZone: Record<string, number> = {};
  /**
   * Multiplier on the whole-body knockback. 0 for the punching dummy.
   *
   * Two reasons. A dummy is bolted to a weighted base - it rocks on its spring
   * and does not slide backwards, so the stand's own spring is its whole-body
   * reaction and a second one would double it. And the dummy's figure is
   * parented inside a group turned to face the player, so local +Z is world
   * -Z there: an unscaled knockback would shove it toward the punch.
   */
  private knockbackScale: number;

  /**
   * @param options.guard Pose a fighting guard and close the fists. True for
   *   an opponent; false for the punching dummy, which has no fight in it - a
   *   dummy standing in a boxer's guard reads as an opponent about to throw,
   *   and a player would wait for a punch that never comes. Only the guard is
   *   skipped: the reaction machinery below is exactly what a dummy needs.
   */
  constructor(
    root: THREE.Object3D,
    options: { guard?: boolean; knockback?: number } = {}
  ) {
    this.root = root;
    this.knockbackScale = options.knockback ?? 1;
    this.binds = captureBindPose(root);

    // Pose the arms while still at identity, then let the caller place and
    // turn the whole figure. There is always a pose: the bind pose is a
    // T-pose, and leaving it is never the right answer.
    const guard = options.guard ?? true;
    for (const [name, target] of Object.entries(guard ? GUARD_POSE : DUMMY_POSE)) {
      const bind = this.binds.get(name as DrivenBoneName);
      if (bind) applyBoneTarget(bind, target, BONE_GAIN[name as DrivenBoneName] ?? 1);
    }
    root.updateMatrixWorld(true);

    for (const side of ["l", "r"] as const) {
      const hand = captureHandBind(root, side);
      if (hand) {
        // A target holding a guard has its fists closed permanently. A dummy's
        // hands are merely relaxed - but not left at bind, which reads as a
        // splayed claw (the defect the fist work was built to fix).
        applyClench(hand, guard ? 0.95 : 0.45);
        this.hands.push(hand);
      }
    }

    this.jaw = root.getObjectByName("c_jaw") ?? null;
    if (this.jaw) {
      this.jawBind.copy(this.jaw.quaternion).normalize();
      const tipNode = root.getObjectByName("c_jaw_null") ?? null;
      if (tipNode) {
        const pivot = new THREE.Vector3();
        const tip = new THREE.Vector3();
        this.jaw.getWorldPosition(pivot);
        tipNode.getWorldPosition(tip);
        // A jaw opens by swinging its tip downward.
        const worldAxis = signedAxis(pivot, tip, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0));
        const wq = new THREE.Quaternion();
        this.jaw.getWorldQuaternion(wq);
        this.jawAxis.copy(worldAxis).applyQuaternion(wq.invert()).normalize();
      }
    }
  }

  /** Records where the figure stands, so knockback can return to it. */
  setHome(position: THREE.Vector3): void {
    this.root.position.copy(position);
    this.homePosition.copy(position);
  }

  get debug(): TargetDebugState {
    return { hits: this.hitCount, byZone: { ...this.byZone }, shake: this.shown };
  }

  resetScore(): void {
    this.hitCount = 0;
    this.byZone = {};
  }

  /**
   * Takes a hit. Direction is derived from the zone rather than from any
   * geometry, because the zone is all the resolver can honestly report - see
   * strikeResolver.ts on why there is no shared physical space to measure.
   */
  hit(event: StrikeEvent): void {
    this.hitCount++;
    const key = `${event.zone.height}/${event.zone.lane}`;
    this.byZone[key] = (this.byZone[key] ?? 0) + 1;

    // The player's character faces +Z, so a punch travels +Z into the target.
    // A lane on the player's right sits at world -X (the anatomical mapping),
    // so the impact pushes the target's head the other way.
    const lateral =
      event.zone.lane === "right" ? 0.85 : event.zone.lane === "left" ? -0.85 : 0;

    if (event.zone.height === "head") {
      // Head shots drive the head back and up.
      this.direction.set(lateral, 0.35, 1).normalize();
      this.headShare = 1;
    } else {
      // Body shots fold the target forward, toward the puncher.
      this.direction.set(lateral * 0.5, -0.2, -1).normalize();
      this.headShare = 0;
    }

    // Accumulate rather than overwrite: a combination should stagger the
    // target more than a single punch, but never past the clamp.
    this.impulse = Math.min(1, this.impulse + event.power);
  }

  /** Advances the reaction by one rendered frame. */
  update(dt: number): void {
    // Decay the impulse, then chase it. Two time constants on purpose: the
    // build-up is near-instant (an impact is sudden) and the recovery is not.
    this.impulse *= Math.exp(-dt / TARGET_CONFIG.recoverTau);
    if (this.impulse < 1e-4) this.impulse = 0;

    const tau =
      this.shown < this.impulse ? TARGET_CONFIG.impactTau : TARGET_CONFIG.recoverTau;
    this.shown += (this.impulse - this.shown) * (1 - Math.exp(-dt / tau));

    const strength = this.shown;

    // Head and neck take the head-shot reaction; the spine takes the body one.
    const headAngle = TARGET_CONFIG.headSnap * strength * this.headShare;
    const bodyAngle = TARGET_CONFIG.bodyFold * strength * (1 - this.headShare);

    // Rotating `up` about cross(up, d) tips it toward the horizontal part of
    // d, which is exactly "get knocked in direction d".
    _impulse.copy(this.direction);
    _axis.copy(_up).cross(_impulse);
    if (_axis.lengthSq() > 1e-9) {
      _axis.normalize();
      // The neck carries most of a head snap, the head the rest - a snap that
      // rotates only the skull reads as detached.
      this.applyWorldRotation(REACT_NECK, _axis, headAngle * 0.6);
      this.applyWorldRotation(REACT_HEAD, _axis, headAngle * 0.4);
      this.applyWorldRotation(REACT_SPINE, _axis, bodyAngle);
    }

    if (this.jaw) {
      _rot.setFromAxisAngle(this.jawAxis, TARGET_CONFIG.jawDrop * strength * this.headShare);
      this.jaw.quaternion.copy(this.jawBind).multiply(_rot);
    }

    // Knockback, straight back along the punch.
    this.root.position.set(
      this.homePosition.x,
      this.homePosition.y,
      this.homePosition.z +
        TARGET_CONFIG.knockback * strength * this.knockbackScale
    );
  }

  /**
   * Applies a world-space rotation to one bone, on top of its bind rotation.
   *
   * Conjugated into the bone's own parent frame - the same requirement the
   * spine bend has, and for the same reason: the figure is turned to face the
   * player, so its bones' parent frames are nowhere near world axes and using
   * the rotation directly would snap the head in a random direction.
   */
  private applyWorldRotation(
    name: DrivenBoneName,
    axis: THREE.Vector3,
    angle: number
  ): void {
    const bind = this.binds.get(name);
    if (!bind) return;
    if (Math.abs(angle) < 1e-6) {
      bind.bone.quaternion.copy(bind.bindLocalQuat);
      return;
    }
    _rot.setFromAxisAngle(axis, angle);
    bind.parent.updateWorldMatrix(true, false);
    bind.parent.getWorldQuaternion(_parentQuat);
    _local.copy(_parentQuat).invert().multiply(_rot).multiply(_parentQuat);
    bind.bone.quaternion.copy(_local).multiply(bind.bindLocalQuat);
  }
}
