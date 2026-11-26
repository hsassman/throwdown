import { describe, expect, it } from "vitest";
import { FPS_CAMERA, approach, fpsCameraPose, isGhostPart } from "./fpsCamera";

describe("fpsCameraPose", () => {
  const head = { x: 0, y: 1.6, z: 0 };
  const opp = { x: 0, y: 1.6, z: 1.7 };

  it("sits behind the player's head, on the far side from the opponent", () => {
    const p = fpsCameraPose(head, opp);
    expect(p.position.z).toBeCloseTo(-FPS_CAMERA.back, 5);
    expect(p.position.x).toBeCloseTo(0, 5);
    expect(p.position.y).toBeCloseTo(1.6 + FPS_CAMERA.up, 5);
  });

  it("looks at the opponent, just below their head", () => {
    const p = fpsCameraPose(head, opp);
    expect(p.target).toEqual({ x: 0, y: 1.6 - FPS_CAMERA.lookDown, z: 1.7 });
  });

  it("turns with an opponent who has circled to one side", () => {
    const side = { x: 1, y: 1.6, z: 1 };
    const p = fpsCameraPose(head, side);
    // Behind the head, away from the opponent: negative x and negative z.
    expect(p.position.x).toBeLessThan(0);
    expect(p.position.z).toBeLessThan(0);
    const back = Math.hypot(p.position.x, p.position.z);
    expect(back).toBeCloseTo(FPS_CAMERA.back, 5);
  });

  it("ignores height when choosing the direction, so a duck doesn't tilt the view", () => {
    const ducked = { x: 0, y: 1.1, z: 0 };
    const p = fpsCameraPose(ducked, opp);
    expect(p.position.z).toBeCloseTo(-FPS_CAMERA.back, 5);
  });

  it("does not produce NaN when the heads coincide", () => {
    const p = fpsCameraPose(head, head);
    for (const v of [p.position.x, p.position.y, p.position.z]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("approach", () => {
  it("moves part of the way per frame and reaches the goal over time", () => {
    let v = { x: 0, y: 0, z: 0 };
    v = approach(v, { x: 1, y: 1, z: 1 }, 1 / 60, 0.06);
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(1);
    for (let i = 0; i < 120; i++) v = approach(v, { x: 1, y: 1, z: 1 }, 1 / 60, 0.06);
    expect(v.x).toBeCloseTo(1, 3);
  });

  it("snaps when tau is zero", () => {
    expect(approach({ x: 0, y: 0, z: 0 }, { x: 2, y: 3, z: 4 }, 0.016, 0)).toEqual({ x: 2, y: 3, z: 4 });
  });
});

describe("isGhostPart", () => {
  it("fades the body, shorts, shoes and eyes", () => {
    for (const n of ["body", "shorts", "shoe_L", "eye_R", "body_mesh"]) expect(isGhostPart([n])).toBe(true);
  });

  it("keeps both gloves solid, by the mesh's own name or its parent's", () => {
    expect(isGhostPart(["glove_L"])).toBe(false);
    expect(isGhostPart(["glove_R_mesh", "model"])).toBe(false);
    expect(isGhostPart(["", "glove_R"])).toBe(false);
  });
});
