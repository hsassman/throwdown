// What a punch should FEEL like, separate from what it IS.
//
// The fight sim decides whether a punch landed, was blocked or slipped. This
// file only turns those decisions into feedback - a camera kick, a word on
// screen, a red flash when you are hit - so a landed punch reads as landed
// the instant it happens. Nothing here feeds back into hit detection or
// scoring; it only reads the sim's events.

import type { FightEvent } from "./fightState";
import type { PunchKind } from "../perception/strikeResolver";

export type ImpactKind =
  /** Your punch landed. */
  | "landed"
  /** Your punch hit their guard. */
  | "blocked"
  /** They slipped or ducked your punch. */
  | "evaded"
  /** Their punch landed on you. */
  | "taken"
  /** You blocked their punch. */
  | "defended"
  /** You slipped or ducked their punch. */
  | "slipped";

export interface Impact {
  kind: ImpactKind;
  /** 0-1. For landed/taken, the strike's power; otherwise a fixed light value. */
  power: number;
  /** performance.now() when it happened. */
  at: number;
  /** Increasing id, so several readers can each track what they've seen. */
  seq: number;
  /** The punch type, for a punch that landed, when the strike carried one. */
  punch?: PunchKind;
}

/** Maps a sim event to an impact from the player's point of view, or null
 *  for events that aren't about a punch arriving. */
export function impactKind(e: FightEvent, playerId: string): ImpactKind | null {
  const onPlayer = "target" in e && e.target === playerId;
  switch (e.type) {
    case "land":
      return onPlayer ? "taken" : "landed";
    case "block":
      return onPlayer ? "defended" : "blocked";
    case "miss":
      return onPlayer ? "slipped" : "evaded";
    default:
      return null;
  }
}

/**
 * Turns the sim's events into impacts, one per punch.
 *
 * The sim reports a blocked punch as two events: "block", then "land" with
 * the reduced damage (the damage is real, so scoring needs it). Mapped one by
 * one, a blocked punch became both "defended" and "taken" - the red flash and
 * the big hit shake fired on a punch you had blocked, and hitting the
 * opponent's guard showed "Blocked" alongside a landed hit. This drops the
 * "land" that belongs to a block, so a blocked punch only ever reads as a
 * block.
 */
export class ImpactClassifier {
  private blockedTarget: string | null = null;

  kind(e: FightEvent, playerId: string): ImpactKind | null {
    if (e.type === "block") {
      this.blockedTarget = e.target;
    } else if (e.type === "land") {
      const wasBlocked = this.blockedTarget === e.target;
      this.blockedTarget = null;
      if (wasBlocked) return null;
    } else if (e.type === "miss") {
      this.blockedTarget = null;
    }
    return impactKind(e, playerId);
  }
}

/** Power for an event: the punch's own power when it landed, otherwise light. */
export function impactPower(e: FightEvent): number {
  if (e.type === "land") return Math.max(0, Math.min(1, e.power));
  return 0.3;
}

/** Camera kick for an impact: peak offset in world units and how long it lasts. */
export function shakeFor(impact: Pick<Impact, "kind" | "power">): { amplitude: number; duration: number } {
  switch (impact.kind) {
    case "landed":
      // Felt, not seen: a jab nudges the view, a power shot jolts it.
      return { amplitude: 0.006 + 0.02 * impact.power, duration: 0.12 + 0.1 * impact.power };
    case "taken":
      // Being hit should be unmistakable.
      return { amplitude: 0.015 + 0.035 * impact.power, duration: 0.18 + 0.14 * impact.power };
    case "blocked":
    case "defended":
      return { amplitude: 0.005, duration: 0.08 };
    default:
      return { amplitude: 0, duration: 0 };
  }
}

/**
 * Hit-stop: how long the struck figure freezes when a punch lands, seconds.
 *
 * The standard trick fighting games use to make contact read as contact - a
 * few frames where the struck figure holds still sell the weight of the blow
 * better than any amount of recoil. Scaled with power, and zero for anything
 * that did not land: a frozen frame on a blocked jab would read as lag.
 */
export function hitStopFor(impact: Pick<Impact, "kind" | "power">): number {
  if (impact.kind !== "landed" && impact.kind !== "taken") return 0;
  if (impact.power < 0.45) return 0;
  return 0.03 + 0.06 * impact.power;
}

/**
 * A playback rate for the fight's figures, for hit-stop and the slow-motion
 * knockdown.
 *
 * Render time only. The simulation, the round clock and hit detection all
 * keep running in real time - this changes how fast the bodies are drawn
 * moving, never what happened. The player's own figure is not slowed either:
 * it follows the player's real body, and freezing it would feel exactly like
 * input lag.
 */
export class TimeWarp {
  private stopUntil = -Infinity;
  private slowFrom = -Infinity;
  private slowUntil = -Infinity;
  private slowRate = 1;

