// Region-of-interest cropping: spend the model's pixels on the player.
//
// pose_landmarker_lite resizes whatever it is given down to a small square
// tensor. At a desk webcam the player fills maybe a third of the frame, so
// after that resize the body gets a small fraction of the available pixels,
// and every landmark's precision is bounded by it. Cropping first gives the
// same model roughly 2-3x the linear resolution on every joint, and uploads a
// few hundred pixels square instead of a full frame.
//
// Done by hand rather than through the API. tasks-vision defines
// `imageProcessingOptions.regionOfInterest`, but every vision task carries a
// "ROI allowed" flag and PoseLandmarker passes false:
//
//     class extends dc { constructor(t,e){ super(new ac(t,e),
//         "image_in", "norm_rect", !1 ), ... } }
//                                    ^^^ roiAllowed = false
//
// Passing one throws "This task doesn't support region-of-interest." Read out
// of the shipped bundle, not assumed.
//
// The thing that makes or breaks it: a jittering crop window injects its own
// jitter into every landmark, because a landmark stationary in the world moves
// within a window that is itself moving. That trades pixel precision for a new
// noise source and comes out behind. So the window is heavily damped, snaps
// outward instantly but contracts slowly, and is quantised.

import { ALL_POSE_KEYS, type Keypoint, type PoseFrame } from "./poseTypes";
import { ROI_CONFIG } from "../config/tuning";

/** A crop window in source pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoiDebug {
  /** Fraction of the source frame's area the crop covers. Lower is more zoom. */
  coverage: number;
  /** Linear magnification of the body versus feeding the whole frame. */
  magnification: number;
  active: boolean;
  /** Consecutive frames with no usable pose. */
  lostFrames: number;
}

export class RoiTracker {
  /** Current window, source pixels. Null until a pose has been seen. */
  private rect: CropRect | null = null;
  private lost = Infinity;
  private debugState: RoiDebug = {
    coverage: 1,
    magnification: 1,
    active: false,
    lostFrames: Infinity,
  };

  get debug(): RoiDebug {
    return this.debugState;
  }

  reset(): void {
    this.rect = null;
    this.lost = Infinity;
  }

