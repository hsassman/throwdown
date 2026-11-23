import { describe, it, expect } from "vitest";
import {
  FirstRunCoach,
  guardIsUp,
  markFirstRunDone,
  shouldShowFirstRun,
  wellFramed,
} from "./firstRun";
import { FIRST_RUN_CONFIG } from "../config/tuning";
import type { Keypoint, PoseFrame } from "../pose/poseTypes";

const kp = (x: number, y: number, confidence = 1): Keypoint => ({ x, y, confidence });

/** A frontal player, torso 0.30 of the frame; wrists at `wristY`. */
function pose(wristY = 0.36, hips = 1): PoseFrame {
  return {
    timestamp: 0,
    nose: kp(0.5, 0.22),
    leftEye: kp(0.53, 0.2),
    rightEye: kp(0.47, 0.2),
    leftEar: kp(0.56, 0.21),
    rightEar: kp(0.44, 0.21),
    leftShoulder: kp(0.6, 0.38),
    rightShoulder: kp(0.4, 0.38),
    leftElbow: kp(0.63, 0.52),
    rightElbow: kp(0.37, 0.52),
    leftWrist: kp(0.56, wristY),
    rightWrist: kp(0.44, wristY),
    leftHip: kp(0.57, 0.68, hips),
    rightHip: kp(0.43, 0.68, hips),
  };
}

const GUARD = pose(0.36);
const HANDS_DOWN = pose(0.64);

/** Feeds `p` every 50 ms for `ms`, starting at `t0`. Returns the end time. */
function feed(c: FirstRunCoach, p: PoseFrame | null, t0: number, ms: number): number {
  let t = t0;
  for (; t <= t0 + ms; t += 50) c.update(p, null, t);
  return t;
}

describe("first-run checks", () => {
  it("needs the hips in view, not just the shoulders", () => {
    expect(wellFramed(GUARD, null)).toBe(true);
    expect(wellFramed(pose(0.36, 0.1), null)).toBe(false);
  });

  it("defers to the framing coach", () => {
    expect(wellFramed(GUARD, "tooDark")).toBe(false);
    expect(wellFramed(null, null)).toBe(false);
  });

  it("uses the fight's own guard rule", () => {
    expect(guardIsUp(GUARD)).toBe(true);
    expect(guardIsUp(HANDS_DOWN)).toBe(false);
  });
});

describe("FirstRunCoach", () => {
  it("walks frame, guard, punch, ready - each confirmed by the camera", () => {
    const c = new FirstRunCoach();
    let t = feed(c, HANDS_DOWN, 0, FIRST_RUN_CONFIG.frameHoldMs);
    expect(c.step).toBe("guard");
    t = feed(c, GUARD, t, FIRST_RUN_CONFIG.guardHoldMs);
    expect(c.step).toBe("punch");
    c.strike("left");
    expect(c.step).toBe("punch");
    c.strike("left");
    expect(c.step).toBe("punch");
    c.strike("right");
    expect(c.step).toBe("ready");
  });

  it("restarts a hold that is broken partway", () => {
    const c = new FirstRunCoach();
    let t = feed(c, GUARD, 0, FIRST_RUN_CONFIG.frameHoldMs - 200);
    t = feed(c, null, t, 100);
    t = feed(c, GUARD, t, FIRST_RUN_CONFIG.frameHoldMs - 200);
    expect(c.step).toBe("frame");
    feed(c, GUARD, t, 300);
    expect(c.step).toBe("guard");
  });

  it("ignores punches thrown before the punch step", () => {
    const c = new FirstRunCoach();
    c.strike("left");
    c.strike("right");
    expect(c.step).toBe("frame");
    expect(c.hands.size).toBe(0);
  });
});

describe("shouldShowFirstRun", () => {
  const store = (v: string | null) => ({ getItem: () => v });

  it("shows once per browser", () => {
    expect(shouldShowFirstRun("", store(null))).toBe(true);
    expect(shouldShowFirstRun("", store("done"))).toBe(false);
  });

  it("can be forced on or off from the address", () => {
    expect(shouldShowFirstRun("?firstrun=1", store("done"))).toBe(true);
    expect(shouldShowFirstRun("?firstrun=0", store(null))).toBe(false);
  });

  it("shows when storage throws, and marking done never throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(shouldShowFirstRun("", hostile)).toBe(true);
    expect(() => markFirstRunDone(hostile)).not.toThrow();
    expect(() => markFirstRunDone(null)).not.toThrow();
  });
});
