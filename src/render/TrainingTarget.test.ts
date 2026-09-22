import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { TrainingTarget } from "./TrainingTarget";
import type { StrikeEvent } from "../perception/strikeResolver";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
} from "../perception/strikeGeometry";
import { STRIKE_CONFIG } from "../config/tuning";

const MODEL_PATH = "public/models/boxer_lod3.glb";
let source: THREE.Object3D;

beforeAll(async () => {
  const buf = readFileSync(MODEL_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  source = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => resolve(g.scene), reject);
  });
}, 60_000);

let model: THREE.Object3D;
let target: TrainingTarget;

beforeEach(() => {
  model = cloneSkinned(source);
  target = new TrainingTarget(model);
  model.rotation.y = Math.PI; // turned to face the player, as in the scene
  target.setHome(new THREE.Vector3(0, 0, 1.15));
});

// Built from a landing point rather than a hand-written zone, so the fixture
// exercises the same derivation the live resolver does - a test that hardcoded
// both the point and the zone could not catch them disagreeing.
const strike = (over: Partial<StrikeEvent> = {}): StrikeEvent => {
  const impact = over.impact ?? { lateral: 0, height: 1.22 };
  const approach = over.approach ?? approachOf(0, 0, 1);
  const region = over.region ?? regionAt(impact);
  const power = over.power ?? 1;
  return {
    hand: "right",
    zone: coarseZone(impact),
    impact,
    region,
    approach,
    damage: damageOf(region, power, approach),
    contactReach:
      STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
    power,
    speed: 4,
    timestamp: 0,
    ...over,
  };
};

function headWorld(): THREE.Vector3 {
  model.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  model.getObjectByName("c_head")!.getWorldPosition(v);
  return v;
}

/**
 * The head's position relative to the figure's own root.
 *
 * Needed to see the posture separately from the whole-body knockback: every
 * punch pushes the target backwards along +Z, and at a realistic knockback
 * that translation is larger than the body-fold rotation, so measuring the
 * head in world space says "moved backwards" for every kind of hit.
 */
function headRelativeToRoot(): THREE.Vector3 {
  return headWorld().sub(model.position);
}

/** Runs the reaction forward, returning the peak head displacement seen. */
function settle(seconds: number, step = 1 / 60): THREE.Vector3[] {
  const path: THREE.Vector3[] = [];
  for (let t = 0; t < seconds; t += step) {
    target.update(step);
    path.push(headWorld());
  }
  return path;
}

