import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { findBodyMesh } from "../findBodyMesh";
import { FaceDamage, faceDamageScore } from "./faceDamage";
import { locateFaceFeatures } from "./facePainter";
import { dominantBones } from "../texturing/bodyUv";
import { FACE_CONFIG } from "../../config/tuning";

// Against the real asset: the swelling is driven by scaling actual rig bones,
// so a mock skeleton would prove nothing about whether those bones exist.

const MODEL_PATH = "public/models/boxer_lod3.glb";
let scene: THREE.Object3D;
let mesh: THREE.SkinnedMesh;

beforeAll(async () => {
  const buf = readFileSync(MODEL_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  scene = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => resolve(g.scene), reject);
  });
  // The body specifically. The asset now carries eyeballs, which are also
  // skinned, so "the last skinned mesh" is an eye -- see findBodyMesh.
  mesh = findBodyMesh(scene)!;
}, 60_000);

const make = () => new FaceDamage({ root: scene });

describe("facial damage model", () => {
  it("finds the facial bones it needs on the shipped rig", () => {
    for (const name of ["l_eye", "r_eye", "c_jaw"]) {
      expect(scene.getObjectByName(name), name).toBeDefined();
    }
  });

  it("swells the eye on the side that was actually hit", () => {
    const f = make();
    f.hit("temple_left", 1);
    f.update(0);
    expect(f.damage.sites.eyeLeft.swelling).toBeGreaterThan(0);
    expect(f.damage.sites.eyeRight.swelling).toBe(0);
    expect(f.damage.eyeClosure.left).toBeGreaterThan(f.damage.eyeClosure.right);
  });

  it("closes an eye progressively as the beating continues", () => {
    const f = make();
    const closures: number[] = [];
    for (let i = 0; i < 6; i++) {
      f.hit("temple_right", 1);
      f.update(0);
      closures.push(f.damage.eyeClosure.right);
    }
    // Monotonically worse, and eventually shut.
    for (let i = 1; i < closures.length; i++) {
      expect(closures[i]).toBeGreaterThanOrEqual(closures[i - 1]);
    }
    expect(closures[closures.length - 1]).toBeGreaterThan(0.85);
  });

  it("tracks eye closure as a metric even though nothing renders it", () => {
    // The generated eyeballs and lids this used to drive were removed on
    // 2026-09-16 - see blender/README.md. Closure is still computed
    // because the HUD and the CPU both want to know a fighter is losing an eye,
    // and because the Blender-authored head will have real lids to drive.
    //
    // It cannot be driven through the rig: the eye bones carry zero skin
    // weight (asserted below), so scaling them deforms nothing at all.
    const f = make();
    for (let i = 0; i < 8; i++) f.hit("temple_left", 1);
    f.update(0);
    expect(f.damage.eyeClosure.left).toBeGreaterThan(0.85);
    f.reset();
    f.update(0);
    expect(f.damage.eyeClosure.left).toBe(0);
  });

  it("puffs the JAW bone, which does carry weight", () => {
    const jaw = scene.getObjectByName("c_jaw")!;
    const rest = jaw.scale.clone();
    const f = make();
    for (let i = 0; i < 6; i++) f.hit("jaw_left", 1);
    f.update(0);
    expect(jaw.scale.x).toBeGreaterThan(rest.x * 1.02);
    f.reset();
    expect(jaw.scale.x).toBeCloseTo(rest.x, 6);
  });

  it("never compounds swelling into a balloon across frames", () => {
    // Scale is always applied relative to the bind pose. Applying it relative
    // to the current scale would multiply every frame and inflate the jaw
    // without bound within a second.
    const jaw = scene.getObjectByName("c_jaw")!;
    const f = make();
    f.hit("jaw_left", 0.6);
    f.update(0);
    const after1 = jaw.scale.x;
    for (let i = 0; i < 30; i++) f.update(0.001);
    expect(jaw.scale.x).toBeGreaterThan(after1 * 0.95);
    expect(jaw.scale.x).toBeLessThan(after1 * 1.05);
  });

  it("bleeds from the nose but not from a glancing touch", () => {
    const soft = make();
    soft.hit("nose", 0.2);
    soft.update(0);
    expect(soft.damage.sites.nose.swelling).toBeGreaterThan(0);
    expect(soft.damage.sites.nose.bleed).toBe(0);

    const hard = make();
    hard.hit("nose", 1);
    hard.update(0);
    expect(hard.damage.sites.nose.bleed).toBeGreaterThan(0);
  });

  it("only opens a cut on tissue that is already swollen", () => {
    // Swollen skin splits; fresh skin absorbs. So a single clean shot should
    // never open a cut, however hard.
    const f = make();
    f.hit("temple_left", 1);
    f.update(0);
    expect(f.damage.sites.eyeLeft.cut).toBe(0);

    for (let i = 0; i < 5; i++) f.hit("temple_left", 1);
    f.update(0);
    expect(f.damage.sites.eyeLeft.swelling).toBeGreaterThan(
      FACE_CONFIG.cutSwellingRequired
    );
    expect(f.damage.sites.eyeLeft.cut).toBeGreaterThan(0);
  });

  it("dries blood much faster than swelling subsides", () => {
    const f = make();
    f.hit("nose", 1);
    f.update(0);
    const bleed0 = f.damage.sites.nose.bleed;
    const swell0 = f.damage.sites.nose.swelling;

    f.update(10);
    const bleedFrac = f.damage.sites.nose.bleed / bleed0;
    const swellFrac = f.damage.sites.nose.swelling / swell0;
    expect(bleedFrac).toBeLessThan(swellFrac);
  });

  it("does not heal cuts during a fight", () => {
    const f = make();
    for (let i = 0; i < 6; i++) f.hit("temple_right", 1);
    f.update(0);
    const cut = f.damage.sites.eyeRight.cut;
    expect(cut).toBeGreaterThan(0);
    f.update(120);
    expect(f.damage.sites.eyeRight.cut).toBe(cut);
  });

  it("ignores regions that are not on the face", () => {
    const f = make();
    f.hit("liver", 1);
    f.hit("solar_plexus", 1);
    f.hit("crown", 1);
    f.update(0);
    expect(f.any).toBe(false);
  });

  it("reports a rising damage score", () => {
    const f = make();
    const a = faceDamageScore(f.damage);
    f.hit("jaw_left", 1);
    f.hit("nose", 1);
    f.update(0);
    expect(faceDamageScore(f.damage)).toBeGreaterThan(a);
    expect(faceDamageScore(f.damage)).toBeLessThanOrEqual(1);
  });

  it("signals a repaint only when something actually changed", () => {
    // The texture repaint is a full canvas rebuild. Firing it every frame on a
    // clean face would burn that for nothing.
    let calls = 0;
    const f = new FaceDamage({ root: scene, onChanged: () => calls++ });
    f.update(0.016); // first tick paints the eyes
    const afterFirst = calls;
    for (let i = 0; i < 20; i++) f.update(0.016);
    expect(calls).toBe(afterFirst);

    f.hit("nose", 1);
    f.update(0.016);
    expect(calls).toBeGreaterThan(afterFirst);
  });
});

