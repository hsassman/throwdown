import { useEffect, useRef } from "react";
import type { DummyTrainingHandle } from "../training/useDummyTraining";
import type { CoachingNote } from "../training/adaptation";
import { TRAINING_CONFIG } from "../config/tuning";
import "./trainingHud.css";

type TargetState = Pick<DummyTrainingHandle, "litRef" | "running" | "finished">;

export function TrainingTargetHud({ training }: { training: TargetState }) {
  const { finished, litRef, running } = training;
  const timeRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const targetRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!running || finished) return;
    const time = timeRef.current;
    const label = labelRef.current;
    const counter = targetRef.current;
    if (!time || !label || !counter) return;

    let animation = 0;
    let previousTarget = null as typeof litRef.current;
    const tick = (now: number) => {
      const target = litRef.current;
      if (target !== previousTarget) {
        label.textContent = target
          ? target.hand ? target.zone.label + " / " + target.hand + " hand" : target.zone.label
          : "Get ready";
        counter.textContent = target ? String(target.index).padStart(2, "0") : "";
        previousTarget = target;
      }
      const remaining = target ? (target.expiresAt - now) / TRAINING_CONFIG.windowMs : 0;
      time.style.transform = `scaleX(${Math.max(0, Math.min(1, remaining))})`;
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [finished, litRef, running]);

  if (finished) {
    return <a className="thud-stage-result" href="#training-results">Round complete <span>View results</span></a>;
  }
  if (!running) return null;
  return (
    <div className="thud-target" aria-label="Training target">
      <div className="thud-target-content">
        <span className="thud-target-label" ref={labelRef} role="status">Get ready</span>
        <span className="thud-target-number" ref={targetRef} aria-hidden="true" />
      </div>
      <div className="thud-target-track" aria-hidden="true">
        <div className="thud-target-bar" ref={timeRef} />
      </div>
    </div>
  );
}

interface Props {
  training: DummyTrainingHandle;
  scored: boolean;
  onRestart: () => void;
}

const NOTE_LABEL: Record<CoachingNote["kind"], string> = {
  setup: "Camera setup",
  technique: "Technique",
  progress: "Next round",
};

export function TrainingHud({ training, scored, onRestart }: Props) {
  const { stats, lastOutcome, notes, profile, storageError, finished } = training;
  const recap = scored && finished;
  const best = profile.bestRoundScore > 0 && stats.score >= profile.bestRoundScore;

  return (
    <section className="thud" aria-label={recap ? "Training results" : "Training stats"}
      id={recap ? "training-results" : undefined} tabIndex={recap ? -1 : undefined}>
      {scored && (
        <>
          <div className="thud-score" data-recap={recap} role={recap ? "status" : undefined}>
            <div>
              <h3>{recap ? "Round score" : "Live score"}</h3>
              <strong>{pct(stats.score)}</strong>
            </div>
            <div className="thud-score-side">
              {best && recap && <span className="thud-best">Personal best</span>}
              <span>{stats.landed}/{stats.presented} landed</span>
            </div>
          </div>
          {recap && <button type="button" className="thud-again" onClick={onRestart}>Go again</button>}
          <dl className="thud-stats">
            <Stat label="Accuracy" value={stats.landed > 0 ? pct(stats.accuracy) : "–"} />
            <Stat label="Power" value={stats.landed > 0 ? pct(stats.power) : "–"} />
            <Stat label="Timing" value={stats.landed > 0 ? pct(stats.timing) : "–"} />
          </dl>
          <p className="thud-line">
            {!recap && <span>Streak {stats.streak}</span>}
            <span>Best streak {stats.bestStreak}</span>
            {stats.reactionMs > 0 && <span>{Math.round(stats.reactionMs)} ms average</span>}
            {stats.stray > 0 && <span className="thud-warn">{stats.stray} off target</span>}
          </p>
        </>
      )}

      {lastOutcome && scored && !recap && (
        <div className="thud-last" data-kind={lastOutcome.kind}>
          <strong>{lastOutcome.zone.label}</strong>
          <span>{lastOutcome.kind === "expired"
            ? "Window closed"
            : lastOutcome.kind === "wrong-hand"
              ? "Wrong hand"
              : `${pct(lastOutcome.accuracy)} accuracy · ${Math.round(lastOutcome.reactionMs)} ms`}
          </span>
        </div>
      )}

      {notes.length > 0 && (
        <details className="thud-coaching" open={recap || undefined}>
          <summary>Coaching notes</summary>
          <ul className="thud-notes">
            {notes.map((note) => (
              <li key={note.kind + ":" + note.zoneId}>
                <strong>{NOTE_LABEL[note.kind]}</strong>
                <span>{note.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="thud-profile">
        <span>{profile.totalStrikes} {profile.totalStrikes === 1 ? "punch" : "punches"} recorded</span>
        <span>{profile.rounds} {profile.rounds === 1 ? "round" : "rounds"}</span>
        {profile.bestRoundScore > 0 && <span>Best round {pct(profile.bestRoundScore)}</span>}
      </div>
      {storageError && <p className="thud-err" role="status">{storageError}</p>}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="thud-stat"><dt>{label}</dt><dd>{value}</dd></div>;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
