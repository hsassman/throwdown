/// <reference lib="webworker" />
//
// Pose inference worker.
//
// Milestone 0 measured inference at ~36ms against a 33.3ms camera frame
// period. Running that on the main thread means inference cannot overlap frame
// delivery, so every inference misses the next frame and the pipeline settles
// on every second frame — 15 FPS instead of 30. Moving inference here lets it
// pipeline against capture. See the risk log.
//
// Frames arrive as transferred ImageBitmaps (zero-copy) and results go back as
// a transferred Float32Array rather than a structured-cloned object graph, to
// keep the per-frame messaging cost well below the inference cost it's meant
// to be hiding.

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { ALL_POSE_KEYS, MP_LANDMARKS } from "./poseTypes";

export interface InitMessage {
  type: "init";
  wasmRoot: string;
  modelAssetPath: string;
  numPoses: number;
  minPoseDetectionConfidence: number;
  minPosePresenceConfidence: number;
  minTrackingConfidence: number;
}

export interface FrameMessage {
  type: "frame";
  bitmap: ImageBitmap;
  timestamp: number;
}

export type WorkerRequest = InitMessage | FrameMessage;

export interface ReadyMessage {
  type: "ready";
  delegate: "GPU" | "CPU";
}
export interface ErrorMessage {
  type: "error";
  message: string;
}
export interface ResultMessage {
  type: "result";
  timestamp: number;
  inferenceMs: number;
  /** 4 floats (x, y, z, visibility) per key, in ALL_POSE_KEYS order. Null if no pose. */
  values: Float32Array | null;
}
export type WorkerResponse = ReadyMessage | ErrorMessage | ResultMessage;

const FLOATS_PER_KEY = 4;

let landmarker: PoseLandmarker | null = null;
// detectForVideo requires strictly increasing timestamps; guard against a
// non-monotonic clock rather than letting MediaPipe throw mid-run.
let lastTimestamp = 0;

async function createLandmarker(
  msg: InitMessage,
  delegate: "GPU" | "CPU"
): Promise<PoseLandmarker> {
  const resolver = await FilesetResolver.forVisionTasks(msg.wasmRoot);
  return PoseLandmarker.createFromOptions(resolver, {
    baseOptions: { modelAssetPath: msg.modelAssetPath, delegate },
    runningMode: "VIDEO",
    numPoses: msg.numPoses,
    minPoseDetectionConfidence: msg.minPoseDetectionConfidence,
    minPosePresenceConfidence: msg.minPosePresenceConfidence,
    minTrackingConfidence: msg.minTrackingConfidence,
    outputSegmentationMasks: false,
  });
}

function packResult(result: PoseLandmarkerResult): Float32Array | null {
  const pose = result.landmarks?.[0];
  if (!pose) return null;
  const out = new Float32Array(ALL_POSE_KEYS.length * FLOATS_PER_KEY);
  for (let i = 0; i < ALL_POSE_KEYS.length; i++) {
    const lm = pose[MP_LANDMARKS[ALL_POSE_KEYS[i]]];
    const o = i * FLOATS_PER_KEY;
    out[o] = lm?.x ?? 0;
    out[o + 1] = lm?.y ?? 0;
    out[o + 2] = lm?.z ?? 0;
    out[o + 3] = lm?.visibility ?? 0;
  }
  return out;
}

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer ?? []);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      try {
        landmarker = await createLandmarker(msg, "GPU");
        post({ type: "ready", delegate: "GPU" });
      } catch (gpuErr) {
        console.warn("[poseWorker] GPU delegate failed, using CPU:", gpuErr);
        landmarker = await createLandmarker(msg, "CPU");
        post({ type: "ready", delegate: "CPU" });
      }
    } catch (err) {
      post({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "frame") {
    if (!landmarker) {
      msg.bitmap.close();
      return;
    }
    const ts = msg.timestamp > lastTimestamp ? msg.timestamp : lastTimestamp + 1;
    lastTimestamp = ts;

    const t0 = performance.now();
    let values: Float32Array | null = null;
    try {
      values = packResult(landmarker.detectForVideo(msg.bitmap, ts));
    } catch (err) {
      console.warn("[poseWorker] detectForVideo error:", err);
    } finally {
      // Always release the bitmap; leaking these exhausts GPU memory fast.
      msg.bitmap.close();
    }
    const inferenceMs = performance.now() - t0;

    post(
      { type: "result", timestamp: msg.timestamp, inferenceMs, values },
      values ? [values.buffer] : []
    );
  }
};
