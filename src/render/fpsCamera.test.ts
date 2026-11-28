import { describe, expect, it } from "vitest";
import { FPS_CAMERA, approach, fpsCameraPose, fpsFov, fpsLean, isGlove } from "./fpsCamera";

const hFov = (v: number, aspect: number) => (2 * Math.atan(Math.tan((v * Math.PI) / 360) * aspect) * 180) / Math.PI;

describe("fpsCameraPose", () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  const opp = { x: 0, y: 1.6, z: 0.8 };

  it("sits at the eyes, not behind the head", () => {
    const p = fpsCameraPose(eye, opp);
    expect(Math.abs(p.position.z)).toBeLessThan(0.05);
    expect(p.position.x).toBeCloseTo(0, 5);
    expect(p.position.y).toBeCloseTo(1.6 + FPS_CAMERA.up, 5);
  });

  it("looks at the opponent, just below their head", () => {
    expect(fpsCameraPose(eye, opp).target).toEqual({ x: 0, y: 1.6 - FPS_CAMERA.lookDown, z: 0.8 });
  });

  it("keeps the offset along the line to an opponent who has circled", () => {
    const p = fpsCameraPose(eye, { x: 1, y: 1.6, z: 1 });
    expect(Math.hypot(p.position.x, p.position.z)).toBeCloseTo(Math.abs(FPS_CAMERA.forward), 5);
  });

  it("does not produce NaN when the heads coincide", () => {
    const p = fpsCameraPose(eye, eye);
    for (const v of [p.position.x, p.position.y, p.position.z]) expect(Number.isFinite(v)).toBe(true);
  });

  it("slides to screen right for a positive side", () => {
    const p = fpsCameraPose(eye, opp, FPS_CAMERA, 0.1);
    expect(p.position.x).toBeCloseTo(-0.1, 5);
    expect(p.target.x).toBeCloseTo(-0.1 * FPS_CAMERA.leanTargetShare, 5);
  });
});

describe("fpsFov", () => {
  it("uses the base field of view on a landscape screen", () => {
    expect(fpsFov(16 / 9)).toBe(FPS_CAMERA.fov);
  });

  it("widens on a portrait screen, up to the cap", () => {
    const v = fpsFov(9 / 16);
    expect(v).toBeGreaterThan(FPS_CAMERA.fov);
    expect(v).toBeLessThanOrEqual(FPS_CAMERA.maxFov);
    expect(hFov(v, 9 / 16)).toBeGreaterThan(hFov(FPS_CAMERA.fov, 9 / 16));
  });

  it("meets the horizontal minimum whenever the cap allows", () => {
    expect(hFov(fpsFov(1), 1)).toBeGreaterThanOrEqual(FPS_CAMERA.minHFov - 1e-6);
  });

  it("survives a zero or bad aspect", () => {
    for (const a of [0, Number.NaN, -1]) expect(Number.isFinite(fpsFov(a))).toBe(true);
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

describe("mesh roles", () => {
  it("finds gloves by the mesh's own name or its parent's", () => {
    expect(isGlove(["glove_L"])).toBe(true);
    expect(isGlove(["", "glove_R"])).toBe(true);
    expect(isGlove(["body"])).toBe(false);
  });
});

describe("dodge lean", () => {
  it("is zero at no slip, capped for a huge one, and ignores NaN", () => {
    expect(fpsLean(0)).toEqual({ side: 0, roll: 0 });
    expect(fpsLean(10)).toEqual({ side: FPS_CAMERA.leanSideMax, roll: FPS_CAMERA.leanRollMax });
    expect(fpsLean(-10).side).toBe(-FPS_CAMERA.leanSideMax);
    expect(fpsLean(Number.NaN)).toEqual({ side: 0, roll: 0 });
  });
});
