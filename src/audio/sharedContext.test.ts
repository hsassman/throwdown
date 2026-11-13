import { beforeEach, describe, expect, it } from "vitest";
import { getSharedAudioContext, resetSharedAudioContextForTests, unlockAudio } from "./sharedContext";

class FakeContext {
  static created = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  resumes = 0;
  constructor() {
    FakeContext.created++;
  }
  resume() {
    this.resumes++;
    this.state = "running";
    return Promise.resolve();
  }
}

const Ctor = FakeContext as unknown as typeof AudioContext;

describe("shared audio context", () => {
  beforeEach(() => {
    resetSharedAudioContextForTests();
    FakeContext.created = 0;
  });

  it("creates one context and reuses it", () => {
    const a = getSharedAudioContext(Ctor);
    const b = getSharedAudioContext(Ctor);
    expect(a).toBe(b);
    expect(FakeContext.created).toBe(1);
  });

  it("returns null when audio is unsupported", () => {
    expect(getSharedAudioContext(undefined)).toBeNull();
  });

  it("unlock resumes a suspended context", () => {
    unlockAudio(Ctor);
    const ctx = getSharedAudioContext(Ctor) as unknown as FakeContext;
    expect(ctx.resumes).toBe(1);
    expect(ctx.state).toBe("running");
  });
});
