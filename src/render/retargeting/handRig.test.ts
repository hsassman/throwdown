import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { applyClench, captureHandBind } from "./handRig";
import { FINGER_CHAINS, HAND_SHAPE } from "./rigJointMap";

// Against the REAL exported asset, for the same reason the rest of the
// retargeting tests are: the curl axes are DERIVED from the bind pose, so a
// mocked hand would only confirm the derivation against itself.

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
beforeEach(() => {
  model = cloneSkinned(source);
});

function tipDistanceToWrist(root: THREE.Object3D, side: "l" | "r", finger: string) {
  root.updateMatrixWorld(true);
  const wrist = root.getObjectByName(`${side}_wrist`)!;
  const tip = root.getObjectByName(`${side}_${finger}_null`)!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  wrist.getWorldPosition(a);
  tip.getWorldPosition(b);
  return a.distanceTo(b);
}

/** World position of a named node. */
function W(root: THREE.Object3D, name: string): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  root.getObjectByName(name)!.getWorldPosition(v);
  return v;
}

/** The knuckle line, which "sideways" is measured along. */
function knuckleAxis(root: THREE.Object3D, side: "l" | "r"): THREE.Vector3 {
  return W(root, `${side}_index1`).sub(W(root, `${side}_pinky1`)).normalize();
}

const FOUR = ["index", "middle", "ring", "pinky"] as const;
const NEIGHBOURS: [string, string][] = [
  ["index", "middle"],
  ["middle", "ring"],
  ["ring", "pinky"],
];

describe("hand rig", () => {
  it("finds every finger segment on both hands", () => {
    const expected = FINGER_CHAINS.reduce((n, c) => n + c.segments.length, 0);
    for (const side of ["l", "r"] as const) {
      const hand = captureHandBind(model, side);
      expect(hand, `${side} hand`).not.toBeNull();
      expect(hand!.bones.length, `${side} segment count`).toBe(expected);
    }
  });

  it("curls every fingertip TOWARD the palm, not away from it", () => {
    // The assertion the whole numerical axis derivation exists for. Getting a
    // sign backwards bends fingers the wrong way through the back of the hand,
    // which type-checks perfectly and looks grotesque.
    for (const side of ["l", "r"] as const) {
      const hand = captureHandBind(model, side)!;
      const before = FINGER_CHAINS.map((c) =>
        tipDistanceToWrist(model, side, c.name)
      );
      applyClench(hand, 1);
      const after = FINGER_CHAINS.map((c) =>
        tipDistanceToWrist(model, side, c.name)
      );
      FINGER_CHAINS.forEach((c, i) => {
        expect(
          after[i],
          `${side}_${c.name} tip should end up closer to the wrist`
        ).toBeLessThan(before[i]);
      });
    }
  });

  it("is monotonic: more clench is more closed", () => {
    const hand = captureHandBind(model, "l")!;
    const distances: number[] = [];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      applyClench(hand, t);
      distances.push(tipDistanceToWrist(model, "l", "middle"));
    }
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i], `step ${i}`).toBeLessThan(distances[i - 1]);
    }
  });

  it("returns exactly to the bind pose at clench 0", () => {
    const hand = captureHandBind(model, "l")!;
    const bind = hand.bones.map((b) => b.bindLocalQuat.clone());
    applyClench(hand, 1);
    applyClench(hand, 0);
    hand.bones.forEach((b, i) => {
      // q and -q are the same rotation, hence the abs.
      expect(Math.abs(b.bone.quaternion.dot(bind[i]))).toBeCloseTo(1, 9);
    });
  });

  it("clamps rather than extrapolating past a closed fist", () => {
    // Overshooting drives phalanges through each other.
    const hand = captureHandBind(model, "l")!;
    applyClench(hand, 1);
    const closed = tipDistanceToWrist(model, "l", "index");
    applyClench(hand, 4);
    expect(tipDistanceToWrist(model, "l", "index")).toBeCloseTo(closed, 9);
  });

  it("produces unit curl axes, so no rotation is silently scaled", () => {
    const hand = captureHandBind(model, "l")!;
    for (const b of hand.bones) {
      expect(b.curlAxis.length()).toBeCloseTo(1, 9);
      expect(Number.isFinite(b.curlAxis.x)).toBe(true);
    }
  });

  it("returns null for a mesh with no fingers instead of throwing", () => {
    // Fingers are cosmetic; a re-export without them should still box.
    const bare = new THREE.Object3D();
    expect(captureHandBind(bare, "l")).toBeNull();
  });
});

