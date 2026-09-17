import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { OpponentAnimator, type OpponentVisualState } from "./opponentAnimator";
import { TrainingTarget } from "./TrainingTarget";
import { OPPONENT_ANIM } from "../config/tuning";
import type { AiStance } from "../sim/aiOpponent";

// Asserted against the REAL exported asset, not a mock.
//
// Everything in this file that matters is a frame conversion, and a mock rig
// would have whatever frame the mock's author assumed — which is the same
// assumption the code under test is making, so the two would agree while both
// being wrong. The only thing that settles it is the shipped mesh.
//
// And the assertions are about where the BODY ends up in world space, never
// about the sign of a field. A sign test passes for code that negates twice.

const MODEL_PATH = "public/models/boxer_lod3.glb";
let source: THREE.Object3D;

beforeAll(async () => {
  const buf = readFileSync(MODEL_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  source = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => resolve(g.scene), reject);
  });
}, 60_000);

let figure: THREE.Object3D;
let anim: OpponentAnimator;
let scene: THREE.Scene;

const stance = (over: Partial<AiStance> = {}): AiStance => ({
  lateral: 0,
  depth: 0,
  crouch: 0,
  lean: 0,
  ...over,
});

const visual = (over: Partial<OpponentVisualState> = {}): OpponentVisualState => ({
  stance: stance(),
  guard: "high",
  evasion: "none",
  windup: 0,
  ...over,
});

beforeEach(() => {
  scene = new THREE.Scene();
  figure = cloneSkinned(source);
  anim = new OpponentAnimator(figure);
  // Placed exactly as the scene does it: turned to face the player's boxer,
  // which faces +Z, and standing some way out in front.
  figure.rotation.y = Math.PI;
  figure.position.set(0, 0, 1.15);
  anim.pivot.add(figure);
  scene.add(anim.pivot);
  scene.updateMatrixWorld(true);
});

/** Runs the animator for `seconds` at 60 Hz. */
function run(s: OpponentVisualState, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) anim.update(1 / 60, s);
  scene.updateMatrixWorld(true);
}

describe("scale", () => {
  it("measures the torso off the rig rather than assuming one", () => {
    // Shoulder ~1.419 and hip ~0.944 in the shipped asset, so about 0.475.
    // Asserted loosely: the point is that it was MEASURED, not that it is a
    // particular number, and pinning it exactly would break on a re-export
    // that this code is supposed to survive.
    expect(anim.torsoScale).toBeGreaterThan(0.3);
    expect(anim.torsoScale).toBeLessThan(0.7);
  });
});

