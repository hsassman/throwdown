import { useEffect, useState } from "react";
import type { FramingIssue } from "../perception/framingCheck";
import type { HandSide } from "../perception/punchTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { PoseFrame } from "../pose/poseTypes";
import { FirstRunCoach, type FirstRunStep } from "./firstRun";

// Runs the walkthrough's step machine against the live pose and strike
// streams. See firstRun.ts. React state changes only when a step or a hand
// does - a few times in the whole walkthrough.

/** How often the pose is checked, ms. Far below the hold times. */
const CHECK_MS = 100;

export interface FirstRunState {
  step: FirstRunStep;
  hands: ReadonlySet<HandSide>;
}

export function useFirstRun(
  poseRef: React.RefObject<PoseFrame | null>,
  framingIssue: FramingIssue | null,
  subscribeStrikes: (cb: (s: StrikeEvent) => void) => () => void,
  enabled: boolean
): FirstRunState {
  const [state, setState] = useState<FirstRunState>({ step: "frame", hands: new Set() });
  // The coach outlives re-renders (so a hold is not reset by one) and the
  // framing issue is read through a ref, so a prompt appearing does not
  // restart the interval.
  const [coach] = useState(() => new FirstRunCoach());
  const [issueRef] = useState(() => ({ current: framingIssue }));
  issueRef.current = framingIssue;

  useEffect(() => {
    if (!enabled) return;
    const publish = () =>
      setState((prev) =>
        prev.step === coach.step && prev.hands.size === coach.hands.size
          ? prev
          : { step: coach.step, hands: new Set(coach.hands) }
      );
    const timer = window.setInterval(() => {
      coach.update(poseRef.current, issueRef.current, performance.now());
      publish();
    }, CHECK_MS);
    const unsubscribe = subscribeStrikes((s) => {
      coach.strike(s.hand);
      publish();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [enabled, coach, issueRef, poseRef, subscribeStrikes]);

  return state;
}
