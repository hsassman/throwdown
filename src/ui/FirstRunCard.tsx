import { useEffect, useRef } from "react";
import { FIRST_RUN_STEPS, FIRST_RUN_TEXT } from "../onboarding/firstRun";
import type { FirstRunState } from "../onboarding/useFirstRun";
import { UiIcon } from "./BrandMark";
import "./firstRunCard.css";

const SETUP_LABELS = ["Frame", "Guard", "Punches"];

export function FirstRunCard({ state, onDone, preview }: {
  state: FirstRunState;
  onDone: () => void;
  preview?: { visible: boolean; onToggle: () => void };
}) {
  const { step, hands } = state;
  const text = FIRST_RUN_TEXT[step];
  const ready = step === "ready";
  const index = FIRST_RUN_STEPS.indexOf(step);
  const actionRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    actionRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDone();
      }
      if (!ready && event.key === "Tab") {
        const next = document.activeElement === actionRef.current ? previewRef.current : actionRef.current;
        event.preventDefault();
        (next ?? actionRef.current)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone, ready]);

  return (
    <section className="firstrun" role="dialog" aria-modal={ready ? undefined : true} aria-labelledby="first-run-title">
      <ol className="firstrun-progress" aria-label="Camera setup progress">
        {SETUP_LABELS.map((label, i) => (
          <li key={label} data-complete={i < index} aria-current={i === index ? "step" : undefined}>
            <span className="firstrun-mark" aria-hidden="true">{i < index ? "✓" : i + 1}</span>
            <span>{label}{i < index && <span className="firstrun-sr"> complete</span>}</span>
          </li>
        ))}
      </ol>
      <div aria-live="polite" aria-atomic="true">
        <div className="firstrun-instruction" key={step}>
          <h2 className="firstrun-title" id="first-run-title">{text.title}</h2>
          <p className="firstrun-body">
            {ready ? "To choose a mode with the camera, point at its card and hold your hand still." : text.body}
          </p>
        </div>
      </div>
      {step === "punch" && (
        <div className="firstrun-hands" aria-label="Punch check">
          {(["left", "right"] as const).map((hand) => (
            <span key={hand} data-done={hands.has(hand)}>
              <strong>{hand === "left" ? "Left hand" : "Right hand"}</strong>
              <small>{hands.has(hand) ? "Registered" : "Waiting"}</small>
            </span>
          ))}
        </div>
      )}
      <div className="firstrun-actions">
        {preview && (
          <button ref={previewRef} type="button" className="firstrun-btn firstrun-preview"
            aria-label="Camera preview" aria-pressed={preview.visible} onClick={preview.onToggle}>
            <UiIcon name="camera" /> {preview.visible ? "Hide preview" : "Show preview"}
          </button>
        )}
        <button ref={actionRef} type="button" className={`firstrun-btn${ready ? " firstrun-go" : ""}`} onClick={onDone}>
          {ready ? "Go to the menu" : <>Skip setup <kbd>Esc</kbd></>}
        </button>
      </div>
    </section>
  );
}
