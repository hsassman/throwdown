// Decides when a machine is struggling to run the fight, so the renderer can
// drop its expensive extras (shadows, the crowd, high resolution) - the same
// ones ?demo drops - and give the GPU back to pose tracking.
//
// Pose tracking and the 3D scene share one GPU. When it can't keep up, the
// player sees their fighter trailing their punches, which is the one thing
// that ruins the game. A fast machine never trips this and keeps the full
// picture.
//
// It latches: once tripped it stays tripped for the session. Turning the
// extras back on when things recover would just slow it down again, and the
// picture would flicker between the two looks.

import { GOVERNOR_CONFIG } from "./resolutionGovernor";

export const SLOW_CONFIG = {
  /** A render frame slower than this counts as slow, seconds (under 30 fps). */
  slowFrameSec: 1 / 30,
  /** Consecutive slow frames before tripping: about 2 s at 30 fps. */
  slowFramesToTrip: 60,
  /** Mean gap between pose readings above this is starved, ms (under ~16/s). */
  poseStarvedMs: GOVERNOR_CONFIG.poseStarvedMs,
  /** Consecutive starved pose readings before tripping. Readings come about
   *  twice a second, so ~2 s. */
  starvedReadingsToTrip: 4,
  /**
   * A slow pose stream with fast inference is limited by the camera, not by
   * the GPU this view shares - dropping graphics would cost picture for
   * nothing. Same rule as the resolution governor.
   */
  inferenceBoundMs: GOVERNOR_CONFIG.inferenceBoundMs,
} as const;

export class SlowDetector {
  private slowFrames = 0;
  private starvedReadings = 0;
  private tripped = false;

  get slow(): boolean {
    return this.tripped;
  }

  /** One render frame, raw seconds. Returns whether the machine is slow. */
  frame(rawDtSec: number, cfg = SLOW_CONFIG): boolean {
    if (this.tripped) return true;
    // A huge gap is a background tab or a hitch, not a slow machine.
    if (rawDtSec > 0.5) return false;
    this.slowFrames = rawDtSec > cfg.slowFrameSec ? this.slowFrames + 1 : 0;
    if (this.slowFrames >= cfg.slowFramesToTrip) this.tripped = true;
    return this.tripped;
  }

  /** A pose-rate reading: mean gap between poses and mean inference time,
   *  ms, or null when there is no pose stream. */
  poseInterval(meanMs: number | null, inferenceMs: number | null, cfg = SLOW_CONFIG): boolean {
    if (this.tripped) return true;
    const cameraLimited = inferenceMs !== null && inferenceMs < cfg.inferenceBoundMs;
    if (meanMs === null || !Number.isFinite(meanMs) || cameraLimited) {
      this.starvedReadings = 0;
      return false;
    }
    this.starvedReadings = meanMs > cfg.poseStarvedMs ? this.starvedReadings + 1 : 0;
    if (this.starvedReadings >= cfg.starvedReadingsToTrip) this.tripped = true;
    return this.tripped;
  }
}
