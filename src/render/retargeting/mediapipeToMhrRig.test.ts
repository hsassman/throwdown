import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  applyBoneTarget,
  applyPoseToRig,
  captureBindPose,
  computeBoneTargets,
  measureHeadSignals,
  recoverDepth,
  RetargetError,
  type BoneBindData,
} from "./mediapipeToMhrRig";
import {
  BONE_AIM_CHILD,
  BONE_GAIN,
  DRIVEN_BONES,
  SPINE_CHAIN,
  VIEW_MODES,
  type DrivenBoneName,
} from "./rigJointMap";
import type { Keypoint, PoseFrame } from "../../pose/poseTypes";

// These run against the REAL exported asset, not a mock. The first version of
// this retargeting code type-checked, built cleanly, and still produced a
// visibly mangled character — every bug was in geometry that only a numerical
// assertion against the actual rig would have caught. A mocked skeleton would
// have reproduced my wrong assumptions rather than the asset's real structure.

/**
 * How far a bone may sit from its bind rotation and still count as "at rest".
 *
 * The asset is built by the Blender pipeline, so rest transforms survive an
 * extra float32 round trip; the measured drift is 2.7e-8. Invisible, but not
 * zero, which is what this used to assume.
 */
const REST_EPSILON = 1e-6;

const MODEL_PATH = "public/models/boxer_lod3.glb";

let model: THREE.Object3D;
/** The model's PRISTINE local rotations, captured once before any test has
 * touched it. Tests share one loaded model (it is 8MB), so without restoring
 * from this every test would capture the previous test's leftover pose as its
 * "bind" and silently validate against the wrong reference. */
let pristineQuats: Map<string, THREE.Quaternion>;

function loadModel(): Promise<THREE.Object3D> {
  const buf = readFileSync(MODEL_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (gltf) => resolve(gltf.scene), reject);
  });
}

beforeAll(async () => {
  model = await loadModel();
  pristineQuats = new Map();
  model.traverse((o) => {
    if (o.name) pristineQuats.set(o.name, o.quaternion.clone());
  });
}, 60_000);

function freshBinds(): Map<DrivenBoneName, BoneBindData> {
  model.traverse((o) => {
    const q = o.name ? pristineQuats.get(o.name) : undefined;
    if (q) o.quaternion.copy(q);
  });
  model.updateMatrixWorld(true);
  return captureBindPose(model);
}

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/** Places a landmark pair so that planarDirection() yields exactly `world`. */
function pairFor(
  origin: { x: number; y: number },
  world: { x: number; y: number },
  mirrored: boolean,
  len = 0.15
): { from: Keypoint; to: Keypoint } {
  const sx = mirrored ? -1 : 1;
  return {
    from: kp(origin.x, origin.y),
    to: kp(origin.x + world.x * sx * len, origin.y - world.y * len),
  };
}

/** A pose with every landmark tracked; arms/torso point in given directions. */
function synthPose(opts: {
  mirrored: boolean;
  leftArm?: { x: number; y: number };
  leftForearm?: { x: number; y: number };
  rightArm?: { x: number; y: number };
  rightForearm?: { x: number; y: number };
}): PoseFrame {
  const { mirrored } = opts;
  const lShoulder = { x: 0.6, y: 0.4 };
  const rShoulder = { x: 0.4, y: 0.4 };

  const la = pairFor(lShoulder, opts.leftArm ?? { x: 0.3, y: -0.95 }, mirrored);
  const ra = pairFor(rShoulder, opts.rightArm ?? { x: -0.3, y: -0.95 }, mirrored);
  const lf = pairFor(
    { x: la.to.x, y: la.to.y },
    opts.leftForearm ?? { x: 0.2, y: -0.98 },
    mirrored
  );
  const rf = pairFor(
    { x: ra.to.x, y: ra.to.y },
    opts.rightForearm ?? { x: -0.2, y: -0.98 },
    mirrored
  );

  return {
    timestamp: 0,
    leftShoulder: la.from,
    leftElbow: la.to,
    leftWrist: lf.to,
    rightShoulder: ra.from,
    rightElbow: ra.to,
    rightWrist: rf.to,
    leftHip: kp(0.58, 0.75),
    rightHip: kp(0.42, 0.75),
    nose: kp(0.5, 0.25),
    leftEye: kp(0.53, 0.24),
    rightEye: kp(0.47, 0.24),
    leftEar: kp(0.56, 0.25),
    rightEar: kp(0.44, 0.25),
  };
}

