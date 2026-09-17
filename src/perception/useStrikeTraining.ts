import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import {
  StrikeResolver,
  type StrikeDebugState,
  type StrikeEvent,
} from "./strikeResolver";

// Runs the training-mode strike resolver off the pose stream.
//
// Structured like usePunchDetection: its own rAF loop reading poseRef, so
// perception stays decoupled from inference and nothing here depends on where
// the pose came from. Landed strikes go into a queue the render layer drains,
// rather than through React state — at pose rate a state update per strike
// would re-render the tree in the middle of a combination.

export interface StrikeTrainingHandle {
  /** Queue of strikes the renderer has not yet played. Drained by the caller. */
  strikeQueueRef: React.RefObject<StrikeEvent[]>;
  /**
   * Subscribes to every resolved strike.
   *
   * Separate from `strikeQueueRef` on purpose. The queue is DRAINED by whoever
   * reads it, so it supports exactly one consumer — the renderer, which plays
   * each hit on the target. The simulation is a second, independent consumer
   * that must see every strike too, and adding a second drainer would mean the
   * two race and each gets roughly half the punches.
   */
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  /** Live reach/zone readout for the diagnostics panel. */
  debugRef: React.RefObject<StrikeDebugState | null>;
  /** The most recent strike, for a human-readable readout. State, not a ref,
   * because this one IS meant to trigger a re-render — at most a few times a
   * second, and only while the training panel is open. */
  lastStrike: StrikeEvent | null;
  reset: () => void;
}

export function useStrikeTraining(
  poseRef: React.RefObject<PoseFrame | null>,
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
    let rafId = 0;
    let lastTimestamp = -1;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const pose = poseRef.current;
      // Only act on genuinely new samples. The pose stream updates at ~15 FPS
      // while this loop runs at ~60, and re-feeding the same frame would let
      // one extension cross the threshold on four consecutive iterations with
      // a stale speed reading.
      if (!pose || pose.timestamp === lastTimestamp) return;
      lastTimestamp = pose.timestamp;

      const strikes = resolver.update(pose);
      debugRef.current = resolver.debug;
      if (strikes.length > 0) {
        queue.push(...strikes);
        setLastStrike(strikes[strikes.length - 1]);
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      // Leaving training mode must not leave a half-extended arm latched, or
      // re-entering would register a strike the player never threw.
      resolver.reset();
      queue.length = 0;
    };
  }, [poseRef, enabled]);

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
