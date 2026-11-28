import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import {
  StrikeResolver,
  type StrikeDebugState,
  type StrikeEvent,
} from "./strikeResolver";

// Runs the strike resolver off the pose stream.

export interface StrikeTrainingHandle {
  /** Queue of strikes the renderer has not yet played. Drained by the caller. */
  strikeQueueRef: React.RefObject<StrikeEvent[]>;
  /** Subscribes to every resolved strike. */
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  /** Live reach/zone readout for the diagnostics panel. */
  debugRef: React.RefObject<StrikeDebugState | null>;
  /** The most recent strike, for a human-readable readout. State, not a ref,
   * because this one is meant to trigger a re-render - at most a few times a
   * second, and only while the training panel is open. */
  lastStrike: StrikeEvent | null;
  reset: () => void;
}

export function useStrikeTraining(
  /** Usually `usePoseTracking().subscribeStrikePose`. Must be stable. */
  subscribePose: (cb: (pose: PoseFrame) => void) => () => void,
  enabled: boolean
): StrikeTrainingHandle {
  const resolverRef = useRef<StrikeResolver | null>(null);
  const strikeQueueRef = useRef<StrikeEvent[]>([]);
  const debugRef = useRef<StrikeDebugState | null>(null);
  const [lastStrike, setLastStrike] = useState<StrikeEvent | null>(null);

  if (!resolverRef.current) resolverRef.current = new StrikeResolver();

  useEffect(() => {
    if (!enabled) return;
    const resolver = resolverRef.current!;
    // Captured here rather than read as `.current` in the cleanup: the ref
    // object is stable, but reading through it at teardown is the pattern that
    // silently breaks when a ref is ever reassigned.
    const queue = strikeQueueRef.current;
    let lastTimestamp = -1;

    const unsubscribe = subscribePose((pose) => {
      // The pose layer delivers each sample once; this guards only against a
      // non-monotonic clock, which would fabricate negative-time motion.
      if (pose.timestamp <= lastTimestamp) return;
      lastTimestamp = pose.timestamp;

      const strikes = resolver.update(pose);
      debugRef.current = resolver.debug;
      if (strikes.length > 0) {
        queue.push(...strikes);
        setLastStrike(strikes[strikes.length - 1]);
      }
    });

    return () => {
      unsubscribe();
      // Leaving training mode must not leave a half-extended arm latched, or
      // re-entering would register a strike the player never threw.
      resolver.reset();
      queue.length = 0;
    };
  }, [subscribePose, enabled]);

  // Stable identity, so a consumer's effect does not re-subscribe every render.
  const subscribe = useCallback(
    (cb: (strike: StrikeEvent) => void) => resolverRef.current!.onStrike(cb),
    []
  );

  return {
    strikeQueueRef,
    subscribe,
    debugRef,
    lastStrike,
    reset: () => {
      resolverRef.current?.reset();
      strikeQueueRef.current.length = 0;
      setLastStrike(null);
    },
  };
}
