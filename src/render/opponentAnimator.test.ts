import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { OpponentAnimator, type OpponentVisualState } from "./opponentAnimator";
import { TrainingTarget } from "./TrainingTarget";
import { OPPONENT_ANIM } from "../config/tuning";
import type { CpuStance } from "../sim/cpuOpponent";

// Asserted against the real exported asset, not a mock.
//
// Everything in this file that matters is a frame conversion, and a mock rig
// would have whatever frame the mock's author assumed - which is the same
// assumption the code under test is making, so the two would agree while both
// being wrong. The only thing that settles it is the shipped mesh.
//
// And the assertions are about where the body ends up in world space, never
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

const stance = (over: Partial<CpuStance> = {}): CpuStance => ({
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
  down: 0,
  hurt: 0,
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
    // Asserted loosely: the point is that it was measured, not that it is a
    // particular number, and pinning it exactly would break on a re-export
    // that this code is supposed to survive.
    expect(anim.torsoScale).toBeGreaterThan(0.3);
    expect(anim.torsoScale).toBeLessThan(0.7);
  });
});

describe("footwork, in world space", () => {
  it("steps TOWARD the player when depth rises", () => {
    // The player's boxer stands at the origin facing +Z and the opponent is
    // out at +Z, so closing the distance means the opponent's z must fall.
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
    // legs dead straight, which reads as levitating. Checked at the foot,
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

    // A slip to the CPU's own right. Its own right is -X in its own frame, and
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

    // That is what a slip is: the body stays and the head leaves the line.
    expect(Math.abs(headAfter - headBefore)).toBeGreaterThan(
      Math.abs(footAfter - footBefore) * 3
    );
  });
});

