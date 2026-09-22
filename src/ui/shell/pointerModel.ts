import { torsoScaleOf, type PoseFrame } from "../../pose/poseTypes";
import { POINTER_CONFIG } from "../../config/tuning";

// Driving the menu with your hands.
//
// A camera cursor has no button, so it has to answer "did they mean that?" and
// can get it wrong two ways. A false press drops the player into a mode they
// did not choose - and in a boxing game their hands are up and moving
// constantly, so that is the default state of the input, not an edge case. A
// missed press costs a second and is obviously theirs to retry. This is tuned
// hard toward missing rather than firing.
//
// Four defences, separate because they fail separately:
//
//   Dwell       hand must stay on a target for dwellMs.
//   Steadiness  and stay still while it does; motion past steadyRadius
//               restarts it. Catches a hand moving slowly through a tile,
//               which dwell alone cannot tell from intent.
//   Re-arm      after a press the hand must leave before it can press again.
//               Stops one dwell firing repeatedly because the hand is, quite
//               naturally, still there.
//   Settle      a short window on entering a target where dwell does not
//               accumulate, so a fast hand overshooting onto a neighbour does
//               not immediately start arming it.
//
// Positions are measured relative to the shoulders and divided by torso scale,
// like the rest of perception. Raw image coordinates would make the cursor's
// reach depend on how far away the player sat.

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


/**
 * Maps a pose frame to a raw cursor position, before any smoothing.
 *
 * Returns null when neither hand is usable, which the caller must render as
 * "no pointer" rather than as a cursor parked at the last position - a stale
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

  // The higher hand drives, which is how people actually point - and in this
  // game the raised hand is the one deliberately out of guard. Picking a fixed
  // hand would force right-handed use; picking the more confident one would
  // make the cursor jump between hands as tracking fluttered.
  const candidates = [
    { kp: pose.rightWrist, hand: "right" as PointerHand },
    { kp: pose.leftWrist, hand: "left" as PointerHand },
  ].filter((c) => c.kp.confidence >= minConfidence);
  if (candidates.length === 0) return null;
  // Image y grows downward, so the higher hand is the smaller y.
  const best = candidates.reduce((a, b) => (b.kp.y < a.kp.y ? b : a));

  const dx = (best.kp.x - shoulderMidX) / scale.value;
  const dy = (best.kp.y - shoulderMidY) / scale.value;

  // Map the reach box onto the screen. The player's camera image is mirrored
  // for display, so moving the right hand right must move the cursor right:
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
   * `pose` may be null, meaning tracking is lost - which is not the same as
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
   * knows which of the four defences held the dwell back on this frame, and
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
