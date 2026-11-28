import type { ReactNode } from "react";
import type { FightHudState, FightResult } from "../sim/useFight";
import "./fightHud.css";

interface Props {
  hud: FightHudState;
  showWindup?: boolean;
  rematch?: { onRematch: () => void; waiting: boolean; opponentReady: boolean } | null;
}

const RESULT_TITLE: Record<FightResult["kind"], string> = {
  win: "You win",
  loss: "Opponent wins",
  draw: "Draw",
};
const RESULT_METHOD: Record<FightResult["reason"], string> = {
  ko: "Knockout",
  tko: "Technical knockout",
  decision: "Judges’ decision",
};

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Bars({
  side,
  name,
  health,
  stamina,
  children,
}: {
  side: "left" | "right";
  name: string;
  health: number;
  stamina: number;
  children?: ReactNode;
}) {
  return (
    <div className={`fh-fighter fh-${side}`} data-critical={health <= 25}>
      <div className="fh-fighter-label">
        <span className="fh-name">{name}</span>
        <span className="fh-health-value" aria-hidden="true">{Math.round(health)}%</span>
      </div>
      <div
        className="fh-health"
        role="meter"
        aria-label={`${name} health`}
        aria-valuenow={Math.round(health)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${Math.max(0, Math.min(100, health))}%` }} />
      </div>
      <div
        className="fh-stamina"
        role="meter"
        aria-label={`${name} stamina`}
        aria-valuenow={Math.round(stamina * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${Math.max(0, Math.min(1, stamina)) * 100}%` }} />
      </div>
      {children}
    </div>
  );
}

export function FightHud({ hud, showWindup = true, rematch = null }: Props) {
  const over = hud.phase === "stopped" || hud.phase === "decision";
  const result = hud.result;

  return (
    <div className="fight-hud">
      <div className="fh-top">
        <Bars
          side="left"
          name="You"
          health={hud.player.health}
          stamina={hud.player.stamina}
        />
        <div className="fh-centre">
          <div className="fh-round">Round {hud.round}</div>
          <div className={`fh-clock ${hud.phase === "fighting" && hud.clock < 10 ? "is-low" : ""}`}>
            {clock(hud.clock)}
          </div>
          {hud.phase === "between" && <div className="fh-phase">Rest</div>}
        </div>
        <Bars
          side="right"
          name="Opponent"
          health={hud.opponent.health}
          stamina={hud.opponent.stamina}
        >
          {!over && showWindup && hud.windup > 0 && (
            <div className="fh-windup" aria-label="Opponent winding up" role="status">
              <span>Incoming</span>
              <i aria-hidden="true"><b style={{ transform: `scaleX(${hud.windup})` }} /></i>
            </div>
          )}
        </Bars>
      </div>

      {hud.count && (
        <div className="fh-count" role="status" aria-live="assertive">
          <strong>{hud.count.at}</strong>
          <span>{hud.count.who === "player" ? "You are down" : "Opponent down"}</span>
          {hud.count.who === "player" && hud.getUp !== null && (
            <div className="fh-getup" role="meter" aria-label="Get up" aria-valuenow={Math.round(hud.getUp * 100)} aria-valuemin={0} aria-valuemax={100}>
              <em>Gloves up to get up!</em>
              <i><b style={{ transform: `scaleX(${hud.getUp})` }} /></i>
            </div>
          )}
        </div>
      )}

      {over && (
        <section className="fh-result" aria-labelledby="fight-result-title" data-outcome={result?.kind}>
          <div className="fh-result-heading" role="status">
            <p className="fh-result-label">{result ? RESULT_METHOD[result.reason] : "Fight result"}</p>
            <h2 id="fight-result-title" className="fh-result-title">
              {result ? RESULT_TITLE[result.kind] : hud.log[0] ?? "Fight over"}
            </h2>
          </div>
          <dl className="fh-cards" aria-label="Bout statistics">
            <Scorecard name="You" points={hud.cards.player} landed={hud.player.landed} />
            <Scorecard name="Opponent" points={hud.cards.opponent} landed={hud.opponent.landed} />
          </dl>
          {rematch && (
            <div className="fh-result-actions">
              <button type="button" className="fh-rematch" onClick={rematch.onRematch} disabled={rematch.waiting}>
                {rematch.waiting ? "Rematch requested" : "Fight again"}
              </button>
              <p className="fh-rematch-hint" role="status">
                {rematch.waiting
                  ? "Waiting for your opponent."
                  : rematch.opponentReady
                    ? "Your opponent is ready."
                    : "You can also raise both hands."}
              </p>
            </div>
          )}
        </section>
      )}

      {!over && <ul className="fh-log" aria-label="Fight activity">
        {hud.log.slice(0, 3).map((line, i) => (
          <li key={`${line}-${i}`} style={{ opacity: 1 - i * 0.18 }}>
            {line}
          </li>
        ))}
      </ul>}
    </div>
  );
}

function Scorecard({ name, points, landed }: { name: string; points?: number; landed: number }) {
  return (
    <div className="fh-scorecard">
      <dt>{name}</dt>
      <dd><strong>{landed}</strong> Landed</dd>
      {typeof points === "number" && <dd><strong>{points}</strong> Points</dd>}
    </div>
  );
}
