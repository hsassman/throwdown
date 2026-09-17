import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { captureBindPose } from "./mediapipeToMhrRig";
import { applyCrouch, captureCrouch, crouchDrop, type CrouchRig } from "./crouch";
import { CROUCH_CONFIG } from "../../config/tuning";

// Against the real asset: the whole question is whether the legs are long
// enough and jointed the way the maths assumes, and a mock would have whatever
// proportions the mock's author chose.

let source: THREE.Object3D;
beforeAll(async () => {
  const buf = readFileSync("public/models/boxer_lod3.glb");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  source = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => resolve(g.scene), reject);
  });
}, 60_000);

let figure: THREE.Object3D;
let rig: CrouchRig;
let scene: THREE.Scene;

beforeEach(() => {
  scene = new THREE.Scene();
  figure = cloneSkinned(source);
  scene.add(figure);
  scene.updateMatrixWorld(true);
  rig = captureCrouch(figure, captureBindPose(figure))!;
});

/** Applies a crouch and moves the root down by the drop, as the driver does. */
function duck(amount: number): void {
  figure.position.y = 0;
  scene.updateMatrixWorld(true);
  const drop = applyCrouch(figure, rig, amount);
  figure.position.y = -drop;
  scene.updateMatrixWorld(true);
}

const world = (name: string) =>
  figure.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());

describe("finding the legs", () => {
  it("captures both legs off the real rig", () => {
    expect(rig.thighs).toHaveLength(2);
    expect(rig.shins).toHaveLength(2);
    expect(rig.waist).not.toBeNull();
  });

  it("measures segment lengths rather than assuming them", () => {
    // A human's thigh and shin are close to equal, which is what makes the
    // ankle stay under the hip through the bend.
    expect(rig.thighLength).toBeGreaterThan(0.2);
    expect(rig.shinLength).toBeGreaterThan(0.2);
    expect(Math.abs(rig.thighLength - rig.shinLength)).toBeLessThan(0.15);
  });
});

describe("the duck", () => {
  it("bends the knee FORWARD, not backward through the heel", () => {
    // The sign is solved, not assumed. Backwards renders as a character
    // squatting through its own legs, and it is a coin flip if hardcoded.
    const before = world("l_lowleg").z;
    duck(1);
    expect(world("l_lowleg").z).toBeGreaterThan(before + 0.05);
  });

  it("drops the head", () => {
    const standing = world("c_head").y;
    duck(1);
    const ducked = world("c_head").y;
    // Enough to take the head off the line of a punch aimed where it was.
    expect(standing - ducked).toBeGreaterThan(0.25);
  });

  it("keeps the feet on the canvas", () => {
    // The entire reason the drop is derived from the bone lengths. Without it
    // the bend swings the feet up instead of lowering the hips — the figure
    // stays at the same height with its legs folded under it, which is the
    // levitation this replaced, now with knees.
    const before = world("l_foot").y;
    duck(1);
    expect(Math.abs(world("l_foot").y - before)).toBeLessThan(0.03);
  });

  it("does not slide the feet forward across the floor", () => {
    const before = world("l_foot").z;
    duck(1);
    expect(Math.abs(world("l_foot").z - before)).toBeLessThan(0.08);
  });

  it("folds at the waist as well as the knees", () => {
    // The knees supply the height; the waist is what actually takes the head
    // off the punch line. A duck that only bent the knees would lower a
    // perfectly upright figure, like a lift.
    // Differential: the bind pose does not stand with the head exactly over
    // the hip, so what matters is that the duck moves it FORWARD of wherever
    // it started, not where it ends up in absolute terms.
    duck(0);
    const upright = world("c_head").z - world("c_spine0").z;
    duck(1);
    const folded = world("c_head").z - world("c_spine0").z;
    expect(folded).toBeGreaterThan(upright + 0.06);
  });

  it("is proportional, and does nothing at zero", () => {
    const standing = world("c_head").y;
    duck(0);
    expect(world("c_head").y).toBeCloseTo(standing, 6);

    duck(0.5);
    const half = standing - world("c_head").y;
    duck(1);
    const full = standing - world("c_head").y;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });
});

describe("the drop", () => {
  it("matches the geometry it claims to implement", () => {
    // (a + b)·(1 − cos θ), from the legs' own measured lengths.
    const expected =
      (rig.thighLength + rig.shinLength) * (1 - Math.cos(CROUCH_CONFIG.kneeAngle));
    expect(crouchDrop(rig, 1)).toBeCloseTo(expected, 9);
    expect(crouchDrop(rig, 0)).toBe(0);
  });

  it("is what applyCrouch actually returns", () => {
    // Two routes to one number is two chances to disagree. This pins them.
    expect(applyCrouch(figure, rig, 0.6)).toBeCloseTo(crouchDrop(rig, 0.6), 9);
  });

  it("clamps rather than inverting on a nonsense crouch", () => {
    expect(applyCrouch(figure, rig, -2)).toBe(0);
    expect(applyCrouch(figure, rig, 5)).toBeCloseTo(crouchDrop(rig, 1), 9);
  });
});

describe("repeated frames", () => {
  it("does not accumulate when asked to start from bind", () => {
    // The real bug: a caller that poses only the arms has nothing resetting
    // the legs, so composing a fresh bend every frame folded the figure inside
    // out within a second — its feet ended up above its head.
    const first = applyCrouch(figure, rig, 1, { fromBind: true });
    const afterOne = world("l_foot").clone();
    for (let i = 0; i < 120; i++) applyCrouch(figure, rig, 1, { fromBind: true });
    scene.updateMatrixWorld(true);
    expect(applyCrouch(figure, rig, 1, { fromBind: true })).toBeCloseTo(first, 9);
    expect(world("l_foot").distanceTo(afterOne)).toBeLessThan(1e-6);
  });
});

describe("composing with a driven leg", () => {
  it("adds to a pose that is already there instead of erasing it", () => {
    // The legs are driven by the retargeting whenever the player's legs are
    // visible. A crouch that overwrote them would cancel a tracked step.
    const thigh = figure.getObjectByName("l_upleg")!;
    const posed = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0.3
    );
    thigh.quaternion.premultiply(posed);
    const withPose = thigh.quaternion.clone();

    applyCrouch(figure, rig, 1);
    // Moved by the crouch...
    expect(thigh.quaternion.angleTo(withPose)).toBeGreaterThan(0.1);
    // ...but not back to where it would be without the driven pose.
    const fresh = cloneSkinned(source);
    const freshRig = captureCrouch(fresh, captureBindPose(fresh))!;
    applyCrouch(fresh, freshRig, 1);
    const undriven = fresh.getObjectByName("l_upleg")!.quaternion;
    expect(thigh.quaternion.angleTo(undriven)).toBeGreaterThan(0.1);
  });
});