  /** Freezes the figures for `seconds` from `now` (ms). A longer stop
   *  already running is not cut short. */
  hitStop(now: number, seconds: number): void {
    if (seconds <= 0) return;
    this.stopUntil = Math.max(this.stopUntil, now + seconds * 1000);
  }

  /** Plays the figures at `rate` for `seconds`, easing back to full speed
   *  over the last third so the return is not a jolt. */
  slowMotion(now: number, seconds: number, rate: number): void {
    this.slowFrom = now;
    this.slowUntil = now + seconds * 1000;
    this.slowRate = Math.min(1, Math.max(0.05, rate));
  }

  /** The playback rate at `now` (ms): 0 frozen, 1 real time. */
  rate(now: number): number {
    if (now < this.stopUntil) return 0;
    if (now >= this.slowUntil) return 1;
    const span = this.slowUntil - this.slowFrom;
    const easeStart = this.slowUntil - span / 3;
    if (now < easeStart) return this.slowRate;
    const u = (now - easeStart) / (this.slowUntil - easeStart);
    return this.slowRate + (1 - this.slowRate) * u;
  }

  reset(): void {
    this.stopUntil = this.slowFrom = this.slowUntil = -Infinity;
  }
}

/**
 * The camera offset at time `t` seconds into a shake. A decaying wobble on
 * two axes, deterministic for a given seed so it is testable and two shakes in
 * a row don't look identical.
 */
export function shakeOffset(
  t: number,
  amplitude: number,
  duration: number,
  seed: number
): { x: number; y: number } {
  if (t < 0 || t >= duration || amplitude <= 0) return { x: 0, y: 0 };
  const decay = 1 - t / duration;
  const a = amplitude * decay * decay;
  return {
    x: a * Math.sin(t * 95 + seed * 1.7),
    y: a * Math.cos(t * 83 + seed * 2.9),
  };
}

export interface Popup {
  text: string;
  tone: "good" | "bad" | "neutral";
  /** 0-2: how big the word is drawn. */
  size: 0 | 1 | 2;
}

/** The word shown for an impact, or null for none (being hit uses a flash). */
const PUNCH_WORD: Record<PunchKind, string> = {
  straight: "STRAIGHT!",
  hook: "HOOK!",
  uppercut: "UPPERCUT!",
};

export function popupFor(impact: Pick<Impact, "kind" | "power" | "punch">): Popup | null {
  switch (impact.kind) {
    case "landed":
      // Wii-style: say which punch landed, sized by how hard it was.
      if (impact.punch) {
        const size = impact.power >= 0.85 ? 2 : impact.power >= 0.6 ? 1 : 0;
        return { text: PUNCH_WORD[impact.punch], tone: "good", size };
      }
      if (impact.power >= 0.85) return { text: "HUGE!", tone: "good", size: 2 };
      if (impact.power >= 0.6) return { text: "HARD!", tone: "good", size: 1 };
      return { text: "HIT", tone: "good", size: 0 };
    case "blocked":
      return { text: "BLOCKED", tone: "neutral", size: 0 };
    case "evaded":
      return { text: "SLIPPED", tone: "neutral", size: 0 };
    case "defended":
      return { text: "BLOCK", tone: "good", size: 0 };
    case "slipped":
      return { text: "SLIP!", tone: "good", size: 1 };
    case "taken":
      return null;
  }
}

/** Keeps the most recent impacts for any number of readers. Readers keep
 *  the last `seq` they handled and ask for anything newer, so the camera and
 *  the HUD can both see every impact without draining each other's queue. */
/**
 * Rows, top offsets in % of the view, nearest the fighters first. 14% apart:
 * the largest word is up to 80px tall, and at 9% apart a "HARD!" still
 * clipped the "BLOCKED" under it on a 540px-high view. All below the fight
 * HUD - a row at 22% put words over the round clock.
 */
export const POPUP_LANES = [38, 52, 66];

/**
 * The first row no live word is using.
 *
 * Words used to be spread by a hash of their sequence number alone, which put
 * consecutive words a few vw apart - and "BLOCKED" followed 80ms later by
 * "HIT" printed as one unreadable "HITCKED", in nearly every exchange. A row
 * per live word cannot collide, however close together they arrive.
 */
export function freeLane(taken: number[]): number {
  for (let i = 0; i < POPUP_LANES.length; i++) if (!taken.includes(i)) return i;
  return 0;
}

export class ImpactLog {
  private items: Impact[] = [];
  private next = 1;

  push(kind: ImpactKind, power: number, at: number, punch?: PunchKind): Impact {
    const impact: Impact = { kind, power, at, seq: this.next++ };
    if (punch) impact.punch = punch;
    this.items.push(impact);
    if (this.items.length > 16) this.items.splice(0, this.items.length - 16);
    return impact;
  }

  since(seq: number): Impact[] {
    return this.items.filter((i) => i.seq > seq);
  }

  clear(): void {
    this.items.length = 0;
  }
}
