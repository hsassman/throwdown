import { describe, expect, it } from "vitest";
import { playUrl, qrMatrix, qrPath } from "./stageModel";

describe("playUrl", () => {
  it("points at the game without the stage flag", () => {
    expect(playUrl("https://shadowbox.example/?stage")).toBe("https://shadowbox.example/");
    expect(playUrl("https://shadowbox.example/?stage=1&camW=320")).toBe(
      "https://shadowbox.example/?camW=320"
    );
  });

  it("uses an explicit ?url= override", () => {
    expect(
      playUrl("http://localhost:4173/?stage&url=" + encodeURIComponent("https://play.example/"))
    ).toBe("https://play.example/");
  });

  it("ignores an override that is not a web link", () => {
    expect(playUrl("http://localhost:4173/?stage&url=javascript:alert(1)")).toBe(
      "http://localhost:4173/"
    );
  });
});

describe("qrMatrix", () => {
  it("is square, with the three finder patterns in the corners", () => {
    const m = qrMatrix("https://shadowbox.example/");
    const n = m.length;
    expect(n).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === n)).toBe(true);
    // Each finder pattern starts with a dark top-left module.
    expect(m[0][0]).toBe(true);
    expect(m[0][n - 7]).toBe(true);
    expect(m[n - 7][0]).toBe(true);
  });

  it("draws one path segment per dark module", () => {
    const d = qrPath([
      [true, false],
      [false, true],
    ]);
    expect(d).toBe("M0 0h1v1h-1zM1 1h1v1h-1z");
  });
});
