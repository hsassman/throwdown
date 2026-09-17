import { describe, it, expect } from "vitest";
import {
  CameraPointer,
  cursorFromPose,
  targetAt,
  type PointerTarget,
} from "./pointerModel";
import { POINTER_CONFIG } from "../../config/tuning";
import { POSE_KEYS, type PoseFrame, type PoseKey } from "../../pose/poseTypes";

// The pointer is the only way into the game once the menu is camera-driven, so
// these tests are weighted toward the ways it could fire when the player did
// not mean it.

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

/** A pose with the named wrists moved to absolute image positions. */
function pose(
  overrides: Partial<Record<PoseKey, { x: number; y: number; confidence?: number }>> = {},
  timestamp = 0
): PoseFrame {
  const f: Record<string, unknown> = { timestamp };
  for (const k of POSE_KEYS) {
    const o = overrides[k];
    f[k] = {
      x: o?.x ?? BASE[k].x,
      y: o?.y ?? BASE[k].y,
      z: 0,
      confidence: o?.confidence ?? 0.95,
    };
  }
  return f as unknown as PoseFrame;
}

/**
 * A pose whose driving hand lands the cursor on a given screen position.
 *
 * Inverts `cursorFromPose` rather than guessing coordinates, so the tests are
 * about the state machine and not about arithmetic in the test file.
 */
function poseAtCursor(sx: number, sy: number, timestamp = 0): PoseFrame {
  const torso = Math.hypot(0.5 - 0.5, 0.4 - 0.7); // 0.30, shoulder-to-hip
  const { reachX, reachY, restY } = POINTER_CONFIG;
  const dx = (0.5 - sx) * 2 * reachX;
  const dy = (sy - 0.5) * 2 * reachY + restY;
  const wrist = { x: 0.5 + dx * torso, y: 0.4 + dy * torso };
  // Right wrist raised above the left so it is the one that drives.
  return pose({ rightWrist: wrist, leftWrist: { x: 0.6, y: 0.95 } }, timestamp);
}

