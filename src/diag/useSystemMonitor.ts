import { useEffect, useRef } from "react";
import { SystemMonitor, type SystemReport } from "./systemMonitor";
import type { TrackingReport } from "../pose/trackingMonitor";
import type { DrillStats } from "../training/drill";
import type { StrikeDebugState, StrikeEvent } from "../perception/strikeResolver";
import type { RollingStats } from "../debug/perfStats";

// Wires the live pipeline into SystemMonitor and polls it, the same POLLED-
// NOT-SUBSCRIBED shape TrackingPanel uses: strikes and reach samples arrive
// at pose rate, but nothing here needs to be read faster than a few times a
// second, so the report is recomputed on an interval rather than on every
// tick.
//
// The monitor instance is created ONCE, here, and outlives whichever screen
// happens to be open — a player who fought for two minutes and then opened
// the Tracking screen should see those two minutes' worth of strike history,
// not a monitor that just woke up.

const POLL_MS = 400;

export interface UseSystemMonitorOptions {
  subscribeStrikes: (cb: (s: StrikeEvent) => void) => () => void;
  trackingReportRef: React.RefObject<TrackingReport | null>;
  strikeDebugRef: React.RefObject<StrikeDebugState | null>;
  frameIntervalStats: RollingStats;
  inferenceStats: RollingStats;
  drillStats: DrillStats | null;
}

export function useSystemMonitor(
  options: UseSystemMonitorOptions
): React.RefObject<SystemReport | null> {
  const monitorRef = useRef<SystemMonitor | null>(null);
  if (!monitorRef.current) monitorRef.current = new SystemMonitor();
  const reportRef = useRef<SystemReport | null>(null);

  // Mirrored into refs, like every other prop this hook reads on a timer —
  // so neither effect below ever has to restart just because a value changed.
  const trackingReportRef = options.trackingReportRef;
  const strikeDebugRef = options.strikeDebugRef;
  const frameStatsRef = useRef(options.frameIntervalStats);
  frameStatsRef.current = options.frameIntervalStats;
  const inferenceStatsRef = useRef(options.inferenceStats);
  inferenceStatsRef.current = options.inferenceStats;
  const drillRef = useRef(options.drillStats);
  drillRef.current = options.drillStats;
  const subscribeRef = useRef(options.subscribeStrikes);
  subscribeRef.current = options.subscribeStrikes;

  useEffect(() => {
    const monitor = monitorRef.current!;
    return subscribeRef.current((strike) => {
      monitor.recordStrike(strike, performance.now());
    });
    // Subscribes once. `subscribeRef` is read inside the callback so the
    // subscription target can never go stale even if the identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const monitor = monitorRef.current!;
    const id = window.setInterval(() => {
      const reach = strikeDebugRef.current?.reach;
      if (reach) monitor.sampleReach(reach, performance.now());
      reportRef.current = monitor.report(performance.now(), {
        tracking: trackingReportRef.current,
        drill: drillRef.current,
        frameInterval: frameStatsRef.current.compute(),
        inference: inferenceStatsRef.current.compute(),
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return reportRef;
}
