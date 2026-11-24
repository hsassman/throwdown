import { describe, it, expect } from "vitest";
import type { Points } from "three";
import { buildCrowd, seatPositions } from "./crowd";
import { CROWD_CONFIG } from "../../config/tuning";

describe("crowd", () => {
  const inner = 5;
  const seats = seatPositions(inner);

  it("seats everyone outside the venue, with a gap to the first row", () => {
    for (const s of seats) {
      expect(Math.hypot(s.x, s.z)).toBeGreaterThanOrEqual(inner + CROWD_CONFIG.firstRowGap - 1e-6);
    }
  });

  it("raises each row above the one in front, like stands", () => {
    const radius = (s: { x: number; z: number }) => Math.hypot(s.x, s.z);
    const front = seats.filter((s) => radius(s) < inner + CROWD_CONFIG.firstRowGap + 0.5);
    const back = seats.filter((s) => radius(s) > inner + CROWD_CONFIG.firstRowGap + CROWD_CONFIG.rowDepth * 5);
    const meanY = (xs: { y: number }[]) => xs.reduce((a, s) => a + s.y, 0) / xs.length;
    expect(meanY(back)).toBeGreaterThan(meanY(front) + 1);
  });

  it("seats the same crowd every time for the same venue", () => {
    expect(seatPositions(inner)).toEqual(seats);
  });

  it("is one instanced draw that casts no shadows", () => {
    const crowd = buildCrowd(inner, 0);
    const instanced = crowd.group.children.filter((c) => (c as { isInstancedMesh?: boolean }).isInstancedMesh);
    expect(instanced).toHaveLength(1);
    expect(instanced[0].castShadow).toBe(false);
    crowd.dispose();
  });

  it("drops the camera flashes for reduced motion", () => {
    const calm = buildCrowd(inner, 0, false);
    expect(calm.group.children.some((c) => (c as { isPoints?: boolean }).isPoints)).toBe(false);
    calm.burst();
    calm.update(1);
    calm.dispose();
  });

  it("places a visible burst in the stands and fades it out", () => {
    const crowd = buildCrowd(inner, 0);
    const flashes = crowd.group.children.find(child => (child as Points).isPoints) as Points;
    crowd.burst();
    crowd.update(0);
    const { position, color } = flashes.geometry.attributes;
    expect(color.getX(0)).toBeGreaterThan(0.8);
    expect(Math.hypot(position.getX(0), position.getZ(0))).toBeGreaterThan(inner);
    crowd.update(CROWD_CONFIG.flashSeconds);
    expect(color.getX(0)).toBeCloseTo(0, 6);
    crowd.dispose();
  });
});
