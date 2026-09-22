import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import { CalibrationCollector, type CalibrationData } from "./calibration";
import {
  PunchClassifier,
  type ClassifierDiagnostics,
  type HandDebugState,
} from "./punchClassifier";
import { DodgeDetector, NEUTRAL_HEAD_STATE, type HeadState } from "./dodgeDetector";
import type { HandSide, PunchEvent, Stance } from "./punchTypes";

// Drives the perception layer off the pose stream on its own rAF loop reading
// poseRef, so perception stays decoupled from inference (the pose layer can
// move on/off the main thread without it caring). Punches go to subscribers.

export type PerceptionPhase = "idle" | "calibrating" | "ready";

export interface PunchDetectionHandle {
  phase: PerceptionPhase;
  calibration: CalibrationData | null;
  calibrationProgress: number;
  handDebug: React.RefObject<Record<HandSide, HandDebugState> | null>;
  /**
   * Live confidence of the landmarks calibration depends on, so the calibration
   * screen can name which body part isn't tracked instead of stalling silently.
   */
  landmarkStatus: React.RefObject<Record<string, number> | null>;
  /**
   * Continuous head state for dodge/duck. A ref, not state, because it updates
   * every pose frame - routing that through re-renders would couple the
   * perception loop's cost to React's.
   */
  headState: React.RefObject<HeadState>;
  /** Detection diagnostics - which gate is rejecting punches, and peak values seen. */
  diagnostics: React.RefObject<ClassifierDiagnostics | null>;
  resetDiagnostics: () => void;
  lastPunch: PunchEvent | null;
  startCalibration: (stance: Stance) => void;
  reset: () => void;
  /** Register a callback fired for each detected punch. Returns an unsubscribe. */
  onPunch: (cb: (e: PunchEvent) => void) => () => void;
}

export function usePunchDetection(
  poseRef: React.RefObject<PoseFrame | null>,
  enabled: boolean
): PunchDetectionHandle {
  const [phase, setPhase] = useState<PerceptionPhase>("idle");
  const [calibration, setCalibration] = useState<CalibrationData | null>(null);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [lastPunch, setLastPunch] = useState<PunchEvent | null>(null);

  const classifier = useRef(new PunchClassifier()).current;
  const collector = useRef(new CalibrationCollector()).current;
  const handDebug = useRef<Record<HandSide, HandDebugState> | null>(null);
  const landmarkStatus = useRef<Record<string, number> | null>(null);
  const headState = useRef<HeadState>(NEUTRAL_HEAD_STATE);
  const diagnostics = useRef<ClassifierDiagnostics | null>(null);
  const dodge = useRef(new DodgeDetector()).current;

  const stanceRef = useRef<Stance>("orthodox");
  const calibrationRef = useRef<CalibrationData | null>(null);
  const phaseRef = useRef<PerceptionPhase>("idle");
  const subscribers = useRef(new Set<(e: PunchEvent) => void>()).current;

  // Keep refs in step with state so the animation loop can read them without
  // being re-created (and losing its trajectory history) on every render.
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    calibrationRef.current = calibration;
  }, [calibration]);

  const startCalibration = useCallback(
    (stance: Stance) => {
      stanceRef.current = stance;
      collector.reset();
      classifier.reset();
      setCalibration(null);
      setCalibrationProgress(0);
      setPhase("calibrating");
    },
    [collector, classifier]
  );

  const reset = useCallback(() => {
    collector.reset();
    classifier.reset();
    dodge.reset();
    headState.current = NEUTRAL_HEAD_STATE;
    setCalibration(null);
    setCalibrationProgress(0);
    setLastPunch(null);
    setPhase("idle");
  }, [collector, classifier, dodge]);

  const resetDiagnostics = useCallback(() => {
    classifier.resetDiagnostics();
  }, [classifier]);

  const onPunch = useCallback(
    (cb: (e: PunchEvent) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    [subscribers]
  );

  useEffect(() => {
    if (!enabled) return;
    let rafId = 0;
    let lastTimestamp = -1;

    function tick() {
      const pose = poseRef.current;
      // Only act on genuinely new pose frames; the perception loop runs faster
      // than inference, and re-processing a stale frame would fabricate
      // zero-duration motion.
      if (pose && pose.timestamp !== lastTimestamp) {
        lastTimestamp = pose.timestamp;
        const now = pose.timestamp;

        landmarkStatus.current = {
          "left shoulder": pose.leftShoulder.confidence,
          "right shoulder": pose.rightShoulder.confidence,
          "left elbow": pose.leftElbow.confidence,
          "right elbow": pose.rightElbow.confidence,
          "left wrist": pose.leftWrist.confidence,
          "right wrist": pose.rightWrist.confidence,
          "hips (optional)": Math.min(
            pose.leftHip.confidence,
            pose.rightHip.confidence
          ),
        };

        if (phaseRef.current === "calibrating") {
          collector.sample(pose);
          setCalibrationProgress(collector.count);
          const done = collector.finish(stanceRef.current);
          if (done) {
            calibrationRef.current = done;
            setCalibration(done);
            setPhase("ready");
            classifier.reset();
          }
        } else if (phaseRef.current === "ready" && calibrationRef.current) {
          headState.current = dodge.update(pose, calibrationRef.current);
          const events = classifier.update(pose, calibrationRef.current, now);
          for (const e of events) {
            setLastPunch(e);
            for (const cb of subscribers) cb(e);
          }
        }
        handDebug.current = classifier.debug;
        diagnostics.current = classifier.diagnostics;
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [poseRef, enabled, classifier, collector, subscribers, dodge]);

  return {
    phase,
    calibration,
    calibrationProgress,
    handDebug,
    landmarkStatus,
    headState,
    diagnostics,
    resetDiagnostics,
    lastPunch,
    startCalibration,
    reset,
    onPunch,
  };
}
