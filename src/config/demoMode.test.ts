import { describe, expect, it } from "vitest";
import { DEMO_PRESET, isDemoMode } from "./demoMode";

describe("isDemoMode", () => {
  it("is on for ?demo with or without a value", () => {
    expect(isDemoMode("?demo")).toBe(true);
    expect(isDemoMode("?demo=1")).toBe(true);
    expect(isDemoMode("?camW=480&demo")).toBe(true);
  });

  it("is off when absent or explicitly off", () => {
    expect(isDemoMode("")).toBe(false);
    expect(isDemoMode("?stage")).toBe(false);
    expect(isDemoMode("?demo=0")).toBe(false);
    expect(isDemoMode("?demo=false")).toBe(false);
  });
});

describe("DEMO_PRESET", () => {
  it("only ever lowers quality settings", () => {
    expect(DEMO_PRESET.camWidth).toBeLessThan(640);
    expect(DEMO_PRESET.maxPixelRatio).toBeLessThanOrEqual(1);
    expect(DEMO_PRESET.antialias).toBe(false);
    expect(DEMO_PRESET.shadows).toBe(false);
    expect(DEMO_PRESET.crowd).toBe(false);
  });
});
