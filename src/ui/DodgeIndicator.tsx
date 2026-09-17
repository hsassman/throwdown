import { useEffect, useState } from "react";
import type { HeadState } from "../perception/dodgeDetector";

// Milestone 2's done-when is that dodging and ducking "visibly and promptly"
// move an on-screen indicator, with no noticeable false triggers. So this is
// the acceptance surface for that milestone, not just a debug readout — it
// shows the committed 0..1 values AND the raw measurements behind them, so a
// false trigger can be traced to which signal caused it.

interface Props {
  headStateRef: React.RefObject<HeadState>;
  /** Video is mirrored, so a dodge to the player's right appears left. */
  mirrored?: boolean;
}

const REFRESH_MS = 60;

/**
 * Thresholds at which this panel NAMES a dodge or duck.
 *
 * These are display labels only — `dodgeDetector` owns the actual committed
 * 0..1 values, and nothing downstream reads these. They live here rather than
 * in config/tuning.ts for that reason, but are named and documented rather
 * than inlined, because this panel is Milestone 2's acceptance surface and a
 * label that disagrees with the drawn dead zone would mislead the validation
 * run. `.dodge-neutral` in App.css draws the dead zone; keep the two in step.
 */
const INDICATOR_CONFIG = {
  duckLabel: 0.45,
  leanLabel: 0.25,
};

export function DodgeIndicator({ headStateRef, mirrored = true }: Props) {
  const [state, setState] = useState<HeadState | null>(null);

  useEffect(() => {
    // Polls rather than re-rendering per pose frame: the head state updates at
    // the pose rate, and driving React that fast would make the perception
    // loop's cost depend on rendering. ~16 Hz is well past "prompt" for a
    // human watching an indicator.
    const id = setInterval(() => {
      const next = headStateRef.current;
      setState((prev) => {
        // Only re-render when something actually changed. Setting state
        // unconditionally re-rendered this panel ~16x a second even with the
        // player standing perfectly still, competing for main-thread time with
        // a pose pipeline that is already frame-starved at 15 FPS.
        if (!next) return prev === null ? prev : null;
        if (
          prev &&
          prev.tracked === next.tracked &&
          Math.abs(prev.lean - next.lean) < 1e-3 &&
          Math.abs(prev.duck - next.duck) < 1e-3
        ) {
          return prev;
        }
        return { ...next };
      });
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [headStateRef]);

  if (!state) return null;

  const lean = mirrored ? -state.lean : state.lean;
  const dotX = 50 + lean * 42;
  const dotY = 34 + state.duck * 46;

  const label =
    state.duck > INDICATOR_CONFIG.duckLabel
      ? "DUCK"
      : Math.abs(state.lean) < INDICATOR_CONFIG.leanLabel
        ? "centre"
        : lean < 0
          ? "SLIP LEFT"
          : "SLIP RIGHT";

  return (
    <div className="dodge">
      <div className="dodge-head">
        <span>head position</span>
        <span className={state.tracked ? "muted" : "bad"}>
          {state.tracked ? "tracked" : "LOST"}
        </span>
      </div>

      <div className="dodge-field">
        {/* Neutral zone, so "am I inside the dead zone" is visible at a glance. */}
        <div className="dodge-neutral" />
        <div
          className="dodge-dot"
          style={{ left: `${dotX}%`, top: `${dotY}%` }}
        />
        <div className="dodge-axis dodge-axis-v" />
        <div className="dodge-axis dodge-axis-h" />
      </div>

      <div className={`dodge-label ${label === "centre" ? "muted" : "active"}`}>
        {label}
      </div>

      <table className="features">
        <tbody>
          <tr>
            <td className="muted">lean</td>
            <td>{state.lean.toFixed(2)}</td>
          </tr>
          <tr>
            <td className="muted">duck</td>
            <td>{state.duck.toFixed(2)}</td>
          </tr>
          <tr>
            <td className="muted">raw lateral</td>
            <td>{state.raw.lateral.toFixed(3)}</td>
          </tr>
          <tr>
            <td className="muted">raw head drop</td>
            <td>{state.raw.headDrop.toFixed(3)}</td>
          </tr>
          <tr>
            <td className="muted">raw body drop</td>
            <td>{state.raw.bodyDrop.toFixed(3)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
