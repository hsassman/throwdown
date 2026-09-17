import { useEffect, useRef, useState } from "react";
import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { DEBUG_CONFIG, POSE_CONFIG } from "../config/tuning";
import { ALL_POSE_KEYS, MP_LANDMARKS, type Keypoint, type PoseFrame } from "./poseTypes";
import { PoseSmoother } from "./smoothing";
import { SkeletonSolver, type SkeletonDebug } from "./skeletonSolver";
import { PosePredictor, type PredictorDebug } from "./predictor";
import { CropCanvas, RoiTracker, type RoiDebug } from "./roiCrop";
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
//
// API verified against @mediapipe/tasks-vision@0.10.35 vision.d.ts:
//   PoseLandmarker.createFromOptions(WasmFileset, PoseLandmarkerOptions)
//   detectForVideo(videoFrame, timestamp) => PoseLandmarkerResult   (sync overload)
//   result.landmarks: NormalizedLandmark[][]  ({ x, y, z, visibility })

export type PoseStatus = "loading" | "ready" | "error";

/**
 * Rewrites a pose from crop space into full-frame normalized coordinates.
 *
 * Two different inverse transforms, because the cropper does two different
 * things: a real crop window when one has been acquired, and a letterboxed
 * fit of the whole frame before that. Applying the wrong one puts the whole
 * skeleton in the wrong place, which is why the caller passes `hasCrop`
 * explicitly rather than this function guessing from the tracker's state —
 * the tracker may have been updated since the frame was drawn.
 */
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
   * The pose as it should be DRAWN right now — the smoothed pose extrapolated
   * forward by the measured pipeline latency.
   *
   * Deliberately separate from `poseRef`. Perception must keep reading the
   * un-extrapolated pose: a strike is a decision about what actually happened,
   * and resolving hits against predicted positions would let a punch register
   * from a velocity estimate rather than from a punch. Rendering has the
   * opposite requirement — it should show where you are, not where you were.
   *
   * Read this through `samplePredicted()`, which advances it to the calling
   * instant; the ref itself only holds the last sample taken.
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
  /** Interval between completed inferences (ms) — the effective pose sample rate. */
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
  /**
   * Standing watchdog on tracking quality (trackingMonitor.ts).
   *
   * Fed the RAW pose, deliberately. Measuring the smoothed signal would be
   * measuring the filter: smoothing exists to hide jitter, so a monitor
   * watching its output would report a calm signal in a shaking room — and
   * then raise the smoothing that was already hiding the problem.
   */
  const monitorRef = useRef(new TrackingMonitor());
  const trackingReportRef = useRef<TrackingReport | null>(null);
  // Held across both inference paths so the render loop can sample it at 60 Hz
  // independently of whichever path is producing poses.
  const predictorRef = useRef(new PosePredictor());

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
    //
    // CONSTRAIN, THEN SMOOTH. The solver corrects an error across SPACE (limbs
    // that are the wrong length); the filter corrects an error across TIME.
    // Running the filter first would hand the solver a temporally-blended
    // skeleton whose limb lengths are an average of several frames' worth of
    // wrong, and the solver would then faithfully rigidify that. Constraining
    // the honest observation first means the filter smooths a sequence of
    // anatomically valid skeletons, and the projection step's own small
    // discontinuities get smoothed out for free.
    let processed: PoseFrame | null = null;
    if (raw) {
      const constrained =
        solver && POSE_CONFIG.useConstraints ? solver.update(raw) : raw;
      processed = smoother.smooth(constrained);
    }
    poseRef.current = processed;

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

    // CLOSE THE LOOP.
    //
    // The monitor measured the signal; this is where its conclusion is
    // actually acted on. Until this existed the monitor was a thermometer with
    // nothing attached to it — it computed a correction every frame and
    // nothing read it.
    //
    // Only smoothing and prediction are touched, and that limit is enforced by
    // `tuning()` returning exactly those two keys (asserted structurally in
    // trackingMonitor.test.ts). Nothing here can reach a threshold that decides
    // whether a punch landed: a game that got easier in bad light, invisibly,
    // would be far worse than one that is simply harder to play in bad light.
    //
    // Applied on every sample rather than on a timer. Both setters are no-ops
    // when the value has not changed, and the monitor's own window is 90
    // frames, so the values move slowly whatever the call rate.
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
        // Segmentation masks are unused and cost inference time — leave off.
        outputSegmentationMasks: false,
      });
    }

    async function init() {
      try {
        const resolver = await FilesetResolver.forVisionTasks(
          POSE_CONFIG.wasmRoot
        );
        // GPU delegate first, CPU fallback — a non-negotiable ground rule.
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
     * window — that throttle voided several early measurement runs. Falls back
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
      // RE-ARM FIRST. This single reordering is the largest frame-rate win
      // available in this pipeline, and it is why the pose rate was pinned at
      // 15.1 FPS.
      //
      // requestVideoFrameCallback fires on the next DECODED CAMERA FRAME after
      // you register. Registering AFTER a 36 ms inference means the frame that
      // arrived during that inference has already been and gone, so the loop
      // waits for the one after it — the wait and the work are serialised, and
      // the period is quantised up to a whole number of camera frames:
      //
      //     register after work, 30 FPS capture:  36 ms work -> next boundary
      //                                           at 66.7 ms -> 15.0 FPS
      //
      // which is the measured 15.1 FPS, to within noise. Registering BEFORE
      // the work lets the callback for the next frame queue up while inference
      // is still running, so it is already pending the moment the main thread
      // frees. The wait overlaps the work instead of following it, and the
      // period collapses to the inference time itself:
      //
      //     register before work: max(36 ms, one frame) -> ~27 FPS
      //
      // i.e. the hard ceiling of 1/inference. Nothing else in this file can
      // buy that much.
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
        // Timestamped at the START of the callback, not after inference. The
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
          // drawn — a video mid-readyState-transition, or no 2D context.
          const source: HTMLVideoElement | HTMLCanvasElement =
            cropped && cropper ? cropper.canvas : video;

          const result = landmarker.detectForVideo(source, t0);
          const t1 = performance.now();

          let raw = resultToFrame(result, t0);
          if (raw && cropped && cropper && vw > 0 && vh > 0) {
            raw = mapFrameToFullFrame(raw, roi, cropper, crop !== null, vw, vh);
          }

          // Fed the FULL-FRAME pose. Handing it crop-space coordinates would
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
    // further behind the player — latency is worse than a dropped frame in a
    // game decided by punch timing.
    let inFlight = false;
    const lastEnd = { current: 0 };
    const smoother = new PoseSmoother();

    // Vite's `?worker` import respects the `worker.format: "iife"` config, so
    // this is a classic worker — required for MediaPipe's importScripts-based
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
      const raw = msg.values ? unpackFrame(msg.values, msg.timestamp) : null;
      recordFrameRef.current(raw, msg.inferenceMs, performance.now(), lastEnd, smoother);
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
          const bitmap = await createImageBitmap(video);
          if (cancelled) {
            bitmap.close();
            return;
          }
          worker.postMessage(
            { type: "frame", bitmap, timestamp: performance.now() },
            [bitmap]
          );
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
    } satisfies InitMessage);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      subscribedVideo?.cancelVideoFrameCallback?.(videoCbId);
      worker.terminate();
    };
  }, [videoRef, enabled]);

  const resetStats = () => {
    frameIntervalStats.reset();
    inferenceStats.reset();
    foundCount.current = 0;
    totalCount.current = 0;
    poseFoundRatio.current = 0;
  };

  /**
   * The pose to DRAW this instant.
   *
   * Called from the render loop at 60 Hz against a pose stream arriving at
   * 15-27 Hz, so most calls are extrapolating between samples rather than
   * interpolating — which is the entire point. Returns the plain smoothed pose
   * when prediction is disabled, so ?predict=0 is a clean A/B.
   */
  const samplePredicted = (): PoseFrame | null => {
    if (!POSE_CONFIG.usePrediction) return poseRef.current;
    const p = predictorRef.current.predictAt(performance.now());
    predictedPoseRef.current = p ?? poseRef.current;
    return predictedPoseRef.current;
  };

  return {
    poseRef,
    rawPoseRef,
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
