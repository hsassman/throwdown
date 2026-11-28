import { describe, expect, it } from "vitest";
import { SLOW_CONFIG as C, SlowDetector } from "./slowDetector";

describe("SlowDetector", () => {
  it("never trips on a machine running at 60 fps", () => {
    const d = new SlowDetector();
    for (let i = 0; i < 1000; i++) d.frame(1 / 60);
    expect(d.slow).toBe(false);
  });

  it("trips after about two seconds under 30 fps", () => {
    const d = new SlowDetector();
    for (let i = 0; i < C.slowFramesToTrip - 1; i++) d.frame(1 / 20);
    expect(d.slow).toBe(false);
    d.frame(1 / 20);
    expect(d.slow).toBe(true);
  });

  it("ignores a single hitch or a background tab", () => {
    const d = new SlowDetector();
    for (let i = 0; i < 200; i++) d.frame(i % 30 === 0 ? 0.1 : 1 / 60);
    d.frame(3); // tab came back
    expect(d.slow).toBe(false);
  });

  it("trips when pose tracking is starved by the GPU", () => {
    const d = new SlowDetector();
    for (let i = 0; i < C.starvedReadingsToTrip; i++) d.poseInterval(90, 60);
    expect(d.slow).toBe(true);
  });

  it("does not trip when the camera, not the GPU, limits the pose rate", () => {
    const d = new SlowDetector();
    for (let i = 0; i < 20; i++) d.poseInterval(90, 12);
    expect(d.slow).toBe(false);
  });

  it("needs the starvation to be sustained", () => {
    const d = new SlowDetector();
    for (let i = 0; i < 20; i++) d.poseInterval(i % 2 ? 90 : 40, 60);
    expect(d.slow).toBe(false);
  });

  it("stays tripped once tripped", () => {
    const d = new SlowDetector();
    for (let i = 0; i < C.starvedReadingsToTrip; i++) d.poseInterval(90, 60);
    for (let i = 0; i < 500; i++) d.frame(1 / 120);
    d.poseInterval(20, 10);
    expect(d.slow).toBe(true);
  });
});
