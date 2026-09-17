import { useEffect, useRef } from "react";
import type { DummyTrainingHandle } from "../training/useDummyTraining";
import { TRAINING_CONFIG } from "../config/tuning";
import "./trainingHud.css";

// The training read-out.
// WHAT IT SHOWS, AND WHY IT IS THIS AND NOT MORE
//
// A player mid-round can read roughly one number and one word. Everything that
// matters WHILE punching is on the dummy itself — the lit ring, its colour on
// impact, the dummy rocking back. This panel carries what you look at BETWEEN
// rounds: the three component scores, the streak, and what the system has
// worked out about your form.
//
// The countdown bar is the exception, because a target with an invisible
// deadline is just an unfair target.

interface Props {
  training: DummyTrainingHandle;
  /** False in free work, where nothing is lit and nothing is scored. */
  scored: boolean;
  /** Starts another round. */
  onRestart: () => void;
}

export function TrainingHud({ training, scored, onRestart }: Props) {
  const { stats, lastOutcome, notes, profile, storageError, running, finished } =
    training;
  const barRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  // The countdown is written straight to the DOM rather than held in state.
  // It changes every frame; a state update per frame would re-render this
  // whole panel sixty times a second to move one bar.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const lit = training.litRef.current;
      const bar = barRef.current;
      const label = labelRef.current;
      if (!bar || !label) return;
      if (!lit) {
        bar.style.transform = "scaleX(0)";
        label.textContent = "—";
        return;
      }
      const left = (lit.expiresAt - performance.now()) / TRAINING_CONFIG.windowMs;
      bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left))})`;
      label.textContent = lit.hand
        ? `${lit.zone.label} · ${lit.hand} hand`
        : lit.zone.label;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [running, training.litRef]);

  // A finished round has to offer the way on. Without this the drill runs its
  // twelve targets, stops, and leaves the player standing in front of a dummy
  // that has silently stopped asking for anything — indistinguishable from the
  // tracking having died.
  if (scored && finished) {
    return (
      <div className="thud">
        <div className="thud-done">
          <div className="thud-done-score">{pct(stats.score)}</div>
          <div className="thud-done-label">Round score</div>
        </div>
        <div className="thud-stats">
          <Stat label="Accuracy" value={pct(stats.accuracy)} />
          <Stat label="Power" value={pct(stats.power)} />
          <Stat label="Timing" value={pct(stats.timing)} />
          <Stat label="Landed" value={`${stats.landed}/${stats.presented}`} />
        </div>
        {profile.bestRoundScore > 0 && stats.score >= profile.bestRoundScore && (
          <p className="thud-best">Best round yet.</p>
        )}
        {notes.length > 0 && (
          <ul className="thud-notes">
            {notes.map((n, i) => (
              <li key={i} data-kind={n.kind}>
                <span className="thud-note-kind">
                  {n.kind === "setup" ? "Setup" : n.kind === "technique" ? "Form" : "Next"}
                </span>
                {n.text}
              </li>
            ))}
          </ul>
        )}
        <button className="thud-again" onClick={onRestart}>
          Go again
        </button>
      </div>
    );
  }

  return (
    <div className="thud">
      {scored && (
        <div className="thud-target">
          <div className="thud-target-label" ref={labelRef}>
            —
          </div>
          <div className="thud-target-track">
            <div className="thud-target-bar" ref={barRef} />
          </div>
        </div>
      )}

      {scored && (
        <div className="thud-stats">
          <Stat label="Accuracy" value={pct(stats.accuracy)} />
          <Stat label="Power" value={pct(stats.power)} />
          <Stat label="Timing" value={pct(stats.timing)} />
          <Stat label="Score" value={pct(stats.score)} emphasis />
        </div>
      )}

      {scored && (
        <div className="thud-line">
          <span>
            {stats.landed}/{stats.presented} landed
          </span>
          <span>streak {stats.streak}</span>
          <span>best {stats.bestStreak}</span>
          {stats.reactionMs > 0 && <span>{Math.round(stats.reactionMs)}ms</span>}
          {/* Strays are shown because they make the scored figures flattering:
              punches thrown at nothing are not counted against accuracy, so a
              player spraying between targets would otherwise look accurate. */}
          {stats.stray > 0 && <span className="thud-warn">{stats.stray} stray</span>}
        </div>
      )}

      {lastOutcome && scored && (
        <div className="thud-last" data-good={lastOutcome.accuracy >= 0.5}>
          <strong>{lastOutcome.zone.label}</strong>
          <span>
            {Math.round(lastOutcome.accuracy * 100)}% ·{" "}
            {lastOutcome.strike?.region.label ?? "—"} ·{" "}
            {Math.round(lastOutcome.reactionMs)}ms
          </span>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="thud-notes">
          {notes.map((n, i) => (
            <li key={i} data-kind={n.kind}>
              {/* Setup and technique are visually distinct on purpose. Telling
                  a player to fix their form when the real cause is a high
                  camera makes them change something that was fine. */}
              <span className="thud-note-kind">
                {n.kind === "setup" ? "Setup" : n.kind === "technique" ? "Form" : "Next"}
              </span>
              {n.text}
            </li>
          ))}
        </ul>
      )}

      <div className="thud-profile">
        <span>{profile.totalStrikes} punches recorded</span>
        <span>{profile.rounds} rounds</span>
        {profile.bestRoundScore > 0 && <span>best {pct(profile.bestRoundScore)}</span>}
      </div>

      {storageError && <p className="thud-err">{storageError}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="thud-stat" data-emphasis={emphasis ? "true" : "false"}>
      <div className="thud-stat-value">{value}</div>
      <div className="thud-stat-label">{label}</div>
    </div>
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