/** World-space direction a bone currently points toward its aim child. */
function worldDirOf(bind: BoneBindData, name: DrivenBoneName): THREE.Vector3 {
  model.updateMatrixWorld(true);
  const child = bind.bone.children.find((c) => c.name === BONE_AIM_CHILD[name])!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  bind.bone.getWorldPosition(a);
  child.getWorldPosition(b);
  return b.sub(a).normalize();
}

describe("rig structure", () => {
  it("binds every driven bone against the real exported asset", () => {
    const binds = freshBinds();
    expect(binds.size).toBe(DRIVEN_BONES.length);
    for (const name of DRIVEN_BONES) expect(binds.get(name)).toBeDefined();
  });

  it("every aim child sits at non-zero distance, so no direction normalizes to NaN", () => {
    // The rig genuinely contains zero-length children (`*_twist0_proc`,
    // `Collision_75`). Picking one would yield NaN and silently destroy the
    // pose, so this guards the explicit child map in rigJointMap.ts.
    const binds = freshBinds();
    for (const [name, bind] of binds) {
      // c_head is deliberately not aimed at anything — a swing solve cannot
      // express head yaw, so it is driven by an explicit rotation instead.
      if (!bind.aimed) {
        expect(BONE_AIM_CHILD[name], `${name} should declare no aim child`).toBeNull();
        continue;
      }
      const child = bind.bone.children.find((c) => c.name === BONE_AIM_CHILD[name])!;
      expect(child, `${name} aim child`).toBeDefined();
      expect(child.position.length(), `${name} -> ${child.name} length`).toBeGreaterThan(1e-6);
      expect(Number.isFinite(bind.bindDirParent.x)).toBe(true);
      expect(Number.isFinite(bind.bindDirWorld.z)).toBe(true);
    }
  });

  it("fails loudly, naming the bone, when the rig doesn't match the joint map", () => {
    const clone = model.clone(true);
    const victim = clone.getObjectByName("l_lowarm");
    victim!.name = "renamed_by_test";
    expect(() => captureBindPose(clone)).toThrow(RetargetError);
    expect(() => captureBindPose(clone)).toThrow(/l_uparm.*aim child.*l_lowarm/s);
  });
});

describe("rest pose preservation", () => {
  it("leaves a bone exactly at bind when the measured direction matches bind", () => {
    const binds = freshBinds();
    for (const [name, bind] of binds) {
      const inPlane = new THREE.Vector2(bind.bindDirWorld.x, bind.bindDirWorld.y);
      // A bone pointing straight along z has no in-plane azimuth to match.
      if (inPlane.length() < 1e-6) continue;
      inPlane.normalize();

      applyPoseToRig(binds, { [name]: { x: inPlane.x, y: inPlane.y } });

      const dir = worldDirOf(bind, name);
      expect(dir.x, `${name}.x`).toBeCloseTo(bind.bindDirWorld.x, 5);
      expect(dir.y, `${name}.y`).toBeCloseTo(bind.bindDirWorld.y, 5);
      expect(dir.z, `${name}.z`).toBeCloseTo(bind.bindDirWorld.z, 5);
    }
  });

  it("returns bones to bind when landmarks drop below confidence", () => {
    const binds = freshBinds();
    const bindQuats = new Map(
      [...binds].map(([n, b]) => [n, b.bindLocalQuat.clone()] as const)
    );

    // angleTo() is unusable as an equality check here: the exported asset's
    // quaternions are marginally non-unit, and acos near 1 turns a 1e-8 dot
    // deficit into ~4e-4 radians even against an exact copy. Compare
    // components, accounting for q and -q being the same rotation.
    const sameRotation = (a: THREE.Quaternion, b: THREE.Quaternion) => {
      const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
      return Math.abs(Math.abs(dot) - 1);
    };

    applyPoseToRig(binds, { l_uparm: { x: 1, y: 0 } });
    expect(
      sameRotation(binds.get("l_uparm")!.bone.quaternion, bindQuats.get("l_uparm")!)
    ).toBeGreaterThan(1e-4);

    applyPoseToRig(binds, {}); // nothing tracked this frame
    for (const [name, bind] of binds) {
      // REST_EPSILON, not exact equality. The asset is now produced by the
      // Blender pipeline (blender/README.md), so its bone rest transforms have
      // been through an extra float32 round trip and no longer come back
      // bit-identical. The observed drift is 2.7e-8 -- about 1.6e-6 degrees.
      // Measured across all 127 bones, the largest rest-rotation change the
      // whole pipeline makes is 0.032 degrees, on c_tongue3, a bone that
      // deforms nothing. So this is quantisation, not behaviour, and the
      // tolerance is set well below anything that could ever be visible while
      // still being far tighter than the drift it has to absorb.
      expect(sameRotation(bind.bone.quaternion, bindQuats.get(name)!), name).toBeLessThan(REST_EPSILON);
    }
  });
});