describe("footwork, in world space", () => {
  it("steps TOWARD the player when depth rises", () => {
    // The player's boxer stands at the origin facing +Z and the opponent is
    // out at +Z, so closing the distance means the opponent's z must FALL.
    const before = anim.headWorld().z;
    run(visual({ stance: stance({ depth: 0.6 }) }), 1);
    expect(anim.headWorld().z).toBeLessThan(before - 0.05);
  });

  it("steps away when depth goes negative", () => {
    const before = anim.headWorld().z;
    run(visual({ stance: stance({ depth: -0.6 }) }), 1);
    expect(anim.headWorld().z).toBeGreaterThan(before + 0.05);
  });

  it("circles to its own right and its own left, and they are opposite", () => {
    const home = anim.headWorld().x;
    run(visual({ stance: stance({ lateral: 0.6 }) }), 1);
    const right = anim.headWorld().x;

    anim.reset();
    scene.updateMatrixWorld(true);
    run(visual({ stance: stance({ lateral: -0.6 }) }), 1);
    const left = anim.headWorld().x;

    expect(right).not.toBeCloseTo(home, 2);
    expect(Math.sign(right - home)).toBe(-Math.sign(left - home));
    // Symmetric about home: an asymmetry would mean one direction is picking
    // up a stray term.
    expect(right - home).toBeCloseTo(-(left - home), 6);
  });

  it("converts torso units into world units at the measured scale", () => {
    run(visual({ stance: stance({ lateral: 1 }) }), 1);
    expect(Math.abs(anim.pivot.position.x)).toBeCloseTo(anim.torsoScale, 6);
  });

  it("drops the head when crouching", () => {
    const before = anim.headWorld().y;
    run(visual({ stance: stance({ crouch: 1 }) }), 1);
    const after = anim.headWorld().y;
    expect(after).toBeLessThan(before);
    // A real duck, not a twitch: enough to take the head off the line of a
    // punch aimed where it was standing.
    expect(before - after).toBeGreaterThan(0.1);
  });

  it("bends the knees to duck instead of sinking through the canvas", () => {
    // The fault this replaced: the whole body translated downward with the
    // legs dead straight, which reads as levitating. Checked at the FOOT,
    // because a body that really bends leaves its feet where they were.
    const foot = figure.getObjectByName("l_foot")!;
    const before = foot.getWorldPosition(new THREE.Vector3()).y;
    const head = anim.headWorld().y;

    run(visual({ stance: stance({ crouch: 1 }), evasion: "duck" }), 1);

    expect(head - anim.headWorld().y).toBeGreaterThan(0.2);
    expect(
      Math.abs(foot.getWorldPosition(new THREE.Vector3()).y - before)
    ).toBeLessThan(0.05);
  });
});

describe("the slip", () => {
  it("leans the head the SAME way the stance says, not the opposite way", () => {
    // The one that a sign error would sail through unnoticed on screen: the
    // figure leans convincingly, into the punch. Checked by where the head
    // goes, with the feet held still, so the lean is isolated from the travel.
    const home = anim.headWorld().x;
    run(visual({ stance: stance({ lean: 0.35 }) }), 0.6);
    const leaned = anim.headWorld().x;

    // A slip to the AI's own right. Its own right is -X in its own frame, and
    // it is turned to face the player, so that is the world's +X.
    expect(leaned).toBeGreaterThan(home);
  });

  it("moves the head while leaving the feet where they are", () => {
    const foot = figure.getObjectByName("l_foot")!;
    const footBefore = foot.getWorldPosition(new THREE.Vector3()).x;
    const headBefore = anim.headWorld().x;

    run(visual({ stance: stance({ lean: 0.4 }) }), 0.6);

    const footAfter = foot.getWorldPosition(new THREE.Vector3()).x;
    const headAfter = anim.headWorld().x;

    // That is what a slip IS: the body stays and the head leaves the line.
    expect(Math.abs(headAfter - headBefore)).toBeGreaterThan(
      Math.abs(footAfter - footBefore) * 3
    );
  });
});

