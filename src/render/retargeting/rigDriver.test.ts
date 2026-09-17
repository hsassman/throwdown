import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RigDriver } from "./rigDriver";
import { RENDER_CONFIG } from "../../config/tuning";
import type { Keypoint, PoseFrame } from "../../pose/poseTypes";

// Covers the stateful half of retargeting: smoothing between pose samples,
// per-player limb calibration, and whole-body travel. Runs against the real
// exported rig, for the same reason mediapipeToMhrRig.test.ts does — a mocked
// skeleton would only confirm assumptions rather than the asset.

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
let driver: RigDriver;

beforeEach(() => {
  // A fresh clone per test: RigDriver mutates the hierarchy it is given, and
  // sharing one would let each test inherit the previous test's pose.
  model = source.clone(true);
  driver = new RigDriver(model);
});

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/**
 * A plausible standing pose. `shift` moves the whole body, `reach` shortens
 * the left forearm's projection to imitate a punch thrown at the camera.
 */
function pose(opts: { shift?: number; drop?: number; reach?: number; t?: number } = {}): PoseFrame {
  const dx = opts.shift ?? 0;
  const dy = opts.drop ?? 0;
  const reach = opts.reach ?? 1;
  return {
    timestamp: opts.t ?? 0,
    leftShoulder: kp(0.58 + dx, 0.38 + dy),
    rightShoulder: kp(0.42 + dx, 0.38 + dy),
    leftElbow: kp(0.63 + dx, 0.5 + dy),
    rightElbow: kp(0.37 + dx, 0.5 + dy),
    // Shrinking the forearm's projection is exactly what a punch toward the
    // lens looks like to a frontal camera.
    leftWrist: kp(0.63 + dx, 0.5 + dy + 0.13 * reach),
    rightWrist: kp(0.37 + dx, 0.63 + dy),
    leftHip: kp(0.56 + dx, 0.72 + dy),
    rightHip: kp(0.44 + dx, 0.72 + dy),
    nose: kp(0.5 + dx, 0.22 + dy),
    leftEye: kp(0.53 + dx, 0.21 + dy),
    rightEye: kp(0.47 + dx, 0.21 + dy),
    leftEar: kp(0.56 + dx, 0.22 + dy),
    rightEar: kp(0.44 + dx, 0.22 + dy),
  };
}

/** Runs the driver for `seconds` of simulated time at a given frame rate. */
function run(d: RigDriver, p: PoseFrame | null, seconds: number, fps: number) {
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) d.update(p, dt, true);
}

describe("smoothing", () => {
  it("eases toward the target instead of snapping to it", () => {
    const bone = model.getObjectByName("l_uparm")!;
    const rest = bone.quaternion.clone();

    // A single frame should move only part of the way.
    driver.update(pose({ shift: 0.06 }), 1 / 60, true);
    const afterOne = bone.quaternion.clone();
    const movedOnce = Math.abs(Math.abs(afterOne.dot(rest)) - 1);

    run(driver, pose({ shift: 0.06 }), 1.0, 60);
    const settled = bone.quaternion.clone();
    const movedSettled = Math.abs(Math.abs(settled.dot(rest)) - 1);

    expect(movedOnce).toBeGreaterThan(0);
    expect(movedSettled).toBeGreaterThan(movedOnce * 2);
  });

  it("converges at the same wall-clock rate regardless of frame rate", () => {
    // The whole point of an exponential time constant. If this regresses, the
    // character moves at a different speed on a 144Hz monitor than a 60Hz one.
    const slowModel = source.clone(true);
    const slowDriver = new RigDriver(slowModel);
    const fastModel = source.clone(true);
    const fastDriver = new RigDriver(fastModel);

    const p = pose({ shift: 0.05 });
    run(slowDriver, p, 0.5, 30);
    run(fastDriver, p, 0.5, 144);

    const a = slowModel.getObjectByName("l_uparm")!.quaternion;
    const b = fastModel.getObjectByName("l_uparm")!.quaternion;
    expect(Math.abs(Math.abs(a.dot(b)) - 1)).toBeLessThan(1e-3);
  });

  it("survives a frame delta spike without hurling the character across the scene", () => {
    // What a backgrounded tab hands back on return.
    run(driver, pose({ shift: 0.4 }), 0.5, 60);
    const before = model.position.clone();
    driver.update(pose({ shift: 0.4 }), 30, true);
    expect(model.position.distanceTo(before)).toBeLessThan(0.5);
    expect(Number.isFinite(model.position.x)).toBe(true);
  });

  it("produces no NaN for an untracked pose", () => {
    run(driver, null, 0.3, 60);
    let bad = 0;
    model.traverse((o) => {
      if (!Number.isFinite(o.quaternion.x) || !Number.isFinite(o.position.x)) bad++;
    });
    expect(bad).toBe(0);
  });
});

