import { describe, it, expect } from "vitest";
import { ClockSync, LinkStats } from "./linkStats";
import { SENSOR_CONFIG } from "../config/tuning";

describe("ClockSync", () => {
  it("recovers the offset from a symmetric exchange", () => {
    const c = new ClockSync();
    // Phone clock runs 5000 ms ahead; 20 ms each way.
    c.add(1000, 1020 + 5000, 1040);
    expect(c.offset).toBe(5000);
    expect(c.rtt).toBe(40);
    expect(c.toLocal(9000)).toBe(4000);
  });

  it("trusts the fastest round trip, not the latest", () => {
    const c = new ClockSync();
    c.add(0, 10 + 5000, 20); // clean
    // Queued 200 ms on the way back only: this sample's offset is 100 ms off.
    c.add(100, 110 + 5000, 320);
    expect(c.offset).toBe(5000);
  });

  it("ignores impossible samples", () => {
    const c = new ClockSync();
    c.add(100, 5000, 50);
    c.add(100, NaN, 150);
    expect(c.offset).toBeNull();
  });
});

describe("LinkStats", () => {
  it("measures frame age on the laptop's clock", () => {
    const s = new LinkStats();
    s.clock.add(0, 10 + 5000, 20); // phone = laptop + 5000
    // Stamped at phone 5100 (laptop 100), arriving at laptop 160: 60 ms old.
    for (let i = 0; i < 10; i++) s.frame(5100 + i * 66, 160 + i * 66);
    const sum = s.summary(160 + 9 * 66);
    expect(sum.ageP50).toBeCloseTo(60);
    expect(sum.ageP95).toBeCloseTo(60);
  });

  it("measures how far the phone trails the laptop's own tracking", () => {
    const s = new LinkStats();
    s.clock.add(0, 10 + 5000, 20);
    // Phone frames arrive 90 ms old; the laptop's own pose is 50 ms old.
    for (let i = 0; i < 10; i++) s.frame(5100 + i * 66, 190 + i * 66, 50);
    expect(s.summary(1000).lagP50).toBeCloseTo(40);
    // Without the laptop's own pose there is nothing to compare against.
    expect(new LinkStats().summary(0).lagP50).toBeNull();
  });

  it("counts frame rate, stalls and repeats", () => {
    const s = new LinkStats();
    let t = 0;
    for (let i = 0; i < 30; i++) s.frame(i, (t += 66));
    s.frame(29, t + 1); // same frame again
    s.frame(30, (t += SENSOR_CONFIG.stallMs + 50));
    const sum = s.summary(t);
    expect(sum.received).toBe(31);
    expect(sum.stalls).toBe(1);
    expect(sum.fps).toBeGreaterThan(10);
    expect(sum.fps).toBeLessThan(16);
  });

  it("separates frames the network lost from ones the phone never sent", () => {
    const s = new LinkStats();
    for (let i = 0; i < 90; i++) s.frame(i, i * 66);
    s.report(100, 95);
    const sum = s.summary(90 * 66);
    expect(sum.phoneDropPct).toBeCloseTo(5);
    expect(sum.lostPct).toBeCloseTo((5 / 95) * 100);
  });
});
