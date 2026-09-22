import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RigDriver } from "./rigDriver";
import { RENDER_CONFIG } from "../../config/tuning";
import type { Keypoint, PoseFrame } from "../../pose/poseTypes";
import type { StrikeEvent } from "../../perception/strikeResolver";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
} from "../../perception/strikeGeometry";
import { STRIKE_CONFIG } from "../../config/tuning";

// Covers the stateful half of retargeting: smoothing between pose samples,
// per-player limb calibration, and whole-body travel. Runs against the real
// exported rig, for the same reason mediapipeToMhrRig.test.ts does - a mocked
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
  // `pose()` foreshortens the player's left forearm, and these run mirrored -
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

describe("the player's feet", () => {
  // At a desk webcam the legs are essentially never in frame, so before this
  // the character slid sideways on straight, bind-pose legs to render a slip.
  // The fixture's pose deliberately carries no leg landmarks, which is exactly
  // the case these cover.
  const foot = (side: "l" | "r") =>
    model.getObjectByName(`${side}_foot`)!.getWorldPosition(new THREE.Vector3());
  const joint = (name: string) =>
    model.getObjectByName(name)!.getWorldPosition(new THREE.Vector3());

  it("stands in a staggered stance rather than with its feet together", () => {
    run(driver, pose(), 1.5, 60);
    model.updateMatrixWorld(true);
    const l = foot("l");
    const r = foot("r");
    expect(Math.abs(l.x - r.x)).toBeGreaterThan(0.1);
    // Staggered front-to-back. Feet side by side is a stance no boxer uses.
    expect(Math.abs(l.z - r.z)).toBeGreaterThan(0.1);
  });

  it("keeps both feet on the canvas at the same height", () => {
    run(driver, pose(), 1.5, 60);
    model.updateMatrixWorld(true);
    expect(foot("l").y).toBeCloseTo(foot("r").y, 2);
  });

  it("does not stretch the legs to reach the stance", () => {
    // The IK aims bones; it must never scale them. A leg that grew to reach its
    // foot would be the clearest possible sign the solve had gone wrong.
    run(driver, pose(), 1.5, 60);
    model.updateMatrixWorld(true);
    for (const side of ["l", "r"] as const) {
      const hip = joint(`${side}_upleg`);
      const knee = joint(`${side}_lowleg`);
      const ankle = joint(`${side}_foot`);
      expect(hip.distanceTo(knee), `${side} thigh`).toBeCloseTo(0.4198, 2);
      expect(knee.distanceTo(ankle), `${side} shin`).toBeCloseTo(0.4206, 2);
    }
  });

  it("bends the knees instead of standing on locked legs", () => {
    run(driver, pose(), 1.5, 60);
    model.updateMatrixWorld(true);
    for (const side of ["l", "r"] as const) {
      const hip = joint(`${side}_upleg`);
      const ankle = joint(`${side}_foot`);
      const straight = 0.4198 + 0.4206;
      // A bent leg spans less than the sum of its segments. Locked knees were
      // not merely ugly: with no slack the leg cannot reach out to a planted
      // foot at all, and the IK lifts the ankle off the canvas instead.
      expect(hip.distanceTo(ankle), `${side} leg locked straight`).toBeLessThan(
        straight - 0.01
      );
    }
  });

  it("leaves a planted foot behind when the body slips a little", () => {
    run(driver, pose(), 1.5, 60);
    model.updateMatrixWorld(true);
    const before = foot("l").clone();
    const startX = model.position.x;

    run(driver, pose({ shift: 0.03, t: 1 }), 0.4, 60);
    model.updateMatrixWorld(true);
    const bodyMoved = Math.abs(model.position.x - startX);
    expect(bodyMoved).toBeGreaterThan(0.005);
    // The body moved and the foot did not follow it one-for-one. That is the
    // whole difference between stepping and sliding.
    expect(foot("l").distanceTo(before)).toBeLessThan(bodyMoved);
  });

  it("steps the feet across once the player really moves", () => {
    run(driver, pose(), 1.5, 60);
    run(driver, pose({ shift: 0.12, t: 1 }), 2.5, 60);
    model.updateMatrixWorld(true);
    // The feet ended up under the body rather than stranded at the old mark.
    for (const side of ["l", "r"] as const) {
      expect(
        Math.abs(foot(side).x - model.position.x),
        `${side} foot stranded`
      ).toBeLessThan(0.35);
    }
  });

  it("yields to the camera when the legs ARE visible", () => {
    // The standing rule: a procedural guess never overrides a real
    // measurement. With leg landmarks present the retargeting owns the legs,
    // and the footwork must not write over its solve.
    const withLegs = (t: number): PoseFrame => ({
      ...pose({ t }),
      leftKnee: kp(0.57, 0.86),
      rightKnee: kp(0.43, 0.86),
      leftAnkle: kp(0.57, 0.97),
      rightAnkle: kp(0.43, 0.97),
    });
    run(driver, withLegs(0), 1.5, 60);
    model.updateMatrixWorld(true);
    const tracked = foot("l").clone();

    // Same driver, legs now out of frame: the procedural stance takes over and
    // puts the foot somewhere of its own choosing.
    run(driver, pose({ t: 2 }), 1.5, 60);
    model.updateMatrixWorld(true);
    expect(foot("l").distanceTo(tracked)).toBeGreaterThan(0.02);
  });
});

