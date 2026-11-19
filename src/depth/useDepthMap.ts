import { useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import { DEPTH_CONFIG as C } from "../config/tuning";
import { cropFromPose, toModelInput, type DepthFrame } from "./depthMath";
import type { DepthBackend, DepthModel } from "./depthModel";

// Runs depth inference against the live camera while enabled.
//
// One inference in flight at a time and no more often than minIntervalMs, so
// depth never queues up behind itself or crowds the GPU work pose inference
// needs. The model module (and ONNX Runtime with it) is imported on first
// enable: a player who never turns depth on downloads none of it.

export type DepthStatus =
  | { state: "off" }
  | { state: "loading"; loaded: number; total: number }
  | { state: "ready"; backend: DepthBackend; variant: string }
  | { state: "error"; message: string };

export interface DepthHandle {
  status: DepthStatus;
  /** Latest depth frame, or null. Read by reference, refreshed per inference. */
  frameRef: React.RefObject<DepthFrame | null>;
}

export function useDepthMap(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  poseRef: React.RefObject<PoseFrame | null>,
  /** Every pose sample as it arrives - usePoseTracking().subscribeStrikePose. */
  subscribePose: (cb: (pose: PoseFrame) => void) => () => void,
  enabled: boolean
): DepthHandle {
  const [status, setStatus] = useState<DepthStatus>({ state: "off" });
  const frameRef = useRef<DepthFrame | null>(null);
  // Kept across toggles: re-enabling should not re-create the session.
  const modelRef = useRef<Promise<DepthModel> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus({ state: "off" });
      frameRef.current = null;
      return;
    }
    let cancelled = false;
    let timer = 0;
    // Recent pose samples, so each depth frame can be paired with the pose
    // of the same camera frame. See DepthFrame.pose.
    const history: PoseFrame[] = [];
    const unsubscribe = subscribePose((p) => {
      history.push(p);
      while (history.length > 0 && p.timestamp - history[0].timestamp > 1500) history.shift();
    });
    // ?depthSize= overrides, for measurement. Rounded to the patch size.
    const asked = Number(new URLSearchParams(window.location.search).get("depthSize"));
    const size = asked > 0 ? Math.max(14, Math.round(asked / 14) * 14) : C.inputSize;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    if (!modelRef.current) {
      setStatus({ state: "loading", loaded: 0, total: 0 });
      modelRef.current = import("./depthModel").then((m) =>
        m.loadDepthModel((loaded, total) => {
          if (!cancelled) setStatus({ state: "loading", loaded, total });
        })
      );
      // A failed load is not cached: the next enable tries again.
      modelRef.current.catch(() => {
        modelRef.current = null;
      });
    }

    modelRef.current
      .then((model) => {
        if (cancelled) return;
        setStatus({ state: "ready", backend: model.backend, variant: model.variant });
        const step = async () => {
          if (cancelled) return;
          const started = performance.now();
          const video = videoRef.current;
          if (ctx && video && video.readyState >= 2 && video.videoWidth > 0) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            // The crop comes from the newest pose, which is a little behind
            // the frame being drawn; the margin covers that.
            const crop = cropFromPose(poseRef.current, vw, vh);
            const capturedAt = performance.now();
            try {
              ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, size, size);
              const input = toModelInput(ctx.getImageData(0, 0, size, size).data, size);
              const t0 = performance.now();
              const map = await model.run(input, size);
              if (cancelled) return;
              const pose = nearestPose(history, capturedAt);
              frameRef.current = {
                map,
                size,
                crop,
                videoW: vw,
                videoH: vh,
                timestamp: started,
                pose,
                inferenceMs: performance.now() - t0,
              };
            } catch (err) {
              console.warn("[depth] inference failed:", err);
            }
          }
          const wait = Math.max(0, C.minIntervalMs - (performance.now() - started));
          timer = window.setTimeout(step, wait);
        };
        void step();
      })
      .catch((err) => {
        if (!cancelled) setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [videoRef, poseRef, subscribePose, enabled]);

  return { status, frameRef };
}

/**
 * The pose sample taken closest to `t`. Pose samples are stamped when their
 * camera frame was grabbed, so this is the pose of (nearly) the same image.
 * Null when nothing within a frame or two exists.
 */
export function nearestPose(history: PoseFrame[], t: number, maxGapMs = 80): PoseFrame | null {
  let best: PoseFrame | null = null;
  let gap = Infinity;
  for (const p of history) {
    const d = Math.abs(p.timestamp - t);
    if (d < gap) {
      gap = d;
      best = p;
    }
  }
  return gap <= maxGapMs ? best : null;
}