describe("the arms", () => {
  /** How far out in front of the chest a glove is, along the punch axis. */
  function reach(hand: "left" | "right"): number {
    scene.updateMatrixWorld(true);
    // The opponent faces -Z, so a punch travels toward SMALLER z. Measured
    // against the head rather than the world origin so footwork cannot be
    // mistaken for extension.
    return anim.headWorld().z - anim.handWorld(hand).z;
  }

  it("draws the arm BACK during a telegraph", () => {
    run(visual(), 0.4);
    const onGuard = reach("right");
    run(visual({ windup: 1 }), 0.4);
    expect(reach("right")).toBeLessThan(onGuard);
  });

  it("puts the glove out in front when a punch is thrown", () => {
    run(visual(), 0.3);
    const onGuard = reach("right");
    anim.throw("right");
    // Sampled at the peak of the out-stroke rather than at the end, which is
    // back on guard by design.
    run(visual(), OPPONENT_ANIM.punchSeconds * OPPONENT_ANIM.punchOutShare);
    expect(reach("right")).toBeGreaterThan(onGuard + 0.1);
  });

  it("brings the arm back on its own", () => {
    run(visual(), 0.3);
    const onGuard = reach("right");
    anim.throw("right");
    run(visual(), OPPONENT_ANIM.punchSeconds + 0.4);
    expect(reach("right")).toBeCloseTo(onGuard, 1);
  });

  it("throws with the hand it was told to", () => {
    run(visual(), 0.3);
    const before = { left: reach("left"), right: reach("right") };
    anim.throw("left");
    run(visual(), OPPONENT_ANIM.punchSeconds * OPPONENT_ANIM.punchOutShare);
    expect(reach("left")).toBeGreaterThan(before.left + 0.1);
    expect(reach("right")).toBeCloseTo(before.right, 1);
  });

  it("mirrors the two arms rather than posing one of them inside out", () => {
    // The mirrored-handedness bug this project has already hit twice: the
    // cross product's sign differs per side, so a pose applied identically to
    // both arms turns one of them through the body.
    run(visual(), 0.4);
    const l = anim.handWorld("left");
    const r = anim.handWorld("right");
    // Both gloves up in front of the chest, one either side of the midline.
    expect(Math.sign(l.x)).toBe(-Math.sign(r.x));
    // Tight. A loose tolerance here is how an arm that is subtly wrong on one
    // side passes: at 0.05 the two gloves can sit half a fist apart and still
    // agree.
    expect(Math.abs(l.x)).toBeCloseTo(Math.abs(r.x), 3);
    expect(l.y).toBeCloseTo(r.y, 3);
    expect(l.z).toBeCloseTo(r.z, 3);
  });

  it("drops the hands when the guard drops", () => {
    run(visual({ guard: "high" }), 0.5);
    const high = anim.handWorld("right").y;
    run(visual({ guard: "none" }), 0.5);
    expect(anim.handWorld("right").y).toBeLessThan(high - 0.05);
  });

  it("covers the body on a low guard, between the high guard and no guard", () => {
    run(visual({ guard: "high" }), 0.5);
    const high = anim.handWorld("right").y;
    run(visual({ guard: "none" }), 0.5);
    const none = anim.handWorld("right").y;
    anim.reset();
    run(visual({ guard: "low" }), 0.5);
    const low = anim.handWorld("right").y;
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThan(none);
  });

  it("never snaps the arm across a frame", () => {
    // The arms are chased rather than set, so a dropped frame cannot teleport
    // a glove through the player's head.
    let previous = anim.handWorld("right").clone();
    let worst = 0;
    anim.throw("right");
    for (let i = 0; i < 120; i++) {
      // Deliberately adversarial: the wind-up is STEPPED from 0 to 1 halfway
      // through the punch's recovery, which the AI would never do. The point
      // is that the guarantee should not depend on the input being polite —
      // a dropped frame or a state change on a slow frame produces exactly
      // this, and a glove that teleports goes through the player's head.
      anim.update(1 / 60, visual({ windup: i > 60 ? 1 : 0 }));
      scene.updateMatrixWorld(true);
      const now = anim.handWorld("right").clone();
      worst = Math.max(worst, now.distanceTo(previous));
      previous = now;
    }
    expect(worst).toBeLessThan(0.12);
  });
});

describe("the guard actually guards", () => {
  it("holds the gloves in FRONT of the head, not out beside it", () => {
    // The fault the screenshots showed: the upper arm hung dead vertical with
    // the elbow flared out and the forearm folded back onto it, which put the
    // gloves at the sides of the head like a shrug. A guard covers the face.
    run(visual({ guard: "high" }), 0.6);
    const head = anim.headWorld();
    for (const hand of ["left", "right"] as const) {
      const glove = anim.handWorld(hand);
      // The figure faces the player, at smaller z — so "in front" is a
      // SMALLER z than the head.
      expect(glove.z).toBeLessThan(head.z);
      // And roughly at head height, not down at the waist.
      expect(Math.abs(glove.y - head.y)).toBeLessThan(0.35);
    }
  });

  it("keeps the elbows in, not winged out past the shoulders", () => {
    run(visual({ guard: "high" }), 0.6);
    const shoulder = figure.getObjectByName("l_uparm")!
      .getWorldPosition(new THREE.Vector3());
    const elbow = figure.getObjectByName("l_lowarm")!
      .getWorldPosition(new THREE.Vector3());
    // The elbow hangs below its own shoulder and no further out sideways.
    expect(elbow.y).toBeLessThan(shoulder.y);
    expect(Math.abs(elbow.x)).toBeLessThanOrEqual(Math.abs(shoulder.x) + 0.06);
  });
});