describe("the arms", () => {
  /** How far out in front of the chest a glove is, along the punch axis. */
  function reach(hand: "left" | "right"): number {
    scene.updateMatrixWorld(true);
    // The opponent faces -Z, so a punch travels toward smaller z. Measured
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
      // Deliberately adversarial: the wind-up is stepped from 0 to 1 halfway
      // through the punch's recovery, which the CPU would never do. The point
      // is that the guarantee should not depend on the input being polite -
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
      // The figure faces the player, at smaller z - so "in front" is a
      // smaller z than the head.
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
    // Before this, every punch left along the same rail whatever the CPU had
    // aimed at, so a dig to the liver and a shot at the chin were the same
    // animation - the only way to tell them apart was to read the damage feed.
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

  function peakAt(hand: "left" | "right", height: number, lateral: number) {
    anim.reset();
    run(visual(), 0.3);
    anim.throw(hand, height, lateral);
    run(visual(), OPPONENT_ANIM.punchSeconds * OPPONENT_ANIM.punchOutShare);
    return anim.handWorld(hand).clone();
  }

  it("throws to the SIDE it was aimed at, not just the height", () => {
    // The CPU has always picked a named target and every one of them carries a
    // lateral offset - liver at -0.26, temple at +0.28. Only the height was
    // animated, so opposite corners of the body were the same punch.
    const liver = peakAt("right", 0.56, -0.26);
    const ribs = peakAt("right", 0.62, 0.28);
    expect(Math.abs(ribs.x - liver.x)).toBeGreaterThan(0.05);
  });

  it("sends BOTH hands to the same side for the same target", () => {
    // The mirror bug this pins: the lateral aim folded in before the left/right
    // mirror gets negated for one hand, so the two gloves converge on opposite
    // cheeks for one aim point. Asserted in world space, where "the same side"
    // is a fact rather than a sign convention.
    const temple = 0.28;
    const left = peakAt("left", 1.44, temple);
    const right = peakAt("right", 1.44, temple);
    const centreLeft = peakAt("left", 1.44, 0);
    const centreRight = peakAt("right", 1.44, 0);
    expect(Math.sign(left.x - centreLeft.x)).toBe(
      Math.sign(right.x - centreRight.x)
    );
  });

  it("leaves a centred punch on the centre line", () => {
    const chin = peakAt("right", 1.21, 0);
    const plain = peak("right", 1.21);
    expect(chin.x).toBeCloseTo(plain.x, 6);
  });
});

describe("sharing the figure with the hit reaction", () => {
  it("footwork and knockback compose instead of overwriting each other", () => {
    // TrainingTarget rewrites `figure.position` every frame from its own home;
    // the animator moves the pivot. If either reached for the other's
    // transform, one of the two would silently stop working - and the one that
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
    // Normalised before comparing. The exported asset's rotations are a hair
    // short of unit length, and `angleTo` on a slightly-short quaternion
    // reports ~7.5e-4 radians against its own exact copy - acos amplifies a
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

describe("the feet are on the canvas, not gliding above it", () => {
  // The fault this whole section exists to pin: the opponent used to travel by
  // translating its body with its legs held at bind pose, so it slid around the
  // ring like a chess piece. These assert on where the ankles end up in world
  // space, which is the only thing that settles whether a figure is walking or
  // being dragged.

  it("leaves a planted foot where it was while the body moves off it", () => {
    // Settle into the stance first. The figure starts from the rig's bind pose
    // and steps into its stance over the first half-second, which is real
    // motion and would otherwise be measured as drift.
    run(visual(), 1.2);
    const before = anim.footWorld("left").clone();
    // A drift smaller than the step trigger: the body moves, the foot must not.
    run(visual({ stance: stance({ lateral: 0.12 }) }), 0.35);
    const after = anim.footWorld("left");
    const headMoved = Math.abs(anim.headWorld().x);
    expect(headMoved).toBeGreaterThan(0.02);
    expect(after.distanceTo(before)).toBeLessThan(headMoved * 0.35);
  });

  it("steps the feet across when the body really travels", () => {
    run(visual({ stance: stance({ lateral: 1.1 }) }), 2.5);
    // Both feet have followed the body over rather than being left behind at
    // the mark. Measured against the body's own ground position so this does
    // not encode the stance width.
    const body = anim.pivot.position.x;
    for (const side of ["left", "right"] as const) {
      const foot = anim.footWorld(side);
      expect(Math.abs(foot.x - body), `${side} foot did not follow`).toBeLessThan(
        anim.torsoScale
      );
    }
  });

  it("lifts a foot off the canvas mid-step and puts it back down", () => {
    run(visual(), 1.2);
    const resting = anim.footWorld("left").y;
    let peak = -Infinity;
    let lifted = false;
    for (let t = 0; t < 2.5; t += 1 / 60) {
      anim.update(1 / 60, visual({ stance: stance({ lateral: t * 0.5 }) }));
      scene.updateMatrixWorld(true);
      for (const side of ["left", "right"] as const) {
        const y = anim.footWorld(side).y;
        peak = Math.max(peak, y);
        if (y > resting + 0.005) lifted = true;
      }
    }
    expect(lifted, "no foot ever left the canvas").toBe(true);
    // And it is a boxer's shuffle, not a march. A step that lifts the foot half
    // a torso off the floor reads as walking around the ring.
    expect(peak - resting).toBeLessThan(anim.torsoScale * 0.25);
  });

  it("never has both feet off the canvas at once", () => {
    run(visual(), 1.2);
    const resting = anim.footWorld("left").y;
    let bothOff = false;
    for (let t = 0; t < 3; t += 1 / 60) {
      anim.update(1 / 60, visual({ stance: stance({ lateral: Math.sin(t * 3) * 1.2 }) }));
      scene.updateMatrixWorld(true);
      const l = anim.footWorld("left").y - resting;
      const r = anim.footWorld("right").y - resting;
      if (l > 0.004 && r > 0.004) bothOff = true;
    }
    expect(bothOff).toBe(false);
  });

  it("keeps the feet at a sane height rather than drifting through the floor", () => {
    run(visual(), 1.2);
    const resting = anim.footWorld("left").y;
    for (let t = 0; t < 4; t += 1 / 60) {
      anim.update(
        1 / 60,
        visual({ stance: stance({ lateral: Math.sin(t * 2) * 0.9, depth: Math.cos(t) * 0.5 }) })
      );
    }
    scene.updateMatrixWorld(true);
    for (const side of ["left", "right"] as const) {
      const y = anim.footWorld(side).y;
      expect(Math.abs(y - resting), `${side} foot drifted`).toBeLessThan(0.05);
    }
  });

  it("stands in a stance, with the feet apart and one of them forward", () => {
    run(visual(), 0.5);
    const l = anim.footWorld("left");
    const r = anim.footWorld("right");
    // Apart laterally - a fighter with its ankles together is standing to
    // attention, and the sign bug this pins put both feet on one side.
    expect(Math.abs(l.x - r.x)).toBeGreaterThan(anim.torsoScale * 0.3);
    // And staggered, which is what makes it a stance rather than a stand.
    expect(Math.abs(l.z - r.z)).toBeGreaterThan(anim.torsoScale * 0.2);
  });
});

describe("the knees do the work", () => {
  it("bends the knee forward of the hip-to-ankle line, never backward", () => {
    // A knee that solves to the wrong side of that line is the classic two-bone
    // IK failure and renders as a leg bending backwards at the joint.
    run(visual({ stance: stance({ crouch: 0.8 }) }), 1);
    const forward = new THREE.Vector3();
    figure.getWorldQuaternion(new THREE.Quaternion());
    forward.set(0, 0, 1).applyQuaternion(figure.getWorldQuaternion(new THREE.Quaternion()));

    for (const side of ["l", "r"] as const) {
      const hip = figure.getObjectByName(`${side}_upleg`)!.getWorldPosition(new THREE.Vector3());
      const knee = figure.getObjectByName(`${side}_lowleg`)!.getWorldPosition(new THREE.Vector3());
      const ankle = figure.getObjectByName(`${side}_foot`)!.getWorldPosition(new THREE.Vector3());

      // Knee's offset from the straight hip->ankle line.
      const axis = ankle.clone().sub(hip);
      const len = axis.length();
      const along = knee.clone().sub(hip).dot(axis) / (len * len);
      const onLine = hip.clone().addScaledVector(axis, along);
      const offset = knee.clone().sub(onLine);
      expect(offset.dot(forward), `${side} knee bent backwards`).toBeGreaterThan(0);
    }
  });

  it("keeps the ankle under the body while the hips drop into a duck", () => {
    run(visual(), 1.2);
    const before = anim.footWorld("left").clone();
    const headBefore = anim.headWorld().y;
    run(visual({ stance: stance({ crouch: 1 }) }), 1);
    const headAfter = anim.headWorld().y;

    // The head really came down...
    expect(headBefore - headAfter).toBeGreaterThan(0.1);
    // ...and the foot did not follow it. This is the difference between ducking
    // and sinking through the canvas.
    expect(anim.footWorld("left").distanceTo(before)).toBeLessThan(0.03);
  });
});

describe("knockdowns and being hurt, in world space", () => {
  // A knockdown used to produce a line in the feed and nothing else. The
  // simulation stopped the fighter, started a count and resumed the round
  // while the figure carried on boxing throughout - which reads as the hit
  // detection having failed rather than as a knockdown.
  const headY = () => anim.headWorld().y;
  const footY = (side: "l" | "r") => {
    scene.updateMatrixWorld(true);
    return figure.getObjectByName(`${side}_foot`)!.getWorldPosition(new THREE.Vector3()).y;
  };

  it("puts the fighter on the canvas", () => {
    run(visual(), 0.5);
    const standing = headY();
    run(visual({ down: 1, hurt: 1 }), 1.2);
    // The head ends up far lower than it stands, which is the only description
    // of "down" that does not depend on a sign convention.
    expect(headY()).toBeLessThan(standing * 0.6);
  });

  it("goes over the BACK, away from the fighter who hit them", () => {
    // The opponent stands out at +Z with the player at the origin, so going
    // down from a punch to the face means travelling further along +Z.
    run(visual(), 0.5);
    const standing = anim.headWorld().z;
    run(visual({ down: 1, hurt: 1 }), 1.2);
    expect(anim.headWorld().z).toBeGreaterThan(standing + 0.2);
  });

  it("keeps its feet on the canvas on the way down", () => {
    // The hips swing back and down through most of a right angle during a
    // fall. A foot left planted where the fighter was standing ends up further
    // from the hip than the leg is long, and the IK straightens and hauls the
    // ankle into the air - the "fighter on tiptoe" failure the standing bend
    // was added to prevent, arriving by another route.
    const ground = (footY("l") + footY("r")) / 2;
    let worst = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      anim.update(1 / 60, visual({ down: 1, hurt: 1 }));
      scene.updateMatrixWorld(true);
      worst = Math.max(worst, footY("l") - ground, footY("r") - ground);
    }
    expect(worst).toBeLessThan(0.12);
  });

  it("gets up more slowly than it went down", () => {
    // The whole difference between being knocked down and lying down.
    let fall = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      anim.update(1 / 60, visual({ down: 1, hurt: 1 }));
      if (anim.downAmount < 0.999) fall = t;
    }
    let rise = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      anim.update(1 / 60, visual());
      if (anim.downAmount > 0.001) rise = t;
    }
    expect(rise).toBeGreaterThan(fall * 1.8);
  });

  it("stands back up where it fell, not somewhere else", () => {
    run(visual(), 0.5);
    const before = anim.headWorld().clone();
    run(visual({ down: 1, hurt: 1 }), 1.5);
    run(visual(), 3);
    expect(anim.headWorld().distanceTo(before)).toBeLessThan(0.05);
  });

  it("sways when hurt and stands still when it is not", () => {
    const spread = (s: OpponentVisualState) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t < 2; t += 1 / 60) {
        anim.update(1 / 60, s);
        const x = anim.headWorld().x;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      return hi - lo;
    };
    // Settle first, so what is measured is the sway and not the approach.
    run(visual({ hurt: 1 }), 1.5);
    const hurt = spread(visual({ hurt: 1 }));
    run(visual(), 2);
    const fresh = spread(visual());
    expect(hurt).toBeGreaterThan(0.02);
    expect(hurt).toBeGreaterThan(fresh * 4);
  });

  it("falls no faster than gravity would drop it", () => {
    // The right ceiling for a fall is not a taste judgement, it is g. A body
    // pitching over about its own feet cannot beat a free fall from the same
    // height, so anything above that bound is the animation driving the figure
    // into the canvas rather than letting it drop - which is what a snap is.
    //
    // Derived from the rig's own standing head height rather than typed, so a
    // re-export at a different scale keeps the bound instead of quietly
    // invalidating it. This caught a fallSeconds of 0.38, which swung the head
    // at 6.5 m/s against a free-fall ceiling of 5.2.
    run(visual(), 0.5);
    const standing = anim.headWorld().y;
    const terminal = Math.sqrt(2 * 9.81 * standing) / 60;

    let last = anim.headWorld().clone();
    let worst = 0;
    for (let t = 0; t < 1.5; t += 1 / 60) {
      anim.update(1 / 60, visual({ down: 1, hurt: 1 }));
      const now = anim.headWorld();
      worst = Math.max(worst, now.distanceTo(last));
      last = now.clone();
    }
    expect(
      worst,
      `${(worst * 60).toFixed(2)} m/s against a free-fall ceiling of ${(terminal * 60).toFixed(2)}`
    ).toBeLessThan(terminal);
  });
});