/**
 * Eye bind positions in geometry space. Needed because l_eye/r_eye carry zero
 * skin weight on this rig, so there are no eye vertices to average - measured,
 * not assumed, and asserted below.
 */
const eyeBinds = () => {
  const names = mesh.skeleton.bones.map((b) => b.name);
  const at = (n: string) =>
    new THREE.Vector3().setFromMatrixPosition(
      mesh.skeleton.boneInverses[names.indexOf(n)].clone().invert()
    );
  return { left: at("l_eye"), right: at("r_eye") };
};

describe("face feature UVs", () => {
  it("confirms the eye bones carry no skin weight at all", () => {
    // The measurement that forced generated eye geometry. If a future
    // re-export ever does weight these bones, this test fails and the simpler
    // bone-driven path becomes available again - which is worth knowing.
    const names = mesh.skeleton.bones.map((b) => b.name);
    const si = mesh.geometry.getAttribute("skinIndex");
    const sw = mesh.geometry.getAttribute("skinWeight");
    let eyeWeight = 0;
    let jawWeight = 0;
    for (let i = 0; i < si.count; i++) {
      for (const k of ["getX", "getY", "getZ", "getW"] as const) {
        const n = names[si[k](i)];
        const w = sw[k](i);
        if (n === "l_eye" || n === "r_eye") eyeWeight += w;
        if (n === "c_jaw") jawWeight += w;
      }
    }
    expect(eyeWeight).toBe(0);
    // The jaw is weighted, which is why cheek puff stays bone-driven.
    expect(jawWeight).toBeGreaterThan(50);
  });

  it("locates both eyes and the jaw in UV space", () => {
    const boneNames = mesh.skeleton.bones.map((b) => b.name);
    const dominant = dominantBones(mesh.geometry);
    const f = locateFaceFeatures(mesh.geometry, boneNames, dominant, eyeBinds());
    expect(f).not.toBeNull();
    for (const site of [f!.eyeLeft, f!.eyeRight, f!.jaw]) {
      expect(site.u).toBeGreaterThanOrEqual(0);
      expect(site.u).toBeLessThanOrEqual(1);
      expect(site.v).toBeGreaterThanOrEqual(0);
      expect(site.v).toBeLessThanOrEqual(1);
    }
    expect(f!.eyeRadius).toBeGreaterThan(0);
  });

  it("puts the two eyes apart, and both inside the head island", () => {
    // Measured with tools/uv-regions.mjs: the head owns u 0.003-0.499,
    // v 0.003-0.453. Eyes landing outside that would paint onto a leg.
    const boneNames = mesh.skeleton.bones.map((b) => b.name);
    const dominant = dominantBones(mesh.geometry);
    const f = locateFaceFeatures(mesh.geometry, boneNames, dominant, eyeBinds())!;
    const gap = Math.hypot(
      f.eyeLeft.u - f.eyeRight.u,
      f.eyeLeft.v - f.eyeRight.v
    );
    expect(gap).toBeGreaterThan(0.005);
    for (const site of [f.eyeLeft, f.eyeRight]) {
      expect(site.u).toBeLessThan(0.5);
      expect(site.v).toBeLessThan(0.46);
    }
  });
});