describe("aim correctness", () => {
  it("points a bone along the measured in-plane direction, preserving bind depth", () => {
    const binds = freshBinds();
    const target = { x: 0.6, y: -0.8 }; // already unit length

    for (const [name, bind] of binds) {
      // Spine segments are governed by the distributed-bend contract, not by
      // aiming individually — covered separately below.
      if (SPINE_CHAIN.some((s) => s.bone === name)) continue;
      // Not aimed at all (c_head), or deliberately damped below full swing
      // (clavicles, wrists) — both have their own tests.
      if (!bind.aimed) continue;
      if ((BONE_GAIN[name] ?? 1) < 1) continue;
      applyPoseToRig(binds, { [name]: target });
      const dir = worldDirOf(bind, name);

      // Out-of-plane component is preserved from bind, not flattened to zero.
      expect(dir.z, `${name} preserved depth`).toBeCloseTo(bind.bindDirWorld.z, 5);

      // In-plane azimuth matches what was measured.
      const xy = new THREE.Vector2(dir.x, dir.y);
      if (xy.length() > 1e-6) {
        xy.normalize();
        expect(xy.x, `${name} azimuth x`).toBeCloseTo(target.x, 4);
        expect(xy.y, `${name} azimuth y`).toBeCloseTo(target.y, 4);
      }
    }
  });

  it("solves a forearm against its CURRENT parent, not a stale bind parent", () => {
    // The regression this file exists for. The upper arm and forearm are
    // solved in the same frame; if the forearm is solved against the upper
    // arm's BIND orientation rather than its freshly-updated one, the forearm
    // lands somewhere else entirely and the arm visibly folds wrong.
    const binds = freshBinds();
    // Unit length matters: these are compared against a normalized result, so
    // a target of length 0.999 fails by ~7e-4 for reasons that have nothing
    // to do with the behaviour under test.
    const unit = (x: number, y: number) => {
      const l = Math.hypot(x, y);
      return { x: x / l, y: y / l };
    };
    const upperTarget = unit(0.95, -0.31);
    const foreTarget = unit(-0.31, -0.95);

    applyPoseToRig(binds, { l_uparm: upperTarget, l_lowarm: foreTarget });

    const upper = binds.get("l_uparm")!;
    const fore = binds.get("l_lowarm")!;

    const upperDir = worldDirOf(upper, "l_uparm");
    const upperXY = new THREE.Vector2(upperDir.x, upperDir.y).normalize();
    expect(upperXY.x).toBeCloseTo(upperTarget.x, 4);
    expect(upperXY.y).toBeCloseTo(upperTarget.y, 4);

    const foreDir = worldDirOf(fore, "l_lowarm");
    const foreXY = new THREE.Vector2(foreDir.x, foreDir.y).normalize();
    expect(foreXY.x, "forearm azimuth x").toBeCloseTo(foreTarget.x, 4);
    expect(foreXY.y, "forearm azimuth y").toBeCloseTo(foreTarget.y, 4);
    expect(foreDir.z, "forearm preserved depth").toBeCloseTo(fore.bindDirWorld.z, 4);
  });

  it("never produces a NaN quaternion, including for degenerate directions", () => {
    const binds = freshBinds();
    const nasty = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
      { x: -1, y: 0 },
    ];
    for (const t of nasty) {
      applyPoseToRig(binds, Object.fromEntries(DRIVEN_BONES.map((n) => [n, t])));
      for (const [name, bind] of binds) {
        const q = bind.bone.quaternion;
        expect(Number.isFinite(q.x) && Number.isFinite(q.y), name).toBe(true);
        expect(Number.isFinite(q.z) && Number.isFinite(q.w), name).toBe(true);
        expect(q.length(), `${name} normalized`).toBeCloseTo(1, 5);
      }
    }
  });
});

