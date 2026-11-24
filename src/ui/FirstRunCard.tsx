import { useEffect } from "react";
import { FIRST_RUN_TEXT } from "../onboarding/firstRun";
import type { FirstRunState } from "../onboarding/useFirstRun";
import "./firstRunCard.css";

/**
 * The walkthrough's card, over the menu. One instruction at a time, large
 * enough to read from where the player has to stand, and no "Next" button on
 * the camera steps: the camera seeing it done is what moves it on.
 *
 * Skippable at any point, by button or Escape, because a returning player on
 * a new browser should not have to prove they can throw a jab.
 */
export function FirstRunCard({ state, onDone }: { state: FirstRunState; onDone: () => void }) {
  const { step, hands } = state;
  const text = FIRST_RUN_TEXT[step];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  return (
    <div className="firstrun" role="dialog" aria-label="Getting started" aria-live="polite">
      <h2 className="firstrun-title">{text.title}</h2>
      <p className="firstrun-body">{text.body}</p>
      {step === "punch" && (
        <div className="firstrun-hands">
          {/* Mirrored, as the player sees themselves: their left on the left. */}
          <span data-done={hands.has("left")}>Left {hands.has("left") ? "✓" : ""}</span>
          <span data-done={hands.has("right")}>Right {hands.has("right") ? "✓" : ""}</span>
        </div>
      )}
      {step === "ready" ? (
        <button type="button" className="firstrun-btn firstrun-go" onClick={onDone}>
          Go to the menu
        </button>
      ) : (
        <button type="button" className="firstrun-btn" onClick={onDone}>
          Skip <kbd>Esc</kbd>
        </button>
      )}
    </div>
  );
}
