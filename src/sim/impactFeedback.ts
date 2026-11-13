// What a punch should FEEL like, separate from what it IS.
//
// The fight sim decides whether a punch landed, was blocked or slipped. This
// file only turns those decisions into feedback - a camera kick, a word on
// screen, a red flash when you are hit - so a landed punch reads as landed
// the instant it happens. Nothing here feeds back into hit detection or
// scoring; it only reads the sim's events.

import type { FightEvent } from "./fightState";

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
export function popupFor(impact: Pick<Impact, "kind" | "power">): Popup | null {
  switch (impact.kind) {
    case "landed":
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
export class ImpactLog {
  private items: Impact[] = [];
  private next = 1;

  push(kind: ImpactKind, power: number, at: number): Impact {
    const impact = { kind, power, at, seq: this.next++ };
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
