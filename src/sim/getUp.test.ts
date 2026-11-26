import { describe, expect, it } from "vitest";
import { GET_UP, GetUpMeter } from "./getUp";

const UP = { tracked: true, guardHeight: GET_UP.guardHeight + 0.1 };
const DOWN = { tracked: true, guardHeight: 0.2 };
const dt = 1 / 60;

function run(meter: GetUpMeter, seconds: number, from: number, gloves: typeof UP): { rose: boolean; at: number } {
  let t = from;
  while (t < from + seconds) {
    t += dt;
    if (meter.update(dt, { sinceDown: t, ...gloves })) return { rose: true, at: t };
  }
  return { rose: false, at: t };
}

describe("GetUpMeter", () => {
  it("does nothing during the minimum time down, even with gloves up", () => {
    const m = new GetUpMeter();
    const r = run(m, GET_UP.minDownSeconds - 0.05, 0, UP);
    expect(r.rose).toBe(false);
    expect(m.progress).toBe(0);
  });

  it("gets up after the minimum time plus the fill time with gloves held up", () => {
    const m = new GetUpMeter();
    const r = run(m, 5, 0, UP);
    expect(r.rose).toBe(true);
    expect(r.at).toBeGreaterThanOrEqual(GET_UP.minDownSeconds + GET_UP.fillSeconds - 2 * dt);
    expect(r.at).toBeLessThan(GET_UP.minDownSeconds + GET_UP.fillSeconds + 3 * dt);
  });

  it("never gets up with the gloves down", () => {
    const m = new GetUpMeter();
    expect(run(m, 5, 0, DOWN).rose).toBe(false);
  });

  it("does not count gloves the camera cannot see", () => {
    const m = new GetUpMeter();
    expect(run(m, 5, 0, { tracked: false, guardHeight: 2 }).rose).toBe(false);
  });

  it("drains when the gloves drop, but a blink does not wipe it", () => {
    const m = new GetUpMeter();
    run(m, GET_UP.minDownSeconds + GET_UP.fillSeconds * 0.5, 0, UP);
    const half = m.progress;
    expect(half).toBeGreaterThan(0.3);
    m.update(dt, { sinceDown: 2, ...DOWN });
    expect(m.progress).toBeGreaterThan(half - 0.05);
    expect(m.progress).toBeLessThan(half);
  });

  it("starts empty again after reset", () => {
    const m = new GetUpMeter();
    run(m, 1.2, 0, UP);
    m.reset();
    expect(m.progress).toBe(0);
  });
});