describe("punches go where they were aimed", () => {
  function peak(hand: "left" | "right", height: number) {
    anim.reset();
    run(visual(), 0.3);
    anim.throw(hand, height);
    run(visual(), OPPONENT_ANIM.punchSeconds * OPPONENT_ANIM.punchOutShare);
    return anim.handWorld(hand).clone();
  }

  it("throws a head shot higher than a body shot", () => {
    // Before this, every punch left along the same rail whatever the AI had
    // aimed at, so a dig to the liver and a shot at the chin were the same
    // animation — the only way to tell them apart was to read the damage feed.
    const chin = peak("right", 1.24);
    const liver = peak("right", 0.56);
    expect(chin.y).toBeGreaterThan(liver.y + 0.1);
  });

  it("still puts both out in front, whatever the height", () => {
    const head = anim.headWorld().z;
    for (const h of [1.44, 1.21, 0.6]) {
      expect(peak("left", h).z).toBeLessThan(head);
    }
  });
});

describe("sharing the figure with the hit reaction", () => {
  it("footwork and knockback compose instead of overwriting each other", () => {
    // TrainingTarget rewrites `figure.position` every frame from its own home;
    // the animator moves the PIVOT. If either reached for the other's
    // transform, one of the two would silently stop working — and the one that
    // stopped would be whichever ran first.
    const target = new TrainingTarget(figure);
    target.setHome(new THREE.Vector3(0, 0, 1.15));

    run(visual({ stance: stance({ depth: 0.5 }) }), 1);
    const stepped = anim.pivot.position.z;
    expect(stepped).toBeLessThan(-0.05);

    target.update(1 / 60);
    scene.updateMatrixWorld(true);

    // The step survived the reaction's own write to figure.position.
    expect(anim.pivot.position.z).toBe(stepped);
    expect(figure.position.z).toBeCloseTo(1.15, 6);
  });

  it("leaves the reaction's own bones alone", () => {
    // The strict split: this animator owns the arms and nothing else. A change
    // that started posing the spine here would fight the head snap every time
    // the opponent was hit.
    // NORMALISED before comparing. The exported asset's rotations are a hair
    // short of unit length, and `angleTo` on a slightly-short quaternion
    // reports ~7.5e-4 radians AGAINST ITS OWN EXACT COPY — acos amplifies a
    // 1e-8 dot deficit. Without this the test reports a bone as having moved
    // when nothing has touched it, which is a false alarm that looks exactly
    // like the real bug it is watching for. (See the same note in
    // mediapipeToMhrRig.captureBindPose, which normalises for this reason.)
    const before = new Map<string, THREE.Quaternion>();
    for (const name of ["c_neck", "c_head", "c_spine2", "c_jaw"]) {
      const bone = figure.getObjectByName(name);
      if (bone) before.set(name, bone.quaternion.clone().normalize());
    }
    expect(before.size).toBe(4);

    anim.throw("right");
    run(visual({ stance: stance({ lateral: 0.5, crouch: 1 }), windup: 1 }), 1);

    for (const [name, q] of before) {
      const bone = figure.getObjectByName(name)!;
      const now = bone.quaternion.clone().normalize();
      expect(now.angleTo(q)).toBeLessThan(1e-6);
    }
  });
});
