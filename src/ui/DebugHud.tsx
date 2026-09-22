import { useEffect, useState } from "react";
import { formatStats, type RollingStats, type Stats } from "../debug/perfStats";
import { POSE_CONFIG } from "../config/tuning";
import type { CameraInfo } from "../capture/useWebcam";
import type { PipelineDebug, PoseStatus } from "../pose/usePoseTracking";

// Milestone 0's measurement readout.
//
// the milestone's done-when is "tracked in real time, at a measured
// frame rate on your actual target hardware", and the fallback trigger is
// "well below 24-30 FPS". A single instantaneous FPS number can't answer that,
// so this reports the distribution and calls out the p5 (worst 5% of frames)
// explicitly - that's the figure that decides whether fast punches get dropped.

interface Props {
  frameIntervalStats: RollingStats;
  inferenceStats: RollingStats;
  poseFoundRatio: React.RefObject<number>;
  poseStatus: PoseStatus;
  delegate: "GPU" | "CPU" | null;
  camera: CameraInfo | null;
  /** Quality readouts for the ROI crop, the constraint solver and the
   *  predictor. Optional so the HUD still renders on the worker path, which
   *  does not produce them. */
  pipelineDebugRef?: React.RefObject<PipelineDebug | null>;
  onReset: () => void;
}

/** Interval (ms) -> rate (Hz). p5 interval is the worst case, so it maps to the
 *  lowest rate; the naming below keeps that straight deliberately. */
function intervalToRate(ms: number): number {
  return ms > 0 ? 1000 / ms : 0;
}

export function DebugHud({
  frameIntervalStats,
  inferenceStats,
  poseFoundRatio,
  poseStatus,
  delegate,
  camera,
  pipelineDebugRef,
  onReset,
}: Props) {
  const [interval, setIntervalStats] = useState<Stats | null>(null);
  const [inference, setInference] = useState<Stats | null>(null);
  const [found, setFound] = useState(0);
  const [pipeline, setPipeline] = useState<PipelineDebug | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIntervalStats(frameIntervalStats.compute());
      setInference(inferenceStats.compute());
      setFound(poseFoundRatio.current);
      setPipeline(pipelineDebugRef?.current ?? null);
    }, 500);
    return () => window.clearInterval(id);
  }, [frameIntervalStats, inferenceStats, poseFoundRatio, pipelineDebugRef]);

  // Expose the raw numbers for scripted measurement runs, so a measurement can
  // be captured verbatim rather than transcribed off a screenshot.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__shadowboxPerf = () => ({
      poseStatus,
      delegate,
      mode: POSE_CONFIG.useWorker ? "worker" : "main-thread",
      camera,
      frameInterval: frameIntervalStats.compute(),
      inference: inferenceStats.compute(),
      poseFoundRatio: poseFoundRatio.current,
      // The phase-3 quality numbers, so a measurement run captures whether ROI
      // and the constraint solver were actually engaged rather than assuming
      // it from the flags.
      pipeline: pipelineDebugRef?.current ?? null,
      flags: {
        roi: POSE_CONFIG.useRoi,
        constraints: POSE_CONFIG.useConstraints,
        predict: POSE_CONFIG.usePrediction,
        pipelineFrames: POSE_CONFIG.pipelineFrames,
      },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
    });
  }, [
    frameIntervalStats,
    inferenceStats,
    poseFoundRatio,
    poseStatus,
    delegate,
    camera,
    pipelineDebugRef,
  ]);

  const medianFps = interval ? intervalToRate(interval.median) : 0;
  const worstFps = interval ? intervalToRate(interval.p95) : 0;
  const bestFps = interval ? intervalToRate(interval.min) : 0;

  // the fallback trigger: "well below 24-30 FPS".
  const bar = medianFps >= 30 ? "good" : medianFps >= 24 ? "marginal" : "poor";

  return (
    <div className="hud">
      <div className="hud-row">
        <strong>Milestone 0 - pose tracking</strong>
        <button onClick={onReset}>reset stats</button>
      </div>

      <div className="hud-row">
        <span>pose: {poseStatus}</span>
        <span>delegate: {delegate ?? "-"}</span>
      </div>

      <div className="hud-row">
        <span>inference: {POSE_CONFIG.useWorker ? "worker" : "main thread"}</span>
      </div>

      <div className="hud-row">
        <span>
          camera:{" "}
          {camera
            ? `${camera.width}x${camera.height} @ ${camera.frameRate.toFixed(0)}fps`
            : "-"}
        </span>
      </div>

      <hr />

      <div className={`hud-fps hud-${bar}`}>
        {medianFps.toFixed(1)} FPS median
        <span className="hud-sub">
          {" "}
          (worst-5% {worstFps.toFixed(1)} · best {bestFps.toFixed(1)})
        </span>
      </div>
      <div className="hud-note">
        pose sample rate - {bar}
        {bar === "poor" ? " · below the 24-30 FPS floor" : ""}
      </div>
      <div className={found < 0.5 ? "hud-poor" : "hud-note"}>
        body detected in {(found * 100).toFixed(0)}% of frames
        {found < 0.5
          ? " · timings below reflect the DETECTION path, not gameplay"
          : ""}
      </div>

      <hr />

      <div className="hud-block">
        <div className="hud-label">frame interval</div>
        <div className="hud-stat">
          {interval ? formatStats(interval, "ms") : "-"}
        </div>
      </div>

      <div className="hud-block">
        <div className="hud-label">inference cost</div>
        <div className="hud-stat">
          {inference ? formatStats(inference, "ms") : "-"}
        </div>
      </div>

      {pipeline && (
        <>
          <hr />
          <div className="hud-block">
            <div className="hud-label">roi crop</div>
            <div className="hud-stat">
              {pipeline.roi.active
                ? `${pipeline.roi.magnification.toFixed(2)}x body zoom · ${(
                    pipeline.roi.coverage * 100
                  ).toFixed(0)}% of frame`
                : "full frame (acquiring)"}
            </div>
          </div>

          <div className="hud-block">
            <div className="hud-label">skeleton constraints</div>
            <div className="hud-stat">
              {pipeline.skeleton.learned}/{pipeline.skeleton.attempted} bones ·
              {" "}
              {/* The headline accuracy number: how much the raw skeleton's limb
                  lengths were breathing, and what is left after projection. */}
              limb error {(pipeline.skeleton.meanError * 1000).toFixed(1)} →{" "}
              {(pipeline.skeleton.meanErrorAfter * 1000).toFixed(1)} mpx
              {pipeline.skeleton.rejected > 0 &&
                ` · ${pipeline.skeleton.rejected} clamped`}
            </div>
          </div>

          <div className="hud-block">
            <div className="hud-label">latency compensation</div>
            <div className="hud-stat">
              {pipeline.predictor.latencyMs.toFixed(0)} ms measured · leading{" "}
              {pipeline.predictor.leadMs.toFixed(0)} ms ·{" "}
              {pipeline.predictor.predicted}/{pipeline.predictor.available} points
            </div>
          </div>
        </>
      )}
    </div>
  );
}
