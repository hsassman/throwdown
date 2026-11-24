import { describe, expect, it } from "vitest";
import { GOVERNOR_CONFIG as C, ResolutionGovernor } from "./resolutionGovernor";

const frames = (g: ResolutionGovernor, n: number, dt: number) => {
  let last: number | null = null;
  for (let i = 0; i < n; i++) last = g.frame(dt) ?? last;
  return last;
};

describe("ResolutionGovernor", () => {
  it("drops resolution when the 3D view is slow, as before", () => {
    const g = new ResolutionGovernor(0.75, 1.75);
    frames(g, C.slowFramesToDrop + 1, 0.03);
    expect(g.ratio).toBe(1.5);
  });

  it("drops resolution when pose tracking is starved, even if rendering is fast", () => {
    const g = new ResolutionGovernor(0.75, 1.75);
    frames(g, 50, 0.01);
    g.poseInterval(80);
    expect(g.ratio).toBe(1.75); // one reading isn't enough
    g.poseInterval(80);
    expect(g.ratio).toBe(1.5);
    g.poseInterval(80);
    g.poseInterval(80);
    expect(g.ratio).toBe(1.25);
  });

  it("never goes below the minimum", () => {
    const g = new ResolutionGovernor(0.75, 1.75);
    for (let i = 0; i < 40; i++) g.poseInterval(120);
    expect(g.ratio).toBe(0.75);
  });

  it("won't climb back while poses are starved or only borderline", () => {
    const g = new ResolutionGovernor(0.75, 1.75, 1.0);
    g.poseInterval(52); // between healthy (45) and starved (60)
    frames(g, C.fastFramesToRaise + 5, 0.01);
    expect(g.ratio).toBe(1.0);
  });

  it("climbs back once both rendering and poses are healthy", () => {
    const g = new ResolutionGovernor(0.75, 1.75, 1.0);
    g.poseInterval(40);
    frames(g, C.fastFramesToRaise + 1, 0.01);
    expect(g.ratio).toBe(1.25);
  });

  it("ignores a missing pose stream (camera off) and behaves as before", () => {
    const g = new ResolutionGovernor(0.75, 1.75, 1.0);
    g.poseInterval(200);
    g.poseInterval(null);
    frames(g, C.fastFramesToRaise + 1, 0.01);
    expect(g.ratio).toBe(1.25);
  });

  it("keeps resolution when the camera, not inference, is what's slow", () => {
    const g = new ResolutionGovernor(0.75, 1.75);
    for (let i = 0; i < 6; i++) g.poseInterval(66, 12); // 15 FPS webcam, fast model
    expect(g.ratio).toBe(1.75);
    for (let i = 0; i < 2; i++) g.poseInterval(66, 45); // inference is the bottleneck
    expect(g.ratio).toBe(1.5);
  });

  it("resets a starvation streak when a healthy reading arrives", () => {
    const g = new ResolutionGovernor(0.75, 1.75);
    g.poseInterval(80);
    g.poseInterval(30);
    g.poseInterval(80);
    expect(g.ratio).toBe(1.75);
  });
});