  /**
   * Updates the window from the most recent pose.
   *
   * Takes the pose in full-frame normalized coordinates - i.e. after
   * mapBack() has already run. Feeding it crop-space coordinates would make
   * the window chase its own tail and converge on a point.
   */
  update(pose: PoseFrame | null, videoW: number, videoH: number): void {
    if (!(videoW > 0 && videoH > 0)) return;

    if (!pose) {
      this.lost++;
      // Give up and go wide after a sustained loss. Staying zoomed on an empty
      // box is self-sealing: the player cannot be re-acquired because they are
      // outside the only region being looked at.
      if (this.lost > ROI_CONFIG.lostFramesBeforeReset) this.rect = null;
      this.publish(videoW, videoH);
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let seen = 0;
    for (const key of ALL_POSE_KEYS) {
      const kp = pose[key] as Keypoint | undefined;
      if (!kp || kp.confidence < ROI_CONFIG.minConfidence) continue;
      seen++;
      if (kp.x < minX) minX = kp.x;
      if (kp.x > maxX) maxX = kp.x;
      if (kp.y < minY) minY = kp.y;
      if (kp.y > maxY) maxY = kp.y;
    }
    if (seen < ROI_CONFIG.minLandmarks) {
      this.lost++;
      if (this.lost > ROI_CONFIG.lostFramesBeforeReset) this.rect = null;
      this.publish(videoW, videoH);
      return;
    }
    this.lost = 0;

    // To pixels.
    let x0 = minX * videoW;
    let x1 = maxX * videoW;
    let y0 = minY * videoH;
    let y1 = maxY * videoH;

    // Margin. Asymmetric on purpose: a punch sends a wrist well outside the
    // body's box and the crop must already contain where the hand is going,
    // not where it was - a landmark that leaves the window is not merely
    // imprecise, it is unobservable.
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const mx = w * ROI_CONFIG.marginX;
    const my = h * ROI_CONFIG.marginY;
    x0 -= mx;
    x1 += mx;
    y0 -= my * ROI_CONFIG.topBias;
    y1 += my;

    // Square, because the model's tensor is square. Cropping a 4:3 region into
    // a square tensor stretches the image, and the model was not trained on
    // stretched people.
    let side = Math.max(x1 - x0, y1 - y0);
    side = Math.max(side, Math.min(videoW, videoH) * ROI_CONFIG.minSideFraction);
    side = Math.min(side, Math.min(videoW, videoH));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    let want: CropRect = {
      x: cx - side / 2,
      y: cy - side / 2,
      w: side,
      h: side,
    };
    want = clampToFrame(want, videoW, videoH);

    if (!this.rect) {
      this.rect = want;
      this.publish(videoW, videoH);
      return;
    }

    // Asymmetric damping. Growing is urgent - if the player has moved out of
    // the box, every frame spent easing toward the new one is a frame of bad
    // data. Shrinking is never urgent, so it is slow enough to be invisible.
    const grow = want.w > this.rect.w;
    const k = grow ? ROI_CONFIG.growRate : ROI_CONFIG.shrinkRate;

    const next: CropRect = {
      x: this.rect.x + (want.x - this.rect.x) * k,
      y: this.rect.y + (want.y - this.rect.y) * k,
      w: this.rect.w + (want.w - this.rect.w) * k,
      h: this.rect.h + (want.h - this.rect.h) * k,
    };

    // Quantise. Sub-pixel window movement produces sub-pixel resampling
    // differences on a stationary body, which is a jitter source of exactly
    // the kind this is supposed to remove. Snapping to a grid means a still
    // player gets a bit-identical crop frame after frame.
    const q = ROI_CONFIG.quantise;
    next.x = Math.round(next.x / q) * q;
    next.y = Math.round(next.y / q) * q;
    next.w = Math.round(next.w / q) * q;
    next.h = next.w;

    this.rect = clampToFrame(next, videoW, videoH);
    this.publish(videoW, videoH);
  }

  private publish(videoW: number, videoH: number): void {
    const area = videoW * videoH;
    const r = this.rect;
    this.debugState = {
      coverage: r && area > 0 ? (r.w * r.h) / area : 1,
      // How much bigger the body is in the tensor than it would otherwise be.
      //
      // Compared against the letterboxed full frame, which is the actual
      // alternative - not against the frame's shorter edge. Fitting a 640x480
      // frame into a square tensor is limited by its longer edge (640), and
      // the short edge is padded with black. Measuring against 480 understated
      // the real gain by a third, which I only noticed because a test asserted
      // a number I had predicted by hand and it came out low.
      magnification: r ? Math.max(videoW, videoH) / Math.max(1, r.w) : 1,
      active: r !== null,
      lostFrames: this.lost,
    };
  }

  /** The current window, or null to use the whole frame. */
  get crop(): CropRect | null {
    return this.rect;
  }

  /**
   * Converts a landmark expressed in crop space back to full-frame normalized
   * coordinates. A no-op when no crop is active.
   */
  mapBack(nx: number, ny: number, videoW: number, videoH: number): [number, number] {
    const r = this.rect;
    if (!r) return [nx, ny];
    return [(r.x + nx * r.w) / videoW, (r.y + ny * r.h) / videoH];
  }
}

function clampToFrame(rect: CropRect, videoW: number, videoH: number): CropRect {
  const w = Math.min(rect.w, videoW);
  const h = Math.min(rect.h, videoH);
  return {
    x: Math.min(Math.max(0, rect.x), videoW - w),
    y: Math.min(Math.max(0, rect.y), videoH - h),
    w,
    h,
  };
}

/**
 * The scratch canvas inference actually reads from.
 *
 * Deliberately a single reused canvas. Allocating one per frame would hand the
 * GC a multi-megabyte object 15-25 times a second, and - worse - would force a
 * new GPU texture allocation on every upload, which is the exact cost this
 * whole module exists to reduce.
 */
export class CropCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;

  constructor(size = ROI_CONFIG.tensorSize) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = size;
    this.canvas.height = size;
    // `desynchronized` lets the browser skip a compositing round-trip for a
    // canvas nothing displays; `willReadFrequently: false` keeps it on the GPU,
    // which is where the WASM runtime wants to pick it up from.
    this.ctx = this.canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    });
  }

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Draws the crop. Returns false if it could not draw. */
  draw(video: HTMLVideoElement, rect: CropRect | null): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const size = this.canvas.width;
    try {
      if (rect) {
        ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, size, size);
      } else {
        // No crop yet: fit the whole frame into the square without stretching,
        // letterboxing instead. A stretched person is a person the model has
        // never seen, and the first few frames are what acquire the pose that
        // everything after depends on.
        const vw = video.videoWidth || size;
        const vh = video.videoHeight || size;
        const scale = Math.min(size / vw, size / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(video, (size - dw) / 2, (size - dh) / 2, dw, dh);
      }
      return true;
    } catch {
      // drawImage throws while a video is between readyState transitions.
      return false;
    }
  }

  /**
   * Maps a landmark from the letterboxed full-frame fallback back to real
   * normalized frame coordinates. Only needed when no crop is active.
   */
  unletterbox(
    nx: number,
    ny: number,
    videoW: number,
    videoH: number
  ): [number, number] {
    const size = this.canvas.width;
    const scale = Math.min(size / videoW, size / videoH);
    const dw = (videoW * scale) / size;
    const dh = (videoH * scale) / size;
    const ox = (1 - dw) / 2;
    const oy = (1 - dh) / 2;
    return [(nx - ox) / dw, (ny - oy) / dh];
  }
}
