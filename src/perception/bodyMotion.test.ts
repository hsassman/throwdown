import { describe, it, expect } from "vitest";
import { BodyMotionTracker, sampleBody } from "./bodyMotion";
import { BODY_CONFIG } from "../config/tuning";
import { POSE_KEYS, type PoseFrame, type PoseKey } from "../pose/poseTypes";

// A square-on resting pose. Shoulders 0.16 apart, hips 0.30 below them, so the
// torso scale is exactly 0.30 and the arithmetic below stays readable.
const BASE: Record<PoseKey, { x: number; y: number }> = {
  leftShoulder: { x: 0.58, y: 0.4 },
  rightShoulder: { x: 0.42, y: 0.4 },
  leftElbow: { x: 0.62, y: 0.52 },
  rightElbow: { x: 0.38, y: 0.52 },
  leftWrist: { x: 0.6, y: 0.62 },
  rightWrist: { x: 0.4, y: 0.62 },
  leftHip: { x: 0.55, y: 0.7 },
  rightHip: { x: 0.45, y: 0.7 },
  nose: { x: 0.5, y: 0.3 },
  leftEye: { x: 0.52, y: 0.28 },
  rightEye: { x: 0.48, y: 0.28 },
  leftEar: { x: 0.55, y: 0.29 },
  rightEar: { x: 0.45, y: 0.29 },
};

interface Move {
  /** Image-space shift of the whole body. */
  dx?: number;
  dy?: number;
  /** Multiplies every distance from the body centre — i.e. stepping in/out. */
  zoom?: number;
  /** Multiplies shoulder width only — i.e. blading the torso. */
  narrow?: number;
  confidence?: number;
}

function pose(m: Move = {}): PoseFrame {
  const { dx = 0, dy = 0, zoom = 1, narrow = 1, confidence = 0.95 } = m;
  // Zoom is about the OPTICAL AXIS — the image centre — because that is what
  // a camera actually does when the subject steps nearer. Zooming about some
  // other point would be modelling a lens that does not exist.
  const cx = 0.5;
  const cy = 0.5;
  const f: Record<string, unknown> = { timestamp: 0 };
  for (const k of POSE_KEYS) {
    const b = BASE[k];
    let x = cx + (b.x - cx) * zoom;
    const y = cy + (b.y - cy) * zoom;
    if (k === "leftShoulder" || k === "rightShoulder") {
      x = cx + (x - cx) * narrow;
    }
    f[k] = { x: x + dx, y: y + dy, z: 0, confidence };
  }
  return f as unknown as PoseFrame;
}

function tracked(m: Move = {}): BodyMotionTracker {
  const t = new BodyMotionTracker();
  t.update(pose()); // establishes neutral
  t.update(pose(m));
  return t;
}

describe("sampling", () => {
  it("measures the torso scale and shoulder width", () => {
    const s = sampleBody(pose())!;
    expect(s.scale).toBeCloseTo(0.3, 6);
    expect(s.shoulderWidth).toBeCloseTo(0.16, 6);
  });

  it("refuses a frame whose shoulders are not tracked", () => {
    expect(sampleBody(pose({ confidence: 0.1 }))).toBeNull();
  });

  it("takes the WEAKEST landmark's confidence, not the mean", () => {
    // A mean lets a well-tracked shoulder hide a lost hip, and the hips are
    // what the torso scale — and so the whole depth channel — rests on.
    const p = pose();
    p.leftHip.confidence = 0.2;
    p.rightHip.confidence = 0.2;
    const s = sampleBody(p)!;
    expect(s.confidence).toBeCloseTo(0.2, 6);
  });
});