describe("spine bends as a chain", () => {
  /** World direction from the base of the spine to the neck — the torso's
   * overall lean, which is what the distributed bend is meant to control. */
  function torsoDir(): THREE.Vector3 {
    model.updateMatrixWorld(true);
    const base = new THREE.Vector3();
    const top = new THREE.Vector3();
    model.getObjectByName("c_spine0")!.getWorldPosition(base);
    model.getObjectByName("c_neck")!.getWorldPosition(top);
    return top.sub(base).normalize();
  }

  it("leans the torso by the angle actually requested, not a fraction of it", () => {
    // Regression guard. Distributing a bend across the chain made the visible
    // torso lean only ~60% of what was asked for — consistently, because the
    // chord averages segment rotations that are each only partway through the
    // bend. chordCompensation() scales that back out; this pins the result.
    const binds = freshBinds();

    for (const deg of [5, 10, 20, 30, 45]) {
      const r = (deg * Math.PI) / 180;
      applyPoseToRig(binds, { c_spine0: { x: Math.sin(r), y: Math.cos(r) } });
      const d = torsoDir();
      const achieved = (Math.atan2(d.x, d.y) * 180) / Math.PI;
      expect(achieved, `${deg} degree lean`).toBeGreaterThan(deg * 0.95);
      expect(achieved, `${deg} degree lean`).toBeLessThan(deg * 1.05);
    }
  });

  it("leans the opposite way for an opposite target", () => {
    const binds = freshBinds();
    const r = (25 * Math.PI) / 180;
    applyPoseToRig(binds, { c_spine0: { x: -Math.sin(r), y: Math.cos(r) } });
    const d = torsoDir();
    expect((Math.atan2(d.x, d.y) * 180) / Math.PI).toBeLessThan(-20);
  });

  it("shares the bend across all four segments instead of hinging at one", () => {
    const binds = freshBinds();
    const before = SPINE_CHAIN.map(
      (s) => binds.get(s.bone)!.bone.quaternion.clone()
    );

    applyPoseToRig(binds, { c_spine0: { x: 0.5, y: Math.sqrt(1 - 0.25) } });

    // Every segment rotated. If any stayed put, the chain is hinging.
    SPINE_CHAIN.forEach((s, i) => {
      const q = binds.get(s.bone)!.bone.quaternion;
      const dot = Math.abs(
        q.x * before[i].x + q.y * before[i].y + q.z * before[i].z + q.w * before[i].w
      );
      expect(Math.abs(dot - 1), `${s.bone} should have rotated`).toBeGreaterThan(1e-5);
    });
  });

  it("returns the whole chain to rest when the torso is untracked", () => {
    const binds = freshBinds();
    const rest = SPINE_CHAIN.map((s) => binds.get(s.bone)!.bindLocalQuat.clone());

    applyPoseToRig(binds, { c_spine0: { x: 0.6, y: 0.8 } });
    applyPoseToRig(binds, {});

    SPINE_CHAIN.forEach((s, i) => {
      const q = binds.get(s.bone)!.bone.quaternion;
      const dot = Math.abs(
        q.x * rest[i].x + q.y * rest[i].y + q.z * rest[i].z + q.w * rest[i].w
      );
      expect(Math.abs(dot - 1), s.bone).toBeLessThan(1e-9);
    });
  });

  it("weights sum to one, so the chain reproduces the full bend", () => {
    const total = SPINE_CHAIN.reduce((n, s) => n + s.weight, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe("depth recovery from foreshortening", () => {
  it("reports no depth when the limb is seen at full length", () => {
    expect(recoverDepth(0.54, 0.54)).toBeCloseTo(0, 6);
  });

  it("reports full depth when the limb projects to nothing", () => {
    // Arm pointed straight down the camera axis.
    expect(recoverDepth(0, 0.54)).toBeCloseTo(1, 6);
  });

  it("is the sine of the out-of-plane angle", () => {
    // A limb at 60 degrees out of plane projects to cos(60) = 0.5 of its
    // length and should report sin(60).
    expect(recoverDepth(0.5 * 0.54, 0.54)).toBeCloseTo(Math.sin(Math.PI / 3), 6);
  });

  it("clamps rather than producing NaN when the projection exceeds the estimate", () => {
    // Happens transiently while the per-player limb estimate is still growing.
    expect(recoverDepth(0.9, 0.54)).toBe(0);
    expect(Number.isNaN(recoverDepth(0.5, 0))).toBe(false);
    expect(recoverDepth(0.5, 0)).toBe(0);
  });

  it("makes a punch toward the camera extend forward rather than barely move", () => {
    const binds = freshBinds();
    // l_uparm is the clearer demonstration: its bind depth is only 0.053, so
    // without recovery a punch at the lens leaves it essentially flat to the
    // screen. (l_lowarm already sits at 0.557 — the forearm angles forward
    // even at rest — so there is far less headroom to show.)
    const bind = binds.get("l_uparm")!;

    applyPoseToRig(binds, { l_uparm: { x: 0.0, y: -1.0 } });
    const flat = worldDirOf(bind, "l_uparm");
    expect(flat.z).toBeLessThan(0.1);

    applyPoseToRig(binds, { l_uparm: { x: 0.0, y: -1.0, z: 0.8 } });
    const toward = worldDirOf(bind, "l_uparm");

    expect(toward.z).toBeGreaterThan(flat.z + 0.5);
    expect(toward.z).toBeCloseTo(0.8, 4);
  });

  it("honours the recovered depth exactly on the forearm too", () => {
    const binds = freshBinds();
    const bind = binds.get("l_lowarm")!;
    applyPoseToRig(binds, { l_lowarm: { x: 0.0, y: -1.0, z: 0.9 } });
    expect(worldDirOf(bind, "l_lowarm").z).toBeCloseTo(0.9, 4);
  });
});

describe("mirroring", () => {
  it("drives the character's left arm from the player's RIGHT arm when mirrored", () => {
    // The mirrored preview shows the player's right arm on the right of the
    // screen; the character's l_* bones are the ones at world +X, which also
    // render on the right. So they must be driven by the player's right arm.
    const pose = synthPose({
      mirrored: true,
      rightArm: { x: 0.8, y: -0.6 },
      leftArm: { x: -0.1, y: -0.99 },
    });
    const targets = computeBoneTargets(pose, true);
    expect(targets.l_uparm!.x).toBeCloseTo(0.8, 3);
    expect(targets.l_uparm!.y).toBeCloseTo(-0.6, 3);
    expect(targets.r_uparm!.x).toBeCloseTo(-0.1, 3);
  });

  it("maps anatomical sides straight through when not mirrored", () => {
    const pose = synthPose({
      mirrored: false,
      leftArm: { x: 0.8, y: -0.6 },
      rightArm: { x: -0.1, y: -0.99 },
    });
    const targets = computeBoneTargets(pose, false);
    expect(targets.l_uparm!.x).toBeCloseTo(0.8, 3);
    expect(targets.l_uparm!.y).toBeCloseTo(-0.6, 3);
    expect(targets.r_uparm!.x).toBeCloseTo(-0.1, 3);
  });

  it("omits bones whose landmarks are untracked rather than guessing", () => {
    const pose = synthPose({ mirrored: true });
    pose.rightShoulder = { ...pose.rightShoulder, confidence: 0 };
    const targets = computeBoneTargets(pose, true);
    expect(targets.l_uparm).toBeUndefined(); // mirrored: right arm drives l_*
    expect(targets.r_uparm).toBeDefined();
  });

  it("produces unit-length targets for every tracked bone", () => {
    const targets = computeBoneTargets(synthPose({ mirrored: true }), true);
    for (const [name, t] of Object.entries(targets)) {
      expect(Math.hypot(t.x, t.y), name).toBeCloseTo(1, 6);
    }
  });
});

describe("damped joints", () => {
  it("rotates a gained bone, but by less than the full swing", () => {
    // The clavicle must move — a frozen collarbone is why a raised guard read
    // stiffly — but not track the shoulder-midpoint direction one-for-one,
    // which throws the whole shoulder around. This pins both halves.
    const binds = freshBinds();
    const name: DrivenBoneName = "l_clavicle";
    const bind = binds.get(name)!;
    const gain = BONE_GAIN[name]!;
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(1);

    const target = { x: 0.6, y: -0.8 };
    applyPoseToRig(binds, { [name]: target });
    const damped = worldDirOf(bind, name).clone();

    // Same target at full gain, for comparison.
    const fresh = freshBinds();
    const freshBind = fresh.get(name)!;
    applyBoneTarget(freshBind, target, 1);
    const full = worldDirOf(freshBind, name).clone();

    const bindDir = bind.bindDirWorld;
    const movedDamped = bindDir.angleTo(damped);
    const movedFull = bindDir.angleTo(full);

    expect(movedDamped, "clavicle should actually move").toBeGreaterThan(1e-3);
    expect(movedDamped, "damped swing should fall short of the full swing")
      .toBeLessThan(movedFull);
  });
});

describe("head orientation", () => {
  it("reads zero yaw from a symmetric face and turns with the nose", () => {
    const centred = synthPose({ mirrored: false });
    const straight = measureHeadSignals(centred, false, 0.35)!;
    expect(straight).not.toBeNull();
    expect(straight.yaw, "symmetric face reads as no turn").toBeCloseTo(0, 6);

    // Turn toward the player's own left: in the RAW image the nose slides
    // toward the left ear (larger x) and that ear closes in behind the head.
    const turned = { ...centred, nose: kp(0.545, 0.25) };
    const t = measureHeadSignals(turned, false, 0.35)!;
    expect(t.yaw, "turning left reads positive under direct mapping")
      .toBeGreaterThan(0.1);

    // The mirrored mapping swaps the character's sides, so the sense flips.
    const m = measureHeadSignals(turned, true, 0.35)!;
    expect(m.yaw).toBeCloseTo(-t.yaw, 9);
  });

  it("yaws the head about the vertical without bending the neck sideways", () => {
    // The point of driving yaw separately: turning the head must not move the
    // neck. An aim solve cannot produce a twist at all, so before this existed
    // a head turn either did nothing or leaked into a sideways lean.
    const binds = freshBinds();
    const neck = binds.get("c_neck")!;
    const head = binds.get("c_head")!;

    applyPoseToRig(binds, {}, null);
    model.updateMatrixWorld(true);
    const neckRest = new THREE.Vector3();
    neck.bone.getWorldPosition(neckRest);
    const headRest = new THREE.Vector3();
    head.bone.getWorldPosition(headRest);
    const restQuat = head.bone.quaternion.clone();

    applyPoseToRig(binds, {}, { yaw: 0.6, pitch: 0 });
    model.updateMatrixWorld(true);

    const headNow = new THREE.Vector3();
    head.bone.getWorldPosition(headNow);
    // The head bone sits on the neck axis, so a pure yaw must not translate it.
    expect(headNow.distanceTo(headRest), "yaw must not move the head off-axis")
      .toBeLessThan(1e-6);
    // But it must genuinely have rotated.
    const dot = Math.abs(head.bone.quaternion.dot(restQuat));
    expect(1 - dot, "head should have rotated").toBeGreaterThan(1e-4);

    // And the neck itself is untouched.
    const neckNow = new THREE.Vector3();
    neck.bone.getWorldPosition(neckNow);
    expect(neckNow.distanceTo(neckRest)).toBeLessThan(1e-9);
  });

  it("returns the head to rest when the player isn't tracked", () => {
    const binds = freshBinds();
    const head = binds.get("c_head")!;
    const rest = head.bindLocalQuat.clone();
    applyPoseToRig(binds, {}, { yaw: 0.5, pitch: 0.2 });
    expect(Math.abs(head.bone.quaternion.dot(rest))).toBeLessThan(1 - 1e-4);
    applyPoseToRig(binds, {}, null);
    // 6 decimal places rather than 9: see REST_EPSILON on why the asset no
    // longer returns bit-identically to bind.
    expect(Math.abs(head.bone.quaternion.dot(rest))).toBeCloseTo(1, 6);
  });
});

describe("optional landmarks", () => {
  it("leaves legs and wrists at rest when those landmarks are absent", () => {
    // The normal case at a desk webcam: no knees, ankles or hand points in
    // frame. Those bones must stay at their exported rest pose rather than
    // being driven from a missing landmark defaulting to (0,0).
    const binds = freshBinds();
    const pose = synthPose({ mirrored: false });
    expect(pose.leftKnee, "fixture deliberately omits legs").toBeUndefined();

    const targets = computeBoneTargets(pose, false);
    for (const name of ["l_upleg", "l_lowleg", "r_upleg", "r_lowleg", "l_wrist", "r_wrist"] as const) {
      expect(targets[name], `${name} must not be driven`).toBeUndefined();
    }
    // The arms and torso, whose landmarks ARE present, still are.
    expect(targets.l_uparm).toBeDefined();
    expect(targets.c_spine0).toBeDefined();

    // And the undriven bones really do sit at their exported rest rotation
    // after a full solve, rather than merely being absent from the targets.
    applyPoseToRig(binds, targets);
    for (const name of ["l_upleg", "l_lowleg", "l_wrist", "r_wrist"] as const) {
      const bind = binds.get(name)!;
      const dot = Math.abs(bind.bone.quaternion.dot(bind.bindLocalQuat));
      expect(dot, `${name} should be untouched`).toBeCloseTo(1, 9);
    }
  });

  it("drives the legs once knees and ankles are tracked", () => {
    const pose = synthPose({ mirrored: false });
    const withLegs: PoseFrame = {
      ...pose,
      leftKnee: kp(0.58, 0.88),
      rightKnee: kp(0.42, 0.88),
      leftAnkle: kp(0.58, 0.99),
      rightAnkle: kp(0.42, 0.99),
    };
    const targets = computeBoneTargets(withLegs, false);
    expect(targets.l_upleg).toBeDefined();
    expect(targets.l_lowleg).toBeDefined();
    expect(Math.hypot(targets.l_upleg!.x, targets.l_upleg!.y)).toBeCloseTo(1, 6);
  });
});

describe("handedness contract", () => {
  it("puts the player's right arm on the character's right, in the default view", () => {
    // The whole point of the over-the-shoulder view: the camera sits behind
    // the character at -Z, so world -X is SCREEN RIGHT and the anatomically
    // correct r_* bones render on the same side the player sees their own
    // right arm on in the mirrored preview. Both halves are asserted, because
    // changing either one alone is exactly the bug this replaced.
    expect(VIEW_MODES.behind.mirrored, "rear view uses the anatomical mapping")
      .toBe(false);
    expect(VIEW_MODES.behind.cameraSide, "camera is behind a +Z-facing rig")
      .toBe(-1);

    const binds = freshBinds();
    // Player's RIGHT arm raised: in the raw image their right side is at
    // SMALLER x, and the arm points up.
    const pose: PoseFrame = {
      ...synthPose({ mirrored: false }),
      rightShoulder: kp(0.4, 0.4),
      rightElbow: kp(0.38, 0.26),
      rightWrist: kp(0.37, 0.14),
    };
    applyPoseToRig(binds, computeBoneTargets(pose, VIEW_MODES.behind.mirrored));
    model.updateMatrixWorld(true);

    const lw = new THREE.Vector3();
    const rw = new THREE.Vector3();
    binds.get("l_lowarm")!.bone.getWorldPosition(lw);
    binds.get("r_lowarm")!.bone.getWorldPosition(rw);

    expect(rw.y, "the character's RIGHT arm is the one that rises")
      .toBeGreaterThan(lw.y);
    expect(rw.x, "and it lives at world -X, which is screen-right from behind")
      .toBeLessThan(0);
  });
});

describe("hallucinated landmarks", () => {
  it("ignores legs that MediaPipe has extrapolated below the frame", () => {
    // BlazePose reports a confident-looking knee for a leg that is simply not
    // in shot. Trusting it gives the boxer invented legs that twitch with
    // every torso wobble, so out-of-frame positions are rejected outright.
    const pose = synthPose({ mirrored: false });
    const belowFrame: PoseFrame = {
      ...pose,
      leftKnee: kp(0.58, 1.4),
      rightKnee: kp(0.42, 1.4),
      leftAnkle: kp(0.58, 1.9),
      rightAnkle: kp(0.42, 1.9),
    };
    const targets = computeBoneTargets(belowFrame, false);
    expect(targets.l_upleg, "knee below the frame is a guess").toBeUndefined();
    expect(targets.l_lowleg).toBeUndefined();

    // The arm chain is deliberately exempt — a punch at the camera pushes a
    // wrist to the very edge of frame and must still drive the character.
    const wristAtEdge: PoseFrame = { ...pose, leftWrist: kp(1.08, 0.42) };
    expect(computeBoneTargets(wristAtEdge, false).l_lowarm).toBeDefined();
  });
});
