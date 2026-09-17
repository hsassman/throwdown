import { torsoScaleOf, type PoseFrame } from "../../pose/poseTypes";
import { POINTER_CONFIG } from "../../config/tuning";

// Driving the menu with your hands.
// THE PROBLEM THIS IS ACTUALLY SOLVING
//
// A camera cursor has no button. Every gesture interface has to answer one
// question — "did they mean that?" — and gets it wrong in two directions:
//
//   FALSE PRESS. The player scratches their nose, rests a hand, or drifts
//   across a tile while reaching for their coffee, and the menu fires. In a
//   boxing game the player's hands are up and moving CONSTANTLY, so this is
//   not an edge case; it is the default state of the input.
//
//   MISSED PRESS. The confirmation is so guarded that the player waves at the
//   screen and nothing happens, which reads as the tracking being broken.
//
// The project owner asked specifically to "avoid accidental button presses
// entirely", so this is tuned toward the second failure. A missed press costs
// a second and is obviously the player's move to retry; a false press drops
// them into a mode they did not choose and may not know how to leave.
// FOUR INDEPENDENT DEFENCES, EACH FOR A DIFFERENT FALSE PRESS
//
// 1. DWELL. The hand must stay on a target for `dwellMs`. Stops anything that
//    merely passes over a tile.
//
// 2. STEADINESS. It must stay still while dwelling — motion beyond
//    `steadyRadius` restarts the dwell. Stops a hand that happens to be moving
//    THROUGH a tile slowly, which pure dwell cannot distinguish from intent.
//
// 3. RE-ARM. After a press, the hand must LEAVE the target before it can press
//    anything again. Stops the single most common gesture-UI failure: one
//    dwell firing repeatedly because the hand is, naturally, still there.
//
// 4. SETTLE. On entering a target, a short window during which dwell does not
//    accumulate at all. Stops a fast hand overshooting onto a neighbour and
//    immediately beginning to arm it.
//
// Dwell alone gives none of the other three. They are separate mechanisms
// because they fail separately, and a single combined timer cannot express
// "moved away and came back" at all.
// WHY NORMALISED BY THE TORSO, AND NOT BY THE IMAGE
//
// The hand's position is measured RELATIVE TO THE SHOULDERS and divided by the
// torso scale — the same normalisation the whole perception layer uses. Raw
// image coordinates would mean the cursor's reach depended on how far the
// player was sitting from the camera: stand back and the menu becomes
// unreachable, lean in and a twitch crosses the whole screen.

export type PointerHand = "left" | "right";

export interface PointerState {
  /** Cursor position in normalised screen space, 0..1, or null when not tracked. */
  x: number;
  y: number;
  /** Which hand is driving. */
  hand: PointerHand;
  /** True when the pointer has a usable reading this frame. */
  tracked: boolean;
  /** The target the pointer is over, or null. */
  hoverId: string | null;
  /** 0..1 progress toward a confirm on the hovered target. */
  progress: number;
  /** True for exactly the frame a press fires. */
  pressed: string | null;
  /**
   * Why the pointer is not arming, when it is over a target but not filling.
   * Surfaced so the UI can say "hold still" rather than appearing broken.
   */
  reason: "moving" | "settling" | "rearm" | null;
}

/** A rectangle a pointer can activate, in normalised screen space. */
export interface PointerTarget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Locked targets hover but never arm. */
  disabled?: boolean;
}

export const IDLE: PointerState = {
  x: 0.5,
  y: 0.5,
  hand: "right",
  tracked: false,
  hoverId: null,
  progress: 0,
  pressed: null,
  reason: null,
};

/**
 * Maps a pose frame to a raw cursor position, before any smoothing.
 *
 * Returns null when neither hand is usable, which the caller must render as
 * "no pointer" rather than as a cursor parked at the last position — a stale
 * cursor sitting on a tile is precisely the state that dwell would then
 * happily confirm.
 */
export function cursorFromPose(
  pose: PoseFrame,
  minConfidence = POINTER_CONFIG.minConfidence
): { x: number; y: number; hand: PointerHand } | null {
  const scale = torsoScaleOf(pose, minConfidence);
  if (!scale) return null;

  const shoulderMidX = (pose.leftShoulder.x + pose.rightShoulder.x) / 2;
  const shoulderMidY = (pose.leftShoulder.y + pose.rightShoulder.y) / 2;

  // The HIGHER hand drives, which is how people actually point — and in this
  // game the raised hand is the one deliberately out of guard. Picking a fixed
  // hand would force right-handed use; picking the more confident one would
  // make the cursor jump between hands as tracking fluttered.
  const candidates = [
    { kp: pose.rightWrist, hand: "right" as PointerHand },
    { kp: pose.leftWrist, hand: "left" as PointerHand },
  ].filter((c) => c.kp.confidence >= minConfidence);
  if (candidates.length === 0) return null;
  // Image y grows downward, so the higher hand is the SMALLER y.
  const best = candidates.reduce((a, b) => (b.kp.y < a.kp.y ? b : a));

  const dx = (best.kp.x - shoulderMidX) / scale.value;
  const dy = (best.kp.y - shoulderMidY) / scale.value;

  // Map the reach box onto the screen. The player's camera image is mirrored
  // for display, so moving the RIGHT hand right must move the cursor right:
  // the x term is negated to undo the mirror. Getting this backwards makes the
  // menu feel possessed, and it is invisible in a static screenshot.
  const { reachX, reachY, restY } = POINTER_CONFIG;
  const x = 0.5 - dx / (2 * reachX);
  const y = 0.5 + (dy - restY) / (2 * reachY);

  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    hand: best.hand,
  };
}