const TARGETS: PointerTarget[] = [
  { id: "a", x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
  { id: "b", x: 0.1, y: 0.4, w: 0.3, h: 0.2 },
  { id: "locked", x: 0.6, y: 0.1, w: 0.3, h: 0.2, disabled: true },
];

/** Holds the cursor on a spot for `ms`, returning the last state. */
function hold(p: CameraPointer, sx: number, sy: number, from: number, ms: number) {
  let last = p.update(poseAtCursor(sx, sy, from), TARGETS, from);
  for (let t = from + 16; t <= from + ms; t += 16) {
    last = p.update(poseAtCursor(sx, sy, t), TARGETS, t);
    if (last.pressed) return { state: last, at: t };
  }
  return { state: last, at: from + ms };
}

describe("cursor mapping", () => {
  it("refuses to produce a cursor when the wrists are not tracked", () => {
    const p = pose({
      leftWrist: { x: 0.6, y: 0.62, confidence: 0.1 },
      rightWrist: { x: 0.4, y: 0.62, confidence: 0.1 },
    });
    expect(cursorFromPose(p)).toBeNull();
  });

  it("refuses when there is no torso reference to normalise against", () => {
    const p = pose({
      leftShoulder: { x: 0.58, y: 0.4, confidence: 0.1 },
      rightShoulder: { x: 0.42, y: 0.4, confidence: 0.1 },
    });
    expect(cursorFromPose(p)).toBeNull();
  });

  it("is driven by the HIGHER hand", () => {
    const rightUp = pose({
      rightWrist: { x: 0.4, y: 0.2 },
      leftWrist: { x: 0.6, y: 0.8 },
    });
    expect(cursorFromPose(rightUp)!.hand).toBe("right");
    const leftUp = pose({
      rightWrist: { x: 0.4, y: 0.8 },
      leftWrist: { x: 0.6, y: 0.2 },
    });
    expect(cursorFromPose(leftUp)!.hand).toBe("left");
  });

  it("moves the cursor the SAME way as the hand, through the mirror", () => {
    // The camera image is mirrored for display. If this is inverted the menu
    // feels possessed, and it is completely invisible in a screenshot.
    const centre = cursorFromPose(pose({ rightWrist: { x: 0.5, y: 0.3 } }))!;
    const handRight = cursorFromPose(pose({ rightWrist: { x: 0.2, y: 0.3 } }))!;
    // A mirrored view means the player's right hand appears at a SMALLER image
    // x, and must drive the cursor to a LARGER screen x.
    expect(handRight.x).toBeGreaterThan(centre.x);
  });

  it("is unaffected by how far the player stands from the camera", () => {
    // Raw image coordinates would make the menu unreachable from across the
    // room and hair-trigger up close.
    const near = cursorFromPose(
      pose({
        leftShoulder: { x: 0.7, y: 0.3 },
        rightShoulder: { x: 0.3, y: 0.3 },
        leftHip: { x: 0.65, y: 0.9 },
        rightHip: { x: 0.35, y: 0.9 },
        rightWrist: { x: 0.3, y: 0.3 },
        leftWrist: { x: 0.7, y: 0.9 },
      })
    )!;
    const far = cursorFromPose(
      pose({
        leftShoulder: { x: 0.55, y: 0.45 },
        rightShoulder: { x: 0.45, y: 0.45 },
        leftHip: { x: 0.54, y: 0.6 },
        rightHip: { x: 0.46, y: 0.6 },
        rightWrist: { x: 0.45, y: 0.45 },
        leftWrist: { x: 0.55, y: 0.75 },
      })
    )!;
    // Same gesture (hand out at the shoulder), very different framing.
    expect(far.x).toBeCloseTo(near.x, 1);
  });

  it("stays on screen however far the hand reaches", () => {
    for (const x of [-2, 0, 0.5, 1, 3]) {
      const c = cursorFromPose(pose({ rightWrist: { x, y: 0.1 } }))!;
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(1);
    }
  });
});

describe("hit testing", () => {
  it("finds the target under a point, and nothing in the gaps", () => {
    expect(targetAt(TARGETS, 0.2, 0.15)!.id).toBe("a");
    expect(targetAt(TARGETS, 0.2, 0.45)!.id).toBe("b");
    expect(targetAt(TARGETS, 0.2, 0.35)).toBeNull();
    expect(targetAt(TARGETS, 0.95, 0.95)).toBeNull();
  });
});

describe("confirming a press", () => {
  it("fires after the full dwell, and not before", () => {
    const p = new CameraPointer();
    const early = hold(p, 0.25, 0.2, 0, POINTER_CONFIG.dwellMs - 100);
    expect(early.state.pressed).toBeNull();
    expect(early.state.progress).toBeGreaterThan(0.5);

    const p2 = new CameraPointer();
    const done = hold(p2, 0.25, 0.2, 0, POINTER_CONFIG.dwellMs + POINTER_CONFIG.settleMs + 100);
    expect(done.state.pressed).toBe("a");
  });

  it("reports progress so the ring can be drawn", () => {
    const p = new CameraPointer();
    const half = hold(p, 0.25, 0.2, 0, POINTER_CONFIG.settleMs + POINTER_CONFIG.dwellMs / 2);
    expect(half.state.progress).toBeGreaterThan(0.3);
    expect(half.state.progress).toBeLessThan(0.7);
    expect(half.state.hoverId).toBe("a");
  });

  it("never arms a disabled target", () => {
    const p = new CameraPointer();
    const out = hold(p, 0.75, 0.2, 0, POINTER_CONFIG.dwellMs * 3);
    expect(out.state.hoverId).toBe("locked");
    expect(out.state.progress).toBe(0);
    expect(out.state.pressed).toBeNull();
  });
});

describe("defences against an accidental press", () => {
  it("1. DWELL: a hand passing across a target does not fire it", () => {
    const p = new CameraPointer();
    let fired: string | null = null;
    // Sweep right across both rows in a third of a dwell.
    for (let i = 0; i <= 20; i++) {
      const t = i * 16;
      const s = p.update(poseAtCursor(0.05 + i * 0.045, 0.2, t), TARGETS, t);
      if (s.pressed) fired = s.pressed;
    }
    expect(fired).toBeNull();
  });

  it("2. STEADINESS: a slow drift across a target restarts the dwell", () => {
    // The case pure dwell cannot catch. The hand is inside the tile for longer
    // than the dwell, but it never stops moving — a reach for a drink, not a
    // press.
    const p = new CameraPointer();
    let fired: string | null = null;
    const drift = POINTER_CONFIG.steadyRadius * 0.9;
    let x = 0.15;
    for (let t = 0; t <= POINTER_CONFIG.dwellMs * 2.5; t += 16) {
      // Move by just under the steady radius every few frames: enough to keep
      // resetting, slow enough to stay inside the tile the whole time.
      if (t % 64 === 0) x += drift;
      if (x > 0.38) x = 0.15;
      const s = p.update(poseAtCursor(x, 0.2, t), TARGETS, t);
      if (s.pressed) fired = s.pressed;
    }
    expect(fired).toBeNull();
  });

  it("2b. tells the player WHY it is not filling", () => {
    // A ring that silently refuses to fill reads as broken tracking.
    const p = new CameraPointer();
    let sawMoving = false;
    let x = 0.15;
    for (let t = 0; t <= 800; t += 16) {
      x += POINTER_CONFIG.steadyRadius * 1.2;
      if (x > 0.38) x = 0.15;
      const s = p.update(poseAtCursor(x, 0.2, t), TARGETS, t);
      if (s.reason === "moving") sawMoving = true;
    }
    expect(sawMoving).toBe(true);
  });

  it("3. RE-ARM: holding still after a press does NOT fire it again", () => {
    // The single most common gesture-UI failure. The hand is naturally still
    // on the target it just pressed, so a naive dwell fires it over and over.
    const p = new CameraPointer();
    let presses = 0;
    for (let t = 0; t <= POINTER_CONFIG.dwellMs * 6; t += 16) {
      const s = p.update(poseAtCursor(0.25, 0.2, t), TARGETS, t);
      if (s.pressed) presses += 1;
    }
    expect(presses).toBe(1);
  });

  it("3b. re-arms once the hand leaves and comes back", () => {
    const p = new CameraPointer();
    let presses = 0;
    let t = 0;
    const run = (sx: number, sy: number, ms: number) => {
      for (let i = 0; i < ms; i += 16, t += 16) {
        const s = p.update(poseAtCursor(sx, sy, t), TARGETS, t);
        if (s.pressed) presses += 1;
      }
    };
    run(0.25, 0.2, POINTER_CONFIG.dwellMs * 2);
    expect(presses).toBe(1);
    run(0.25, 0.5, POINTER_CONFIG.dwellMs * 2); // to the other tile
    run(0.25, 0.2, POINTER_CONFIG.dwellMs * 2); // and back
    expect(presses).toBe(3);
  });

  it("4. SETTLE: dwell does not begin the instant the cursor lands", () => {
    const p = new CameraPointer();
    const s = p.update(poseAtCursor(0.25, 0.2, 0), TARGETS, 0);
    expect(s.progress).toBe(0);
    const s2 = p.update(poseAtCursor(0.25, 0.2, POINTER_CONFIG.settleMs / 2), TARGETS, POINTER_CONFIG.settleMs / 2);
    expect(s2.progress).toBe(0);
    expect(s2.reason).toBe("settling");
  });

  it("5. LOST TRACKING: a player who walks away presses nothing", () => {
    // The nastiest one. If the cursor froze on its last position instead of
    // being dropped, dwell would happily confirm whatever it was resting on.
    const p = new CameraPointer();
    let fired: string | null = null;
    for (let t = 0; t <= 400; t += 16) {
      p.update(poseAtCursor(0.25, 0.2, t), TARGETS, t);
    }
    for (let t = 400; t <= POINTER_CONFIG.dwellMs * 4; t += 16) {
      const s = p.update(null, TARGETS, t);
      if (s.pressed) fired = s.pressed;
      expect(s.tracked).toBe(false);
      expect(s.hoverId).toBeNull();
    }
    expect(fired).toBeNull();
  });

  it("6. RE-ACQUIRE: the cursor jumps rather than sliding over every tile", () => {
    // Easing in from a stale position drags the cursor across the tiles in
    // between, arming each one on the way.
    const p = new CameraPointer();
    for (let t = 0; t <= 300; t += 16) p.update(poseAtCursor(0.25, 0.2, t), TARGETS, t);
    for (let t = 300; t <= 600; t += 16) p.update(null, TARGETS, t);
    const back = p.update(poseAtCursor(0.85, 0.85, 616), TARGETS, 616);
    expect(back.x).toBeCloseTo(0.85, 1);
    expect(back.y).toBeCloseTo(0.85, 1);
  });
});

describe("reset", () => {
  it("clears a dwell in progress when the screen changes underneath", () => {
    const p = new CameraPointer();
    for (let t = 0; t <= 600; t += 16) p.update(poseAtCursor(0.25, 0.2, t), TARGETS, t);
    p.reset();
    const s = p.update(poseAtCursor(0.25, 0.2, 616), TARGETS, 616);
    expect(s.progress).toBe(0);
    expect(s.pressed).toBeNull();
  });
});