describe("fist closure", () => {
  // The screenshot that prompted this rewrite showed a splayed claw with the
  // fingers passing through each other. These assert the geometry that makes a
  // fist read as a fist, measured against the real rig.

  it("folds each fingertip right into the palm", () => {
    const hand = captureHandBind(model, "l")!;
    const before = FOUR.map((f) => W(model, `l_${f}_null`).distanceTo(W(model, `l_${f}1`)));
    applyClench(hand, 1);
    const after = FOUR.map((f) => W(model, `l_${f}_null`).distanceTo(W(model, `l_${f}1`)));

    FOUR.forEach((f, i) => {
      // A cupped hand leaves the tip most of a finger from its knuckle. A
      // closed fist brings it back to roughly a third of that.
      expect(after[i], `${f} should fold, not cup`).toBeLessThan(before[i] * 0.45);
    });
  });

  it("closes the gaps between fingers rather than fanning them", () => {
    // The fault that made the first two attempts look broken. At bind the
    // fingertips sit further apart than the knuckles — the fingers fan out —
    // and curling alone preserves that fan exactly.
    const hand = captureHandBind(model, "l")!;
    applyClench(hand, 1);
    const axis = knuckleAxis(model, "l");

    for (const [a, b] of NEIGHBOURS) {
      const jointGap = Math.abs(
        W(model, `l_${a}2`).sub(W(model, `l_${b}2`)).dot(axis)
      );
      const knuckleGap = Math.abs(
        W(model, `l_${a}1`).sub(W(model, `l_${b}1`)).dot(axis)
      );
      // Fingers side by side: the proximal phalanges must stay the same
      // distance apart as the knuckles they hang from. This is the part of a
      // fist you actually see; the tips are buried in the palm.
      expect(
        Math.abs(jointGap - knuckleGap),
        `${a}-${b} proximal phalanges should sit at knuckle spacing`
      ).toBeLessThan(knuckleGap * 0.12);
    }
  });

  it("keeps every joint solved inside an anatomically possible adduction", () => {
    // Pinning against the clamp means the solve is chasing the wrong target,
    // which is exactly how solving for the buried fingertip was caught: it
    // demanded ~29 degrees of knuckle adduction. Real values land near 8.
    const hand = captureHandBind(model, "l")!;
    // Only the four fingers' knuckles are solved. The thumb reuses the same
    // field for its AIM swing across the fist, which is deliberately large and
    // is not a knuckle adduction at all.
    const knuckles = hand.bones.filter((b) =>
      FOUR.some((f) => b.bone.name === `l_${f}1`)
    );
    expect(knuckles).toHaveLength(FOUR.length);
    for (const b of knuckles) {
      expect(
        Math.abs(b.adductAngle),
        `${b.bone.name} adduction should not be pinned at the clamp`
      ).toBeLessThan(HAND_SHAPE.adductMax * 0.95);
    }
  });

  it("wraps the thumb across the fingers instead of into the palm", () => {
    // A thumb curled like a finger goes straight through the other bones.
    const hand = captureHandBind(model, "l")!;
    const before = W(model, "l_thumb_null").distanceTo(W(model, "l_index2"));
    applyClench(hand, 1);
    const after = W(model, "l_thumb_null").distanceTo(W(model, "l_index2"));

    expect(after, "thumb should end up against the index finger").toBeLessThan(before * 0.5);
    // ...and not have been driven through it.
    expect(after, "but not inside it").toBeGreaterThan(0.004);
  });

  it("curls both hands, not just the one whose geometry was measured", () => {
    // The curl axes are derived per hand from that hand's own bind pose, so a
    // mirrored rig must not need a special case.
    for (const side of ["l", "r"] as const) {
      const hand = captureHandBind(model, side)!;
      const before = W(model, `${side}_middle_null`).distanceTo(W(model, `${side}_wrist`));
      applyClench(hand, 1);
      const after = W(model, `${side}_middle_null`).distanceTo(W(model, `${side}_wrist`));
      expect(after, `${side} hand should close`).toBeLessThan(before * 0.6);
    }
  });

  it("keeps the fingers in formation, not scattered off the knuckle line", () => {
    const hand = captureHandBind(model, "l")!;
    applyClench(hand, 1);
    const axis = knuckleAxis(model, "l");
    const joints = FOUR.map((f) => W(model, `l_${f}2`));
    const centre = joints
      .reduce((a, t) => a.add(t.clone()), new THREE.Vector3())
      .multiplyScalar(0.25);

    for (let i = 0; i < joints.length; i++) {
      const d = joints[i].clone().sub(centre);
      const offAxis = d.addScaledVector(axis, -d.dot(axis)).length();
      // Fingers in a closed fist lie in a row. Scatter perpendicular to that
      // row is the "claw" failure, and it must stay well under one finger.
      expect(offAxis, `${FOUR[i]} strays off the row`).toBeLessThan(0.012);
    }
  });
});
