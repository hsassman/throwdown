import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { DEBUG_CONFIG, POSE_CONFIG, ROI_CONFIG, STRIKE_SMOOTHING } from "../config/tuning";
import { ALL_POSE_KEYS, MP_LANDMARKS, type Keypoint, type PoseFrame } from "./poseTypes";
import { PoseSmoother } from "./smoothing";
import { SkeletonSolver, type SkeletonDebug } from "./skeletonSolver";
import { PosePredictor, type PredictorDebug } from "./predictor";
import { CropCanvas, RoiTracker, cropToFrame, type CropRect, type RoiDebug } from "./roiCrop";
import {
  TrackingMonitor,
  type TrackingReport,
} from "./trackingMonitor";
import { RollingStats } from "../debug/perfStats";
import PoseWorker from "./poseWorker?worker";
import type { InitMessage, WorkerResponse } from "./poseWorker";

/** Inverse of the worker's packResult: 4 floats per key, in ALL_POSE_KEYS order. */
function unpackFrame(values: Float32Array, timestamp: number): PoseFrame {
  const frame = { timestamp } as PoseFrame;
  for (let i = 0; i < ALL_POSE_KEYS.length; i++) {
    const o = i * 4;
    frame[ALL_POSE_KEYS[i]] = {
      x: values[o],
      y: values[o + 1],
      z: values[o + 2],
      confidence: values[o + 3],
    };
  }
  return frame;
}

// Ported from the Flap project's pose/usePoseTracking.ts. Structure kept
// (detection on its own rAF loop, latest result written to a ref so inference
// never blocks rendering); extended with the head landmarks Shadow Box needs,
// one-euro smoothing, and real latency/FPS instrumentation for Milestone 0.

export type PoseStatus = "loading" | "ready" | "error";

/** Rewrites a pose from crop space into full-frame normalized coordinates. */
function mapFrameToFullFrame(
  frame: PoseFrame,
  roi: RoiTracker,
  cropper: CropCanvas,
  hasCrop: boolean,
  videoW: number,
  videoH: number
): PoseFrame {
  const out = { timestamp: frame.timestamp } as PoseFrame;
  for (const key of ALL_POSE_KEYS) {
    const kp = frame[key];
    if (!kp) continue;
    const [x, y] = hasCrop
      ? roi.mapBack(kp.x, kp.y, videoW, videoH)
      : cropper.unletterbox(kp.x, kp.y, videoW, videoH);
    out[key] = { x, y, z: kp.z, confidence: kp.confidence };
  }
  return out;
}

/** Rewrites a pose from a known crop back into full-frame coordinates. */
function mapCropFrame(frame: PoseFrame, crop: CropRect, videoW: number, videoH: number): PoseFrame {
  const out = { timestamp: frame.timestamp } as PoseFrame;
  for (const key of ALL_POSE_KEYS) {
    const kp = frame[key];
    if (!kp) continue;
    const [x, y] = cropToFrame(kp.x, kp.y, crop, videoW, videoH);
    out[key] = { x, y, z: kp.z, confidence: kp.confidence };
  }
  return out;
}

function toKeypoint(lm: NormalizedLandmark | undefined): Keypoint {
  if (!lm) return { x: 0, y: 0, confidence: 0 };
  return {
    x: lm.x,
    y: lm.y,
    z: lm.z,
    // visibility is the per-landmark confidence proxy MediaPipe exposes.
    confidence: lm.visibility ?? 0,
  };
}

function resultToFrame(
  result: PoseLandmarkerResult,
  timestamp: number
): PoseFrame | null {
  const pose = result.landmarks?.[0];
  if (!pose) return null;
  const frame = { timestamp } as PoseFrame;
  for (const key of ALL_POSE_KEYS) {
    frame[key] = toKeypoint(pose[MP_LANDMARKS[key]]);
  }
  return frame;
}

/** Live quality/latency readouts for the diagnostics panel. */
export interface PipelineDebug {
  roi: RoiDebug;
  skeleton: SkeletonDebug;
  predictor: PredictorDebug;
}