/** The target containing a point, or null. Later targets win an overlap. */
export function targetAt(
  targets: readonly PointerTarget[],
  x: number,
  y: number
): PointerTarget | null {
  let found: PointerTarget | null = null;
  for (const t of targets) {
    if (x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) found = t;
  }
  return found;
}

/**
 * The pointer state machine.
 *
 * Time is injected on every call, for the same reason the drill injects it:
 * a dwell timer that reads the clock itself can only be tested by sleeping,
 * and the interesting cases are all about exact millisecond boundaries.
 */
export class CameraPointer {
  private x = 0.5;
  private y = 0.5;
  private hand: PointerHand = "right";
  private tracked = false;

  private hoverId: string | null = null;
  /** When the current hover began. */
  private enteredAt = 0;
  /** When the dwell last restarted because the hand moved. */
  private steadyFrom = 0;
  /** Where the hand was when the dwell last restarted. */
  private anchorX = 0.5;
  private anchorY = 0.5;
  /**
   * A target that has just been pressed and may not be pressed again until the
   * pointer leaves it.
   */
  private armedOut: string | null = null;
  private lastPressed: string | null = null;

  /** Resets everything. Called when a screen changes under the pointer. */
  reset(): void {
    this.hoverId = null;
    this.armedOut = null;
    this.lastPressed = null;
    this.tracked = false;
    this.progressCache = 0;
  }

  private progressCache = 0;

  /**
   * Feeds one pose frame.
   *
   * `pose` may be null, meaning tracking is lost — which is NOT the same as
   * the hand being still, and must abandon any dwell in progress.
   */
  update(
    pose: PoseFrame | null,
    targets: readonly PointerTarget[],
    now: number
  ): PointerState {
    const raw = pose ? cursorFromPose(pose) : null;

    if (!raw) {
      // Tracking lost. Drop the hover outright rather than freezing it: a
      // frozen cursor sitting on a tile is exactly what dwell would confirm,
      // so "the player walked away" would press a button.
      this.tracked = false;
      this.hoverId = null;
      this.progressCache = 0;
      this.lastPressed = null;
      return this.snapshot(null, null);
    }

    // Exponential smoothing. Hand landmarks are the noisiest in the set, and
    // an unsmoothed cursor is unusable for a target the size of a menu row.
    const a = POINTER_CONFIG.smoothing;
    if (!this.tracked) {
      // First good frame after a dropout: jump, do not glide. Easing in from a
      // stale position drags the cursor across every tile in between, arming
      // each one on the way.
      this.x = raw.x;
      this.y = raw.y;
    } else {
      this.x += (raw.x - this.x) * a;
      this.y += (raw.y - this.y) * a;
    }
    this.hand = raw.hand;
    this.tracked = true;

    const target = targetAt(targets, this.x, this.y);
    const id = target?.id ?? null;

    if (id !== this.hoverId) {
      this.hoverId = id;
      this.enteredAt = now;
      this.steadyFrom = now;
      this.anchorX = this.x;
      this.anchorY = this.y;
      this.progressCache = 0;
      // Defence 3: leaving the pressed target re-arms it.
      if (this.armedOut && id !== this.armedOut) this.armedOut = null;
    }

    this.lastPressed = null;

    if (!target || target.disabled) {
      this.progressCache = 0;
      return this.snapshot(target ?? null, null);
    }

    // Defence 2: steadiness. Drifting beyond the radius restarts the dwell.
    const drift = Math.hypot(this.x - this.anchorX, this.y - this.anchorY);
    if (drift > POINTER_CONFIG.steadyRadius) {
      this.steadyFrom = now;
      this.anchorX = this.x;
      this.anchorY = this.y;
      this.progressCache = 0;
      return this.snapshot(target, "moving");
    }

    // Defence 4: settle. Dwell does not begin accumulating the instant the
    // cursor arrives.
    const settled = now - this.enteredAt >= POINTER_CONFIG.settleMs;
    if (!settled) return this.snapshot(target, "settling");

    // Defence 3 again: still waiting to leave after a press.
    if (this.armedOut === target.id) return this.snapshot(target, "rearm");

    const held = now - Math.max(this.steadyFrom, this.enteredAt + POINTER_CONFIG.settleMs);
    this.progressCache = Math.max(0, Math.min(1, held / POINTER_CONFIG.dwellMs));

    if (this.progressCache >= 1) {
      this.lastPressed = target.id;
      this.armedOut = target.id;
      this.progressCache = 0;
    }
    return this.snapshot(target, null);
  }

  /**
   * `reason` is passed in rather than re-derived here, because only the caller
   * knows WHICH of the four defences held the dwell back on this frame, and
   * the whole point of surfacing it is to tell the player what to do about it.
   */
  private snapshot(
    target: PointerTarget | null,
    reason: PointerState["reason"] = null
  ): PointerState {
    void target;
    return {
      x: this.x,
      y: this.y,
      hand: this.hand,
      tracked: this.tracked,
      hoverId: this.hoverId,
      progress: this.progressCache,
      pressed: this.lastPressed,
      reason,
    };
  }
}