describe("per-player limb calibration", () => {
  // `pose()` foreshortens the player's LEFT forearm, and these run mirrored —
  // so the bone that responds is r_lowarm, not l_lowarm. That crossover is the
  // mirror mapping working as intended (see rigJointMap.ts); asserting on the
  // wrong side here is an easy and very confusing mistake to make.
  const DRIVEN_BY_PLAYER_LEFT = "r_lowarm" as const;

  it("learns the player's limb length and reports no depth at full extension", () => {
    // Arm held flat to the camera, seen at its full projected length.
    run(driver, pose({ reach: 1 }), 1.0, 60);
    const d = driver.debug;
    expect(d.tracked).toBe(true);
    expect(d.depth[DRIVEN_BY_PLAYER_LEFT]).toBeLessThan(0.35);
  });

  it("reports depth once the limb foreshortens", () => {
    run(driver, pose({ reach: 1 }), 1.0, 60);
    const flat = driver.debug.depth[DRIVEN_BY_PLAYER_LEFT];

    // Same arm, projecting much shorter: it is coming at the lens.
    run(driver, pose({ reach: 0.35, t: 1 }), 0.3, 60);
    const punching = driver.debug.depth[DRIVEN_BY_PLAYER_LEFT];

    expect(punching).toBeGreaterThan(flat + 0.3);
    expect(punching).toBeLessThanOrEqual(1);
  });

  it("leaves the OTHER arm alone when only one is punching", () => {
    run(driver, pose({ reach: 1 }), 1.0, 60);
    run(driver, pose({ reach: 0.35, t: 1 }), 0.3, 60);
    // The player's right arm never moved, so its bone must not gain depth.
    expect(driver.debug.depth.l_lowarm).toBeLessThan(0.35);
  });

  it("keeps limb estimates inside sane bounds", () => {
    run(driver, pose({ reach: 1 }), 1.0, 60);
    for (const v of Object.values(driver.debug.limbFull)) {
      expect(v).toBeGreaterThanOrEqual(RENDER_CONFIG.limbLengthMin);
      expect(v).toBeLessThanOrEqual(RENDER_CONFIG.limbLengthMax);
    }
  });
});

describe("whole-body travel", () => {
  it("sits at neutral when the player has not moved since the first frame", () => {
    run(driver, pose(), 0.5, 60);
    const d = driver.debug;
    expect(Math.abs(d.root.x)).toBeLessThan(0.02);
    expect(Math.abs(d.root.y)).toBeLessThan(0.02);
  });

  it("slips the body sideways when the player does", () => {
    run(driver, pose(), 0.3, 60);
    run(driver, pose({ shift: 0.08, t: 1 }), 0.6, 60);
    // Mirrored, so a move toward increasing image x reads as the opposite way.
    expect(driver.debug.root.x).toBeLessThan(-0.05);
    expect(Math.abs(model.position.x)).toBeGreaterThan(0.01);
  });

  it("drops the body when the player ducks", () => {
    run(driver, pose(), 0.3, 60);
    run(driver, pose({ drop: 0.1, t: 1 }), 0.6, 60);
    expect(driver.debug.root.y).toBeLessThan(-0.05);
    expect(model.position.y).toBeLessThan(0);
  });

  it("clamps travel so a tracking glitch cannot throw the character off screen", () => {
    run(driver, pose(), 0.3, 60);
    run(driver, pose({ shift: 0.9, t: 1 }), 1.0, 60);
    expect(Math.abs(driver.debug.root.x)).toBeLessThanOrEqual(
      RENDER_CONFIG.rootClamp + 1e-9
    );
  });

  it("recentres onto wherever the player now stands", () => {
    run(driver, pose(), 0.3, 60);
    run(driver, pose({ shift: 0.08, t: 1 }), 0.5, 60);
    expect(Math.abs(driver.debug.root.x)).toBeGreaterThan(0.05);

    driver.recentre();
    run(driver, pose({ shift: 0.08, t: 2 }), 0.5, 60);
    expect(Math.abs(driver.debug.root.x)).toBeLessThan(0.02);
  });

  it("returns the character home on reset", () => {
    run(driver, pose({ shift: 0.08 }), 0.5, 60);
    driver.reset();
    expect(model.position.length()).toBeLessThan(1e-9);
  });
});