describe("the player flinches when hit", () => {
  // The opponent has had a bone-driven hit reaction since it existed. The
  // player had bruises and nothing else: a clean right hand landed on a
  // character that did not move. These cover the reaction and, just as
  // importantly, that it composes with tracking rather than replacing it.
  function punch(
    height: "head" | "body",
    lane: "left" | "centre" | "right",
    power = 1
  ): StrikeEvent {
    const impact = {
      lateral: lane === "right" ? 0.25 : lane === "left" ? -0.25 : 0,
      height: height === "head" ? 1.25 : 0.6,
    };
    const region = regionAt(impact);
    return {
      hand: "right",
      zone: coarseZone(impact),
      impact,
      region,
      approach: approachOf(0, 0, 3),
      damage: damageOf(region, power, approachOf(0, 0, 3)),
      contactReach: STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
      power,
      speed: 5,
      timestamp: 0,
    };
  }

  const headWorld = () =>
    model.getObjectByName("c_head")!.getWorldPosition(new THREE.Vector3());

  it("moves the head when a head shot lands", () => {
    run(driver, pose(), 1, 60);
    model.updateMatrixWorld(true);
    const before = headWorld();

    driver.flinch(punch("head", "centre"));
    run(driver, pose({ t: 1 }), 0.08, 60);
    model.updateMatrixWorld(true);
    expect(headWorld().distanceTo(before)).toBeGreaterThan(0.01);
  });

  it("recovers on its own rather than holding the pose", () => {
    run(driver, pose(), 1, 60);
    model.updateMatrixWorld(true);
    const rest = headWorld();

    driver.flinch(punch("head", "centre"));
    run(driver, pose({ t: 1 }), 0.08, 60);
    model.updateMatrixWorld(true);
    const snapped = headWorld().distanceTo(rest);

    run(driver, pose({ t: 2 }), 1.5, 60);
    model.updateMatrixWorld(true);
    const settled = headWorld().distanceTo(rest);
    expect(settled).toBeLessThan(snapped * 0.25);
  });

  it("throws the head to OPPOSITE sides for opposite lanes", () => {
    const snapFor = (lane: "left" | "right") => {
      model = source.clone(true);
      driver = new RigDriver(model);
      run(driver, pose(), 1, 60);
      model.updateMatrixWorld(true);
      const rest = headWorld().x;
      driver.flinch(punch("head", lane));
      run(driver, pose({ t: 1 }), 0.08, 60);
      model.updateMatrixWorld(true);
      return headWorld().x - rest;
    };
    const left = snapFor("left");
    const right = snapFor("right");
    expect(Math.sign(left)).toBe(-Math.sign(right));
  });

  it("does nothing at all until a punch actually lands", () => {
    run(driver, pose(), 1, 60);
    model.updateMatrixWorld(true);
    const a = headWorld();
    run(driver, pose({ t: 1 }), 0.5, 60);
    model.updateMatrixWorld(true);
    expect(headWorld().distanceTo(a)).toBeLessThan(1e-6);
  });

  it("still follows the player's tracked head while flinching", () => {
    // The composition rule. Overwriting the neck and head would drop the
    // player's real head position for the whole reaction - the character would
    // stop following them at exactly the moment they are most likely to move.
    run(driver, pose(), 1, 60);
    driver.flinch(punch("head", "centre"));
    run(driver, pose({ t: 1 }), 0.05, 60);
    model.updateMatrixWorld(true);
    const flinchingA = headWorld();

    // Same flinch, same instant, but the player has shifted. If the reaction
    // owned the head outright these two would be identical.
    model = source.clone(true);
    driver = new RigDriver(model);
    run(driver, pose(), 1, 60);
    driver.flinch(punch("head", "centre"));
    run(driver, pose({ shift: 0.08, t: 1 }), 0.05, 60);
    model.updateMatrixWorld(true);
    expect(headWorld().distanceTo(flinchingA)).toBeGreaterThan(1e-4);
  });

  it("sends a head shot to the neck and a body shot to the spine", () => {
    // Measured as rotation per bone, not as how far the head travels. A spine
    // fold swings the head further than a neck snap does purely because the
    // spine is a longer lever - so head displacement says almost nothing about
    // which reaction fired. What separates them is which joint actually moved.
    const rotationsFor = (height: "head" | "body") => {
      model = source.clone(true);
      driver = new RigDriver(model);
      run(driver, pose(), 1, 60);
      const rest = {
        neck: model.getObjectByName("c_neck")!.quaternion.clone(),
        spine: model.getObjectByName("c_spine2")!.quaternion.clone(),
      };
      driver.flinch(punch(height, "centre"));
      run(driver, pose({ t: 1 }), 0.08, 60);
      return {
        neck: rest.neck.angleTo(model.getObjectByName("c_neck")!.quaternion),
        spine: rest.spine.angleTo(model.getObjectByName("c_spine2")!.quaternion),
      };
    };

    const head = rotationsFor("head");
    const body = rotationsFor("body");
    expect(head.neck, "a head shot must snap the neck").toBeGreaterThan(body.neck);
    expect(body.spine, "a body shot must fold the spine").toBeGreaterThan(head.spine);
  });

  it("staggers more from a combination than from one punch", () => {
    const snap = (punches: number) => {
      model = source.clone(true);
      driver = new RigDriver(model);
      run(driver, pose(), 1, 60);
      model.updateMatrixWorld(true);
      const rest = headWorld();
      for (let i = 0; i < punches; i++) driver.flinch(punch("head", "centre", 0.4));
      run(driver, pose({ t: 1 }), 0.08, 60);
      model.updateMatrixWorld(true);
      return headWorld().distanceTo(rest);
    };
    expect(snap(2)).toBeGreaterThan(snap(1));
  });
});