describe("the neutral", () => {
  it("reports nothing on the very first frame", () => {
    // The first pose IS the reference. Reporting motion against a reference
    // that does not exist yet would mean the character lurched on startup.
    const t = new BodyMotionTracker();
    const m = t.update(pose({ dx: 0.2 }));
    expect(m.tracked).toBe(true);
    expect(m.lateral).toBe(0);
    expect(m.depth).toBe(0);
    expect(t.calibrated).toBe(true);
  });

  it("drops to untracked rather than holding a stale crouch", () => {
    // A held crouch with nothing driving it leaves the character folded over
    // indefinitely, which is worse than not crouching at all.
    const t = tracked({ dy: 0.1 });
    expect(t.state.crouch).toBeGreaterThan(0);
    const m = t.update(pose({ confidence: 0.1 }));
    expect(m.tracked).toBe(false);
    expect(m.crouch).toBe(0);
  });

  it("drifts toward where the player settles", () => {
    const t = new BodyMotionTracker();
    t.update(pose());
    expect(t.update(pose({ dx: 0.06 })).lateral).toBeGreaterThan(0.15);
    // A long lean, sampled over many seconds, should decay toward neutral.
    for (let i = 0; i < 60; i++) t.followNeutral(pose({ dx: 0.06 }), 1);
    expect(Math.abs(t.update(pose({ dx: 0.06 })).lateral)).toBeLessThan(0.02);
  });
});

describe("lateral and vertical", () => {
  it("measures a slip in torso units, signed toward the player's right", () => {
    // 0.06 image units against a 0.30 torso is 0.2 torso units.
    expect(tracked({ dx: 0.06 }).state.lateral).toBeCloseTo(0.2, 2);
    expect(tracked({ dx: -0.06 }).state.lateral).toBeCloseTo(-0.2, 2);
  });

  it("reports a DROP as negative, not positive", () => {
    // Image y grows downward. Getting this backwards makes the character rise
    // onto its toes when the player ducks, which is the exact opposite of the
    // input and reads as the tracking being inverted.
    expect(tracked({ dy: 0.06 }).state.vertical).toBeCloseTo(-0.2, 2);
    expect(tracked({ dy: -0.06 }).state.vertical).toBeCloseTo(0.2, 2);
  });

  it("clamps absurd travel instead of throwing the character out of frame", () => {
    const m = tracked({ dx: 5, dy: -5 }).state;
    expect(Math.abs(m.lateral)).toBeLessThanOrEqual(BODY_CONFIG.travelClamp);
    expect(Math.abs(m.vertical)).toBeLessThanOrEqual(BODY_CONFIG.travelClamp);
  });
});

describe("crouch", () => {
  it("is zero standing and one at a full drop", () => {
    expect(tracked().state.crouch).toBe(0);
    const full = BODY_CONFIG.fullCrouch * 0.3; // torso units -> image units
    expect(tracked({ dy: full }).state.crouch).toBeCloseTo(1, 1);
  });

  it("does not go negative when the player stands up tall", () => {
    // Rising is not a negative crouch; it is no crouch.
    expect(tracked({ dy: -0.1 }).state.crouch).toBe(0);
  });

  it("is proportional in between", () => {
    const half = tracked({ dy: BODY_CONFIG.fullCrouch * 0.3 * 0.5 }).state.crouch;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
  });
});

describe("depth", () => {
  it("reads a step TOWARD the camera as positive", () => {
    // Stepping in makes the torso bigger.
    expect(tracked({ zoom: 1.15 }).state.depth).toBeGreaterThan(0);
    expect(tracked({ zoom: 0.87 }).state.depth).toBeLessThan(0);
  });

  it("matches the perspective relation it claims to implement", () => {
    // Delta = D * (1 - s_neutral / s_now). With a 15% bigger torso and D = 4:
    //   4 * (1 - 1/1.15) = 0.5217
    const expected = BODY_CONFIG.cameraDistance * (1 - 1 / 1.15);
    expect(tracked({ zoom: 1.15 }).state.depth).toBeCloseTo(expected, 4);
  });

  it("is zero when the player has not moved toward or away", () => {
    expect(tracked({ dx: 0.08, dy: 0.05 }).state.depth).toBeCloseTo(0, 6);
  });

  it("never reads MediaPipe z", () => {
    // The standing rule. Poisoning every z must change nothing at all.
    const t1 = new BodyMotionTracker();
    t1.update(pose());
    const clean = t1.update(pose({ zoom: 1.2 }));

    const t2 = new BodyMotionTracker();
    const poison = (p: PoseFrame) => {
      for (const k of POSE_KEYS) p[k].z = Math.random() * 100 - 50;
      return p;
    };
    t2.update(poison(pose()));
    const dirty = t2.update(poison(pose({ zoom: 1.2 })));
    expect(dirty.depth).toBeCloseTo(clean.depth, 12);
    expect(dirty.turn).toBeCloseTo(clean.turn, 12);
  });

  it("clamps rather than letting a scale glitch teleport the character", () => {
    expect(Math.abs(tracked({ zoom: 6 }).state.depth)).toBeLessThanOrEqual(
      BODY_CONFIG.depthClamp
    );
    expect(Math.abs(tracked({ zoom: 0.05 }).state.depth)).toBeLessThanOrEqual(
      BODY_CONFIG.depthClamp
    );
  });
});