export interface PoseTrackingHandle {
  /** Latest smoothed pose. Perception layer reads this. */
  poseRef: React.RefObject<PoseFrame | null>;
  /**
   * The pose as it should be drawn right now - the smoothed pose extrapolated
   * forward by the measured pipeline latency.
   */
  predictedPoseRef: React.RefObject<PoseFrame | null>;
  /** Extrapolates to `performance.now()` and returns it. Call per render frame. */
  samplePredicted: () => PoseFrame | null;
  /** Pipeline quality readouts, refreshed per inference. */
  pipelineDebugRef: React.RefObject<PipelineDebug | null>;
  /** Rolling tracking-quality verdict, refreshed per inference. */
  trackingReportRef: React.RefObject<TrackingReport | null>;
  /** Latest unsmoothed pose, for side-by-side debug comparison only. */
  rawPoseRef: React.RefObject<PoseFrame | null>;
  /** Delivers every pose sample meant for strike resolution, as it arrives. */
  subscribeStrikePose: (cb: (pose: PoseFrame) => void) => () => void;
  /** Interval between completed inferences (ms) - the effective pose sample rate. */
  frameIntervalStats: RollingStats;
  /** Wall-clock cost of a single detectForVideo call (ms). */
  inferenceStats: RollingStats;
  /**
   * Fraction of inferences that actually returned a pose [0,1]. Critical when
   * interpreting timing: with no body in frame BlazePose keeps running its
   * whole-image detector every frame, whereas once a pose is acquired it uses a
   * cheaper tracking path. A timing sample taken at ratio 0 is measuring a
   * different code path than real gameplay.
   */
  poseFoundRatio: React.RefObject<number>;
  status: PoseStatus;
  delegate: "GPU" | "CPU" | null;
  errorMsg: string | null;
  resetStats: () => void;
}

