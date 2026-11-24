import { FIGHT_CONFIG, FIRST_RUN_CONFIG, PERCEPTION_CONFIG } from "../config/tuning";
import { guardHeightOf } from "../perception/bodyMotion";
import type { FramingIssue } from "../perception/framingCheck";
import type { HandSide } from "../perception/punchTypes";
import { torsoScaleOf, type PoseFrame } from "../pose/poseTypes";

// The first-run walkthrough, as a step machine with no React and no DOM.
//
// A new player arrives at a menu they are meant to drive with their hand, in
// a game that needs them a couple of metres back with their hips in view. The
// menu cannot teach that - by the time it works, the lesson has been learned.
// So three things, in order, each one confirmed by the camera rather than by a
// "Next" button: stand where you can be seen, guard up, throw one with each
// hand. A step that the camera has confirmed is the only proof the player has
// that the tracking works on their machine, in their room.
//
// Nothing here has its own idea of a guard or a punch. The guard is the
// fight's own rule (guardHeightOf against FIGHT_CONFIG.guardHighEnter) and
// the punches come from the one StrikeResolver, so what the walkthrough
// accepts is exactly what a fight will count.

export type FirstRunStep = "frame" | "guard" | "punch" | "ready";

export const FIRST_RUN_STEPS: readonly FirstRunStep[] = ["frame", "guard", "punch", "ready"];

export const FIRST_RUN_TEXT: Record<FirstRunStep, { title: string; body: string }> = {
  frame: {
    title: "Step back",
    body: "Stand where the camera can see you from your head to your hips, both hands in view.",
  },
  guard: {
    title: "Guard up",
    body: "Raise both hands to your chin and hold them there.",
  },
  punch: {
    title: "Throw a punch with each hand",
    body: "Throw one straight punch with your left hand, then one with your right.",
  },
  ready: {
    title: "You're set",
    body: "To choose from the menu, hold a hand over a row until it fills. Free Work is a good place to start.",
  },
};

/** True when the camera sees the whole of what the game needs. */
export function wellFramed(pose: PoseFrame | null, issue: FramingIssue | null): boolean {
  if (!pose || issue !== null) return false;
  const min = PERCEPTION_CONFIG.minLandmarkConfidence;
  // Hips, not just shoulders: the depth, crouch and guard channels all read
  // against the hip line, and the framing coach waits before it complains.
  if (torsoScaleOf(pose, min)?.source !== "shoulder-hip") return false;
  return pose.leftWrist.confidence >= min && pose.rightWrist.confidence >= min;
}

/** The fight's own high-guard test. */
export function guardIsUp(pose: PoseFrame | null): boolean {
  if (!pose) return false;
  const torso = torsoScaleOf(pose, PERCEPTION_CONFIG.minLandmarkConfidence);
  if (!torso) return false;
  return guardHeightOf(pose, torso.value) >= FIGHT_CONFIG.guardHighEnter;
}

export class FirstRunCoach {
  step: FirstRunStep = "frame";
  /** Which hands have landed a strike during the punch step. */
  readonly hands = new Set<HandSide>();
  private heldSince: number | null = null;

  /** Feeds one pose sample. Returns the step after it. */
  update(pose: PoseFrame | null, issue: FramingIssue | null, now: number): FirstRunStep {
    if (this.step === "frame") this.hold(wellFramed(pose, issue), now, FIRST_RUN_CONFIG.frameHoldMs, "guard");
    else if (this.step === "guard") this.hold(guardIsUp(pose), now, FIRST_RUN_CONFIG.guardHoldMs, "punch");
    return this.step;
  }

  /** A strike the resolver registered. Counts only during the punch step, so
   *  a hand waved while stepping back does not tick it off early. */
  strike(hand: HandSide): FirstRunStep {
    if (this.step !== "punch") return this.step;
    this.hands.add(hand);
    if (this.hands.size === 2) this.step = "ready";
    return this.step;
  }

  private hold(ok: boolean, now: number, ms: number, next: FirstRunStep): void {
    if (!ok) {
      this.heldSince = null;
      return;
    }
    this.heldSince ??= now;
    if (now - this.heldSince >= ms) {
      this.step = next;
      this.heldSince = null;
    }
  }
}

/**
 * Whether to show the walkthrough. `?firstrun=1` forces it, `?firstrun=0`
 * suppresses it (measurement tools, demos); otherwise once per browser.
 * Storage that throws (private mode, blocked site data) shows it - a repeat
 * walkthrough is a smaller cost than a lost new player.
 */
export function shouldShowFirstRun(search: string, storage: Pick<Storage, "getItem"> | null): boolean {
  const forced = new URLSearchParams(search).get("firstrun");
  if (forced === "1") return true;
  if (forced === "0") return false;
  try {
    return storage?.getItem(FIRST_RUN_CONFIG.storageKey) !== "done";
  } catch {
    return true;
  }
}

export function markFirstRunDone(storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(FIRST_RUN_CONFIG.storageKey, "done");
  } catch {
    // Not remembered; it shows again next visit.
  }
}