describe("turn", () => {
  it("ignores small changes, because acos is steepest where the signal is weakest", () => {
    // Without the dead zone, resting noise near square-on turns into a
    // visibly twitching torso — the worst place to put jitter, since it is a
    // part of the body the player is not moving.
    expect(tracked({ narrow: 0.999 }).state.turn).toBe(0);
    expect(tracked({ narrow: 0.995 }).state.turn).toBe(0);
  });

  it("grows as the shoulder line narrows", () => {
    const mild = Math.abs(tracked({ narrow: 0.9 }).state.turn);
    const hard = Math.abs(tracked({ narrow: 0.7 }).state.turn);
    expect(mild).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(mild);
  });

  it("matches acos, less the dead zone", () => {
    const expected = Math.acos(0.8) - BODY_CONFIG.turnDeadZone;
    expect(tracked({ narrow: 0.8 }).state.turn).toBeCloseTo(expected, 5);
  });

  it("takes its SIGN from stance, because a frontal camera cannot see it", () => {
    // The projection is symmetric: turning left and turning right narrow the
    // shoulder line identically. A boxer does not turn both ways, so the sport
    // resolves what the camera cannot.
    const t = new BodyMotionTracker();
    t.update(pose());
    const orthodox = t.update(pose({ narrow: 0.8 }), "orthodox").turn;
    const southpaw = t.update(pose({ narrow: 0.8 }), "southpaw").turn;
    expect(orthodox).toBeGreaterThan(0);
    expect(southpaw).toBeLessThan(0);
    expect(orthodox).toBeCloseTo(-southpaw, 10);
  });

  it("never returns NaN when the player leans IN and measures wider", () => {
    // acos of anything above 1 is NaN, and a NaN would propagate straight into
    // the character's rotation and freeze it there permanently.
    const m = tracked({ narrow: 1.4 }).state;
    expect(Number.isFinite(m.turn)).toBe(true);
    expect(m.turn).toBe(0);
  });

  it("clamps to a bladed stance, not a pirouette", () => {
    expect(Math.abs(tracked({ narrow: 0.01 }).state.turn)).toBeLessThanOrEqual(
      BODY_CONFIG.turnClamp
    );
  });
});

describe("channel independence", () => {
  it("does not leak a sideways step into depth or turn", () => {
    // Every channel is normalised by the torso, so walking across frame must
    // not read as stepping in or blading.
    const m = tracked({ dx: 0.1 }).state;
    expect(m.depth).toBeCloseTo(0, 6);
    expect(m.turn).toBe(0);
    expect(m.lateral).toBeGreaterThan(0.2);
  });

  it("does not leak a step forward into lateral or vertical", () => {
    const m = tracked({ zoom: 1.2 }).state;
    expect(m.depth).toBeGreaterThan(0);
    expect(Math.abs(m.lateral)).toBeLessThan(0.02);
    expect(Math.abs(m.vertical)).toBeLessThan(0.02);
  });

  it("does not leak a turn into depth", () => {
    // Blading narrows the shoulders but does NOT change shoulder-to-hip
    // distance, so the torso scale — and therefore depth — must hold still.
    const m = tracked({ narrow: 0.75 }).state;
    expect(Math.abs(m.turn)).toBeGreaterThan(0);
    expect(m.depth).toBeCloseTo(0, 6);
  });
});
