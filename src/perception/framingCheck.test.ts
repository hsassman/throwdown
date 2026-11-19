import { describe, it, expect } from "vitest";
import { assessFraming, FramingCoach, lumaOf, type LumaSample } from "./framingCheck";
import { FRAMING_CONFIG } from "../config/tuning";
import type { Keypoint, PoseFrame } from "../pose/poseTypes";

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/** A well-framed player: torso 0.30 of the frame, centred, hands up. */
function player(o: { dx?: number; scale?: number; dy?: number } = {}): PoseFrame {
  const s = o.scale ?? 1;
  const cx = 0.5 + (o.dx ?? 0);
  const cy = 0.5 + (o.dy ?? 0);
  const at = (x: number, y: number) => kp(cx + (x - 0.5) * s, cy + (y - 0.5) * s);
  return {
    timestamp: 0,
    nose: at(0.5, 0.22),
    leftEye: at(0.53, 0.2),
    rightEye: at(0.47, 0.2),
    leftEar: at(0.56, 0.21),
    rightEar: at(0.44, 0.21),
    leftShoulder: at(0.6, 0.38),
    rightShoulder: at(0.4, 0.38),
    leftElbow: at(0.63, 0.52),
    rightElbow: at(0.37, 0.52),
    leftWrist: at(0.56, 0.36),
    rightWrist: at(0.44, 0.36),
    leftHip: at(0.57, 0.68),
    rightHip: at(0.43, 0.68),
  };
}

const goodLight: LumaSample = { mean: 120, centre: 120, edge: 120 };

describe("assessFraming", () => {
  it("is happy with a well-framed, well-lit player", () => {
    expect(assessFraming(player(), goodLight)).toEqual([]);
  });

  it("asks a missing player to step into view", () => {
    expect(assessFraming(null, goodLight)[0]).toBe("noBody");
  });

  it("blames the light, not the player, when it is too dark to find them", () => {
    const issues = assessFraming(null, { mean: 20, centre: 20, edge: 20 });
    expect(issues[0]).toBe("tooDark");
    expect(issues).not.toContain("noBody");
  });

  it("spots a bright window behind the player", () => {
    expect(assessFraming(player(), { mean: 140, centre: 60, edge: 190 })[0]).toBe("backlit");
  });

  it("asks a player whose hips are out of frame to step back", () => {
    expect(assessFraming(player({ scale: 1.6 }), goodLight)).toContain("tooClose");
  });

  it("asks a player whose head is cut off to step back", () => {
    expect(assessFraming(player({ dy: -0.18 }), goodLight)).toContain("tooClose");
  });

  it("asks a distant player to step closer", () => {
    expect(assessFraming(player({ scale: 0.4 }), goodLight)).toContain("tooFar");
  });

  it("gives the direction from the player's mirror view, not the raw image", () => {
    // Raw-image x is unmirrored: small x is the player's own right.
    expect(assessFraming(player({ dx: -0.33 }), goodLight)).toContain("offLeft");
    expect(assessFraming(player({ dx: 0.33 }), goodLight)).toContain("offRight");
  });

  it("asks for both hands when one is out of view", () => {
    const p = player();
    p.rightWrist = { ...p.rightWrist, confidence: 0.1 };
    expect(assessFraming(p, goodLight)).toEqual(["handsHidden"]);
  });

  it("puts the most useful instruction first", () => {
    // Too close and hands out of frame: stepping back fixes both.
    const p = player({ scale: 1.6 });
    p.leftWrist = { ...p.leftWrist, confidence: 0 };
    const issues = assessFraming(p, goodLight);
    expect(issues[0]).toBe("tooClose");
  });

  it("never reads MediaPipe z", () => {
    const p = player();
    const poisoned = Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, typeof v === "object" ? { ...v, z: NaN } : v])
    ) as unknown as PoseFrame;
    expect(assessFraming(poisoned, goodLight)).toEqual(assessFraming(p, goodLight));
  });
});

describe("FramingCoach", () => {
  const { showAfterMs, hideAfterMs } = FRAMING_CONFIG;

  it("does not flash a prompt for a momentary problem", () => {
    const c = new FramingCoach();
    expect(c.update(["noBody"], 0)).toBeNull();
    expect(c.update(["noBody"], showAfterMs - 1)).toBeNull();
    expect(c.update([], showAfterMs)).toBeNull();
  });

  it("shows a problem that persists, and holds it briefly after it clears", () => {
    const c = new FramingCoach();
    c.update(["tooClose"], 0);
    expect(c.update(["tooClose"], showAfterMs)).toBe("tooClose");
    expect(c.update([], showAfterMs + 10)).toBe("tooClose");
    expect(c.update([], showAfterMs + 10 + hideAfterMs)).toBeNull();
  });

  it("does not let a flickering reading restart the clear timer", () => {
    const c = new FramingCoach();
    c.update(["tooDark"], 0);
    c.update(["tooDark"], showAfterMs);
    // One bad frame in the middle of clearing resets it - the picture has to
    // be clean for the whole hold, not on average.
    c.update([], showAfterMs + 100);
    c.update(["tooDark"], showAfterMs + 200);
    expect(c.update([], showAfterMs + 300 + hideAfterMs - 1)).toBe("tooDark");
  });
});

describe("lumaOf", () => {
  it("separates a bright border from a dark centre", () => {
    const w = 12;
    const h = 12;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inCentre = x >= 4 && x < 8 && y >= 4 && y < 8;
        const v = inCentre ? 30 : 220;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    }
    const l = lumaOf(data, w, h);
    expect(l.centre).toBeCloseTo(30, 0);
    expect(l.edge).toBeCloseTo(220, 0);
    expect(l.mean).toBeGreaterThan(l.centre);
  });
});
