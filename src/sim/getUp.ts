// Getting up off the canvas by putting your gloves up.

import { FIGHT_CONFIG } from "../config/tuning";

export const GET_UP = {
  /** Seconds the fighter must stay down before getting up can start. Long
   *  enough that a knockdown is still a real penalty. */
  minDownSeconds: 0.9,
  /** Seconds of gloves-up needed to fill the meter from empty. */
  fillSeconds: 0.6,
  /** How fast the meter drains while the gloves are down, per second. Slower
   *  than it fills, so a one-frame tracking dropout doesn't wipe progress. */
  drainPerSecond: 1.2,
  /** Guard height (wrists above the hips, torso units) that counts as gloves
   *  up: the level the sim keeps a high guard at once it has one. A little
   *  more forgiving than raising a fresh guard, because a fighter on the
   *  canvas should not have to be precise to get up. */
  guardHeight: FIGHT_CONFIG.guardHighExit,
} as const;

export interface GetUpInput {
  /** Seconds since this fighter went down. */
  sinceDown: number;
  /** Whether the camera is tracking the player at all. */
  tracked: boolean;
  /** The player's guard height, as BodyMotion reports it. */
  guardHeight: number;
}

/** Tracks one knockdown's get-up meter. Call `reset` when a new one starts. */
export class GetUpMeter {
  /** 0-1 fill. */
  progress = 0;

  reset(): void {
    this.progress = 0;
  }

  /**
   * Advances the meter. Returns true on the frame the fighter should get up.
   * While still inside the minimum time down the meter stays empty, whatever
   * the gloves are doing.
   */
  update(dt: number, input: GetUpInput, cfg = GET_UP): boolean {
    if (input.sinceDown < cfg.minDownSeconds) {
      this.progress = 0;
      return false;
    }
    const up = input.tracked && input.guardHeight >= cfg.guardHeight;
    this.progress = up
      ? Math.min(1, this.progress + dt / cfg.fillSeconds)
      : Math.max(0, this.progress - dt * cfg.drainPerSecond);
    return this.progress >= 1;
  }
}