export function usePoseTracking(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean
): PoseTrackingHandle {
  const poseRef = useRef<PoseFrame | null>(null);
  const rawPoseRef = useRef<PoseFrame | null>(null);
  const predictedPoseRef = useRef<PoseFrame | null>(null);
  const pipelineDebugRef = useRef<PipelineDebug | null>(null);
  /** Standing watchdog on tracking quality (trackingMonitor.ts). */
  const monitorRef = useRef(new TrackingMonitor());
  const trackingReportRef = useRef<TrackingReport | null>(null);
  // Held across both inference paths so the render loop can sample it at 60 Hz
  // independently of whichever path is producing poses.
  const predictorRef = useRef(new PosePredictor());
  // Never handed to the tracking monitor's setScale - see subscribeStrikePose.
  const strikeSmootherRef = useRef(
    new PoseSmoother(STRIKE_SMOOTHING.minCutoff, STRIKE_SMOOTHING.beta, STRIKE_SMOOTHING.dCutoff)
  );
  const strikeListeners = useRef(new Set<(pose: PoseFrame) => void>()).current;

  const frameIntervalStats = useRef(
    new RollingStats(DEBUG_CONFIG.perfWindowSize)
  ).current;
  const inferenceStats = useRef(
    new RollingStats(DEBUG_CONFIG.perfWindowSize)
  ).current;

  const poseFoundRatio = useRef(0);
  const foundCount = useRef(0);
  const totalCount = useRef(0);

  const [status, setStatus] = useState<PoseStatus>("loading");
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Shared by both the main-thread and worker paths, so the two are measured
  // identically and can be compared directly.
  const recordFrame = (
    raw: PoseFrame | null,
    inferenceMs: number,
    completedAt: number,
    lastEnd: React.RefObject<number>,
    smoother: PoseSmoother,
    solver?: SkeletonSolver,
    roiDebug?: RoiDebug
  ) => {
    inferenceStats.push(inferenceMs);
    if (lastEnd.current > 0) frameIntervalStats.push(completedAt - lastEnd.current);
    lastEnd.current = completedAt;

    rawPoseRef.current = raw;
    monitorRef.current.ingest(raw);

    // Order matters and is not arbitrary.
    let processed: PoseFrame | null = null;
    let forStrikes: PoseFrame | null = null;
    if (raw) {
      const constrained =
        solver && POSE_CONFIG.useConstraints ? solver.update(raw) : raw;
      processed = smoother.smooth(constrained);
      forStrikes = strikeSmootherRef.current.smooth(constrained);
    }
    poseRef.current = processed;
    // After poseRef is set, so a listener that also reads it sees this sample.
    if (forStrikes) for (const cb of strikeListeners) cb(forStrikes);

    if (processed) predictorRef.current.ingest(processed);

    pipelineDebugRef.current = {
      roi: roiDebug ?? { coverage: 1, magnification: 1, active: false, lostFrames: 0 },
      skeleton:
        solver?.debug ?? {
          learned: 0,
          attempted: 0,
          scale: 1,
          rejected: 0,
          meanError: 0,
          meanErrorAfter: 0,
        },
      predictor: predictorRef.current.debug,
    };

    const report = monitorRef.current.report();
    trackingReportRef.current = report;

    // Close the loop.
    const tuning = monitorRef.current.tuning(report);
    smoother.setScale(tuning.smoothingScale);
    predictorRef.current.setScale(tuning.predictScale);

    totalCount.current++;
    if (raw) foundCount.current++;
    poseFoundRatio.current = foundCount.current / totalCount.current;
  };
  const recordFrameRef = useRef(recordFrame);
  recordFrameRef.current = recordFrame;

  // ---- Path A: inference on the main thread ----
  useEffect(() => {
    if (!enabled || POSE_CONFIG.useWorker) return;

    let landmarker: PoseLandmarker | null = null;
    let rafId = 0;
    let videoCbId = 0;
    let subscribedVideo: HTMLVideoElement | null = null;
    let cancelled = false;
    let lastVideoTime = -1;
    const lastDetectEnd = { current: 0 };
    const smoother = new PoseSmoother();
    const solver = new SkeletonSolver();
    const roi = new RoiTracker();
    const cropper = POSE_CONFIG.useRoi ? new CropCanvas() : null;
    predictorRef.current.reset();
    strikeSmootherRef.current.reset();

    async function createLandmarker(
      resolver: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
      delegateChoice: "GPU" | "CPU"
    ) {
      return PoseLandmarker.createFromOptions(resolver, {
        baseOptions: {
          modelAssetPath: POSE_CONFIG.modelAssetPath,
          delegate: delegateChoice,
        },
        runningMode: "VIDEO",
        numPoses: POSE_CONFIG.numPoses,
        minPoseDetectionConfidence: POSE_CONFIG.minPoseDetectionConfidence,
        minPosePresenceConfidence: POSE_CONFIG.minPosePresenceConfidence,
        minTrackingConfidence: POSE_CONFIG.minTrackingConfidence,
        // Segmentation masks are unused and cost inference time - leave off.
        outputSegmentationMasks: false,
      });
    }

    async function init() {
      try {
        const resolver = await FilesetResolver.forVisionTasks(
          POSE_CONFIG.wasmRoot
        );
        // GPU delegate first, CPU fallback - a non-negotiable ground rule.
        // ?delegate=cpu|gpu overrides the first choice for measurement runs
        // only; the fallback still applies if the forced one won't start.
        const first = POSE_CONFIG.forceDelegate ?? "GPU";
        const second = first === "GPU" ? "CPU" : "GPU";
        try {
          landmarker = await createLandmarker(resolver, first);
          if (!cancelled) setDelegate(first);
        } catch (firstErr) {
          console.warn(`${first} delegate failed, falling back to ${second}:`, firstErr);
          landmarker = await createLandmarker(resolver, second);
          if (!cancelled) setDelegate(second);
        }
        if (cancelled) {
          landmarker?.close();
          return;
        }
        setStatus("ready");
        scheduleNext();
      } catch (err) {
        console.error("Pose landmarker init failed:", err);
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      }
    }

    /**
     * Schedules the next inference. Prefers requestVideoFrameCallback (one
     * inference per decoded camera frame, no re-detecting a stale image), which
     * also dodges the ~1 Hz rAF throttle Chrome applies to a backgrounded
     * window - that throttle voided several early measurement runs. Falls back
     * to rAF where rVFC isn't available.
     */
    function scheduleNext() {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && typeof video.requestVideoFrameCallback === "function") {
        // Hold onto the element we actually registered against, so cleanup
        // cancels on that same element rather than whatever the ref points to
        // by the time the effect tears down.
        subscribedVideo = video;
        videoCbId = video.requestVideoFrameCallback(() => detect());
      } else {
        rafId = requestAnimationFrame(() => detect());
      }
    }

    function detect() {
      // Re-arm first. This single reordering is the largest frame-rate win
      // available in this pipeline, and it is why the pose rate was pinned at
      // 15.1 FPS.
      if (POSE_CONFIG.pipelineFrames) scheduleNext();

      const video = videoRef.current;
      if (cancelled || !landmarker || !video) {
        if (!POSE_CONFIG.pipelineFrames) scheduleNext();
        return;
      }

      // Guard against re-running on an identical frame. rVFC already
      // guarantees this, but the rAF fallback path does not.
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        // Timestamped at the start of the callback, not after inference. The
        // sample's age is what the predictor extrapolates by, so stamping it
        // 36 ms late would under-report the latency by exactly the largest
        // term in it.
        const t0 = performance.now();
        const vw = video.videoWidth;
        const vh = video.videoHeight;

        try {
          const crop = roi.crop;
          const cropped = cropper?.ready ? cropper.draw(video, crop) : false;
          // Falls back to the raw video element whenever the crop could not be
          // drawn - a video mid-readyState-transition, or no 2D context.
          const source: HTMLVideoElement | HTMLCanvasElement =
            cropped && cropper ? cropper.canvas : video;

          const result = landmarker.detectForVideo(source, t0);
          const t1 = performance.now();

          let raw = resultToFrame(result, t0);
          if (raw && cropped && cropper && vw > 0 && vh > 0) {
            raw = mapFrameToFullFrame(raw, roi, cropper, crop !== null, vw, vh);
          }

          // Fed the full-frame pose. Handing it crop-space coordinates would
          // make the window chase its own output and converge on a point.
          roi.update(raw, vw, vh);

          recordFrameRef.current(
            raw,
            t1 - t0,
            t1,
            lastDetectEnd,
            smoother,
            solver,
            roi.debug
          );
        } catch (err) {
          // A transient inference error shouldn't kill the loop.
          console.warn("detectForVideo error:", err);
        }
      }

      if (!POSE_CONFIG.pipelineFrames) scheduleNext();
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      subscribedVideo?.cancelVideoFrameCallback?.(videoCbId);
      landmarker?.close();
    };
  }, [videoRef, enabled, frameIntervalStats, inferenceStats]);

  // ---- Path B: inference in a Web Worker ----
  useEffect(() => {
    if (!enabled || !POSE_CONFIG.useWorker) return;

    let cancelled = false;
    let videoCbId = 0;
    let rafId = 0;
    let subscribedVideo: HTMLVideoElement | null = null;
    let lastVideoTime = -1;
    // Backpressure: only one frame in flight at a time. Without this, frames
    // queue up behind a slower-than-realtime worker and pose data arrives ever
    // further behind the player - latency is worse than a dropped frame in a
    // game decided by punch timing.
    let inFlight = false;
    const lastEnd = { current: 0 };
    const smoother = new PoseSmoother();
    // The same crop-to-the-player and constraint solving as the main-thread
    // path. The worker path used to skip both, and the crop is most of what
    // makes inference fast: fed the whole 640x480 frame, inference in the
    // worker measured ~115ms against ~43ms for the cropped main-thread path.
    const solver = new SkeletonSolver();
    const roi = new RoiTracker();
    /** What the frame in flight was cut from, to map its result back. */
    let sent: { crop: CropRect | null; vw: number; vh: number } | null = null;
    predictorRef.current.reset();
    strikeSmootherRef.current.reset();

    // Vite's `?worker` import respects the `worker.format: "iife"` config, so
    // this is a classic worker - required for MediaPipe's importScripts-based
    // WASM loading. See the comment in vite.config.ts.
    const worker = new PoseWorker();

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (cancelled) return;

      if (msg.type === "ready") {
        setDelegate(msg.delegate);
        setStatus("ready");
        scheduleNext();
        return;
      }
      if (msg.type === "error") {
        setStatus("error");
        setErrorMsg(msg.message);
        return;
      }

      // result
      inFlight = false;
      let raw = msg.values ? unpackFrame(msg.values, msg.timestamp) : null;
      const from = sent;
      sent = null;
      if (raw && from?.crop) raw = mapCropFrame(raw, from.crop, from.vw, from.vh);
      // Fed the full-frame pose, as in the main-thread path.
      if (from) roi.update(raw, from.vw, from.vh);
      recordFrameRef.current(
        raw,
        msg.inferenceMs,
        performance.now(),
        lastEnd,
        smoother,
        solver,
        roi.debug
      );
    };

    worker.onerror = (e) => {
      if (cancelled) return;
      setStatus("error");
      setErrorMsg(e.message || "pose worker failed");
    };

    function scheduleNext() {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && typeof video.requestVideoFrameCallback === "function") {
        subscribedVideo = video;
        videoCbId = video.requestVideoFrameCallback(() => void pump());
      } else {
        rafId = requestAnimationFrame(() => void pump());
      }
    }

    async function pump() {
      const video = videoRef.current;
      if (cancelled || !video) {
        scheduleNext();
        return;
      }
      // Skip if the worker is still busy, or the frame isn't new. Skipping is
      // deliberate: showing the freshest available pose beats working through
      // a backlog of stale ones.
      if (!inFlight && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        inFlight = true;
        try {
          // Stamped before the bitmap is cut, which is when the frame was
          // taken - see the main-thread path on why the stamp's age matters.
          const timestamp = performance.now();
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const crop = POSE_CONFIG.useRoi ? roi.crop : null;
          // Cropped and scaled by the browser, off the main thread, to the
          // size the model wants anyway. Before a crop is acquired the whole
          // frame is only scaled down, aspect kept, so its normalized
          // coordinates need no mapping.
          const size = ROI_CONFIG.tensorSize;
          const fit = Math.min(1, ROI_CONFIG.searchSize / Math.max(vw, vh));
          const bitmap = crop
            ? await createImageBitmap(video, crop.x, crop.y, crop.w, crop.h, {
                resizeWidth: size,
                resizeHeight: size,
                resizeQuality: "low",
              })
            : await createImageBitmap(video, {
                resizeWidth: Math.max(1, Math.round(vw * fit)),
                resizeHeight: Math.max(1, Math.round(vh * fit)),
                resizeQuality: "low",
              });
          if (cancelled) {
            bitmap.close();
            return;
          }
          sent = { crop, vw, vh };
          worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
        } catch (err) {
          inFlight = false;
          console.warn("createImageBitmap failed:", err);
        }
      }
      scheduleNext();
    }

    worker.postMessage({
      type: "init",
      wasmRoot: POSE_CONFIG.wasmRoot,
      modelAssetPath: POSE_CONFIG.modelAssetPath,
      numPoses: POSE_CONFIG.numPoses,
      minPoseDetectionConfidence: POSE_CONFIG.minPoseDetectionConfidence,
      minPosePresenceConfidence: POSE_CONFIG.minPosePresenceConfidence,
      minTrackingConfidence: POSE_CONFIG.minTrackingConfidence,
      delegate: POSE_CONFIG.workerDelegate,
    } satisfies InitMessage);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      subscribedVideo?.cancelVideoFrameCallback?.(videoCbId);
      worker.terminate();
    };
  }, [videoRef, enabled]);

  // Stable identity, so a consumer's effect does not re-subscribe every render.
  const subscribeStrikePose = useCallback(
    (cb: (pose: PoseFrame) => void) => {
      strikeListeners.add(cb);
      return () => {
        strikeListeners.delete(cb);
      };
    },
    [strikeListeners]
  );

  const resetStats = () => {
    frameIntervalStats.reset();
    inferenceStats.reset();
    foundCount.current = 0;
    totalCount.current = 0;
    poseFoundRatio.current = 0;
  };

  /** The pose to draw this instant. */
  const samplePredicted = (): PoseFrame | null => {
    if (!POSE_CONFIG.usePrediction) return poseRef.current;
    const p = predictorRef.current.predictAt(performance.now());
    predictedPoseRef.current = p ?? poseRef.current;
    return predictedPoseRef.current;
  };

  return {
    poseRef,
    rawPoseRef,
    subscribeStrikePose,
    predictedPoseRef,
    samplePredicted,
    pipelineDebugRef,
    trackingReportRef,
    frameIntervalStats,
    inferenceStats,
    poseFoundRatio,
    status,
    delegate,
    errorMsg,
    resetStats,
  };
}