describe("the rest pose", () => {
  // The rig's bind pose is a T-pose. Before the shared guard, an untracked
  // player's own fighter stood with its arms straight out sideways - which is
  // what everyone saw for the seconds before they stepped into frame, and
  // every time the camera lost them mid-round.
  const wristOf = (figure: THREE.Object3D, side: "l" | "r") => {
    figure.updateMatrixWorld(true);
    return figure
      .getObjectByName(`${side}_wrist`)!
      .getWorldPosition(new THREE.Vector3());
  };
  const wristWorld = (side: "l" | "r") => wristOf(model, side);
  const shoulderWorld = (side: "l" | "r") => {
    model.updateMatrixWorld(true);
    return model
      .getObjectByName(`${side}_uparm`)!
      .getWorldPosition(new THREE.Vector3());
  };
  /** The untouched asset, which is what "bind pose" actually means here. */
  const bindSpread = () => {
    const raw = source.clone(true);
    return Math.abs(wristOf(raw, "l").x - wristOf(raw, "r").x);
  };

  it("stands on guard rather than in the asset's T-pose", () => {
    const spread = Math.abs(wristWorld("l").x - wristWorld("r").x);
    // Hands come in from the armspan the asset ships with...
    expect(spread).toBeLessThan(bindSpread() * 0.4);
    // ...and UP, to somewhere around the shoulders rather than hanging at the
    // hips or held out level with them.
    for (const side of ["l", "r"] as const) {
      expect(wristWorld(side).y).toBeGreaterThan(shoulderWorld(side).y - 0.2);
    }
  });

  it("holds that guard while nobody is in frame", () => {
    const before = wristWorld("l").clone();
    for (let i = 0; i < 180; i++) driver.update(null, 1 / 60, false);
    // Three seconds of no tracking must not drift the figure anywhere. The
    // guard is a rest pose, not an animation playing to nobody.
    expect(wristWorld("l").distanceTo(before)).toBeLessThan(0.01);
  });

  it("hands the arm straight back to the camera when tracking returns", () => {
    for (let i = 0; i < 120; i++) driver.update(null, 1 / 60, false);
    const parked = wristWorld("l").clone();
    for (let i = 0; i < 120; i++) driver.update(pose({ t: i * 66 }), 1 / 60, false);
    // The guard must not be sticky: an arm the camera can see is driven by the
    // camera, and a rest pose that fought the tracked one would blunt every
    // punch thrown in the first second after a dropout.
    expect(wristWorld("l").distanceTo(parked)).toBeGreaterThan(0.05);
  });

  it("is on guard from the very first frame, with nothing to ease out of", () => {
    // Same contract every other pose path here holds to: no bone may cross the
    // screen in one frame. OpponentAnimator's constructor already poses on
    // guard for exactly this reason - the figure is on screen at the moment it
    // is constructed, and "it settles within three frames" is three frames of
    // a man in a T-pose.
    let last = wristWorld("l").clone();
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      driver.update(null, 1 / 60, false);
      const now = wristWorld("l");
      worst = Math.max(worst, now.distanceTo(last));
      last = now.clone();
    }
    expect(worst).toBeLessThan(0.005);
  });
});