describe("TrainingTarget", () => {
  it("clones into an independent skeleton, not one sharing the player's bones", () => {
    // The reason cloneSkinned is used rather than Object3D.clone: a plain
    // clone leaves the copy's SkinnedMesh bound to the original bones, so the
    // target would deform with the player's character. Silent and baffling.
    const playerBone = source.getObjectByName("c_head")!;
    const targetBone = model.getObjectByName("c_head")!;
    expect(targetBone).not.toBe(playerBone);

    let skinned: THREE.SkinnedMesh | null = null;
    model.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh;
    });
    expect(skinned).not.toBeNull();
    const bones = skinned!.skeleton.bones;
    expect(bones.some((b) => b === playerBone)).toBe(false);
    expect(bones.some((b) => b === targetBone)).toBe(true);
  });

  it("stands still until it is hit", () => {
    const before = headWorld();
    settle(0.5);
    expect(headWorld().distanceTo(before)).toBeLessThan(1e-6);
  });

  it("snaps the head back from a head shot, then recovers", () => {
    const rest = headWorld();
    target.hit(strike());
    const path = settle(2.5);

    const peak = Math.max(...path.map((p) => p.distanceTo(rest)));
    expect(peak, "a full-power head shot should visibly move the head")
      .toBeGreaterThan(0.02);

    const end = path[path.length - 1];
    expect(end.distanceTo(rest), "and it should settle back").toBeLessThan(0.004);
  });

  it("builds up faster than it recovers", () => {
    // An impact is sudden; the recovery from it is not. Equal time constants
    // read as the target politely leaning away.
    const rest = headWorld();
    target.hit(strike());
    const path = settle(1.2);
    const distances = path.map((p) => p.distanceTo(rest));
    const peakAt = distances.indexOf(Math.max(...distances));
    // Peak well inside the first fifth of the window.
    expect(peakAt).toBeLessThan(path.length / 5);
  });

  it("sends head and body shots in opposite directions", () => {
    const rest = headRelativeToRoot();
    target.hit(strike({ zone: { height: "head", lane: "centre" } }));
    settle(0.12);
    const headShot = headRelativeToRoot().sub(rest);

    // Fresh target, so the two reactions can't accumulate.
    model = cloneSkinned(source);
    target = new TrainingTarget(model);
    model.rotation.y = Math.PI;
    target.setHome(new THREE.Vector3(0, 0, 1.15));
    const rest2 = headRelativeToRoot();
    target.hit(strike({ zone: { height: "body", lane: "centre" } }));
    settle(0.12);
    const bodyShot = headRelativeToRoot().sub(rest2);

    // A head shot drives the head back (+Z, away from the player at -Z);
    // a body shot folds the target forward, toward them.
    expect(headShot.z, "head shot drives the head away").toBeGreaterThan(0);
    expect(bodyShot.z, "body shot folds the target toward the puncher")
      .toBeLessThan(0);
  });

  it("sends left and right lanes to opposite sides", () => {
    const rest = headRelativeToRoot();
    target.hit(strike({ zone: { height: "head", lane: "left" } }));
    settle(0.12);
    const left = headRelativeToRoot().x - rest.x;

    model = cloneSkinned(source);
    target = new TrainingTarget(model);
    model.rotation.y = Math.PI;
    target.setHome(new THREE.Vector3(0, 0, 1.15));
    const rest2 = headRelativeToRoot();
    target.hit(strike({ zone: { height: "head", lane: "right" } }));
    settle(0.12);
    const right = headRelativeToRoot().x - rest2.x;

    expect(Math.sign(left)).toBe(-Math.sign(right));
    expect(Math.abs(left)).toBeGreaterThan(1e-3);
  });

  it("scales the reaction with power", () => {
    const rest = headWorld();
    target.hit(strike({ power: 0.3 }));
    const weak = Math.max(...settle(0.3).map((p) => p.distanceTo(rest)));

    model = cloneSkinned(source);
    target = new TrainingTarget(model);
    model.rotation.y = Math.PI;
    target.setHome(new THREE.Vector3(0, 0, 1.15));
    const rest2 = headWorld();
    target.hit(strike({ power: 1 }));
    const strong = Math.max(...settle(0.3).map((p) => p.distanceTo(rest2)));

    expect(strong).toBeGreaterThan(weak * 1.5);
  });

  it("tallies hits by zone", () => {
    target.hit(strike({ zone: { height: "head", lane: "centre" } }));
    target.hit(strike({ zone: { height: "head", lane: "centre" } }));
    target.hit(strike({ zone: { height: "body", lane: "left" } }));
    expect(target.debug.hits).toBe(3);
    expect(target.debug.byZone["head/centre"]).toBe(2);
    expect(target.debug.byZone["body/left"]).toBe(1);

    target.resetScore();
    expect(target.debug.hits).toBe(0);
    expect(target.debug.byZone).toEqual({});
  });

  it("never accumulates past the clamp, however fast the combination", () => {
    const rest = headWorld();
    for (let i = 0; i < 30; i++) {
      target.hit(strike());
      target.update(1 / 60);
    }
    const peak = Math.max(...settle(0.5).map((p) => p.distanceTo(rest)));
    // A single full-power hit's peak, measured on a fresh target.
    model = cloneSkinned(source);
    const solo = new TrainingTarget(model);
    model.rotation.y = Math.PI;
    solo.setHome(new THREE.Vector3(0, 0, 1.15));
    const soloRest = headWorld();
    solo.hit(strike());
    let soloPeak = 0;
    for (let t = 0; t < 0.5; t += 1 / 60) {
      solo.update(1 / 60);
      soloPeak = Math.max(soloPeak, headWorld().distanceTo(soloRest));
    }
    // Thirty hits must not produce thirty times the motion.
    expect(peak).toBeLessThan(soloPeak * 1.6);
  });
});
