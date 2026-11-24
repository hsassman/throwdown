// Decides the 3D view's render resolution (pixel ratio).
//
// The scene shares the GPU (and the main thread) with pose inference, and the
// pose rate is what decides how closely the character follows the player:
// modelled end to end, the drawn arm trails a real punch by ~77 ms at 25
// poses/s, ~93 ms at 19/s and ~160 ms at 8-12/s, however the filters are
// tuned. So resolution is given up not only when the 3D view itself is
// struggling, but also when pose tracking is being starved - and it is only
// won back when both are healthy.
//
// Pure (no three.js, no DOM) so it can be tested directly.

export const GOVERNOR_CONFIG = {
  /** Render frame time above which a frame counts as slow (~45 FPS). */
  slowFrameSec: 0.022,
  /** Render frame time comfortably inside budget (~70 FPS). */
  fastFrameSec: 0.014,
  /** Consecutive slow frames before stepping down. */
  slowFramesToDrop: 90,
  /** Consecutive fast frames before stepping back up. */
  fastFramesToRaise: 300,
  /** Mean gap between pose samples above which tracking counts as starved
   *  (60 ms = under ~17 poses/s). */
  poseStarvedMs: 60,
  /** Mean gap below which tracking counts as healthy again (~22 poses/s).
   *  Kept apart from poseStarvedMs so the view doesn't flip back and forth. */
  poseHealthyMs: 45,
  /** Inference time below which a slow pose stream is not the GPU's fault
   *  (e.g. a webcam that drops to 15 FPS in low light), so resolution is kept. */
  inferenceBoundMs: 25,
  /** Consecutive starved pose readings before stepping down. Readings are
   *  ~2 per second, so ~1 s of sustained starvation. */
  starvedReadingsToDrop: 2,
  step: 0.25,
} as const;

export class ResolutionGovernor {
  private readonly min: number;
  private readonly max: number;
  private current: number;
  private slowFrames = 0;
  private fastFrames = 0;
  private starvedReadings = 0;
  /** True while the latest pose reading was starved or in the band between
   *  starved and healthy: resolution may not climb back. */
  private poseHolding = false;

  constructor(min: number, max: number, start = max) {
    this.min = min;
    this.max = max;
    this.current = Math.min(max, Math.max(min, start));
  }

  get ratio(): number {
    return this.current;
  }

  /**
   * One render frame. Returns the new pixel ratio when it changes, else null.
   */
  frame(rawDtSec: number): number | null {
    const c = GOVERNOR_CONFIG;
    if (rawDtSec > c.slowFrameSec) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (rawDtSec < c.fastFrameSec) {
      this.fastFrames++;
      this.slowFrames = 0;
    }
    if (this.slowFrames > c.slowFramesToDrop) {
      this.slowFrames = 0;
      return this.stepDown();
    }
    if (this.fastFrames > c.fastFramesToRaise && !this.poseHolding) {
      this.fastFrames = 0;
      return this.stepUp();
    }
    return null;
  }

  /**
   * A reading of the mean gap between pose samples and the mean inference
   * time, ms, or nulls when there is no pose stream to judge (camera off,
   * model loading). Returns the new pixel ratio when it changes, else null.
   */
  poseInterval(meanMs: number | null, inferenceMs: number | null = null): number | null {
    const c = GOVERNOR_CONFIG;
    // A slow stream with fast inference is limited by the camera, not by the
    // GPU this view shares: lowering resolution would cost picture for nothing.
    const cameraLimited = inferenceMs !== null && inferenceMs < c.inferenceBoundMs;
    if (meanMs === null || !Number.isFinite(meanMs) || cameraLimited) {
      this.starvedReadings = 0;
      this.poseHolding = false;
      return null;
    }
    if (meanMs > c.poseStarvedMs) {
      this.poseHolding = true;
      this.starvedReadings++;
      if (this.starvedReadings >= c.starvedReadingsToDrop) {
        this.starvedReadings = 0;
        // A starved pose stream also blocks recovery until it is healthy.
        this.fastFrames = 0;
        return this.stepDown();
      }
      return null;
    }
    this.starvedReadings = 0;
    this.poseHolding = meanMs > c.poseHealthyMs;
    return null;
  }

  private stepDown(): number | null {
    if (this.current <= this.min) return null;
    this.current = Math.max(this.min, this.current - GOVERNOR_CONFIG.step);
    return this.current;
  }

  private stepUp(): number | null {
    if (this.current >= this.max) return null;
    this.current = Math.min(this.max, this.current + GOVERNOR_CONFIG.step);
    return this.current;
  }
}