describe("the player going down", () => {
  // Until this existed a clean right hand put the player on the canvas, the
  // simulation started a count and resumed the round - and the character on
  // screen boxed on throughout, mirroring a player who was, quite correctly,
  // still standing in their own room.
  const head = () => {
    model.updateMatrixWorld(true);
    return model.getObjectByName("c_head")!.getWorldPosition(new THREE.Vector3());
  };
  const footY = (side: "l" | "r") => {
    model.updateMatrixWorld(true);
    return model.getObjectByName(`${side}_foot`)!.getWorldPosition(new THREE.Vector3()).y;
  };
  const step = (seconds: number, live = false) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      driver.update(live ? pose({ t: t * 1000 }) : null, 1 / 60, false);
    }
  };

  it("puts the player on the canvas", () => {
    step(0.5);
    const standing = head().y;
    driver.setCondition(1, 1);
    step(1.5);
    expect(head().y).toBeLessThan(standing * 0.6);
  });

  it("goes over BACKWARDS, away from the fighter who hit them", () => {
    // The player's figure faces +Z with the opponent in front of it, so being
    // dropped by a punch to the face carries the head toward -Z. The opposite
    // sign from the opponent's own fall, because they face each other - which
    // is exactly the class of thing a sign-only test would pass while getting
    // backwards, so this measures where the head actually ends up.
    step(0.5);
    const standing = head().z;
    driver.setCondition(1, 1);
    step(1.5);
    expect(head().z).toBeLessThan(standing - 0.2);
  });

  it("keeps the player's feet on the canvas on the way down", () => {
    const ground = (footY("l") + footY("r")) / 2;
    driver.setCondition(1, 1);
    let worst = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      driver.update(null, 1 / 60, false);
      worst = Math.max(worst, footY("l") - ground, footY("r") - ground);
    }
    expect(worst).toBeLessThan(0.12);
  });

  it("ignores the camera's arms while they are down", () => {
    // The player is still standing in their room with their hands up. Copying
    // that onto a figure that has just been dropped is the single most
    // obviously wrong thing the character could do.
    step(1, true);
    const boxing = model.getObjectByName("l_wrist")!.getWorldPosition(new THREE.Vector3());
    driver.setCondition(1, 1);
    step(1.5, true);
    model.updateMatrixWorld(true);
    const down = model.getObjectByName("l_wrist")!.getWorldPosition(new THREE.Vector3());
    expect(down.y).toBeLessThan(boxing.y - 0.15);
  });

  it("gets up more slowly than it went down", () => {
    driver.setCondition(1, 1);
    let fall = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      driver.update(null, 1 / 60, false);
      if (driver.downAmount < 0.999) fall = t;
    }
    driver.setCondition(0, 0);
    let rise = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      driver.update(null, 1 / 60, false);
      if (driver.downAmount > 0.001) rise = t;
    }
    expect(rise).toBeGreaterThan(fall * 1.8);
  });

  it("stands back up where it fell", () => {
    step(0.5);
    const before = head().clone();
    driver.setCondition(1, 1);
    step(1.5);
    driver.setCondition(0, 0);
    step(3);
    expect(head().distanceTo(before)).toBeLessThan(0.05);
  });

  it("falls no faster than gravity would drop it", () => {
    // The right ceiling for a fall is not a taste judgement, it is g. A body
    // pitching over about its own feet cannot beat a free fall from the same
    // height. Derived from the rig's standing head height rather than typed.
    step(0.5);
    const terminal = Math.sqrt(2 * 9.81 * head().y) / 60;
    driver.setCondition(1, 1);
    let last = head().clone();
    let worst = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      driver.update(null, 1 / 60, false);
      const now = head();
      worst = Math.max(worst, now.distanceTo(last));
      last = now.clone();
    }
    expect(
      worst,
      `${(worst * 60).toFixed(2)} m/s against a ceiling of ${(terminal * 60).toFixed(2)}`
    ).toBeLessThan(terminal);
  });

  it("sways when hurt and stands still when it is not", () => {
    const spread = () => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t < 2; t += 1 / 60) {
        driver.update(null, 1 / 60, false);
        const x = head().x;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      return hi - lo;
    };
    driver.setCondition(0, 1);
    step(1.5);
    const hurt = spread();
    driver.setCondition(0, 0);
    step(2);
    const fresh = spread();
    expect(hurt).toBeGreaterThan(0.02);
    expect(hurt).toBeGreaterThan(fresh * 4);
  });
});
