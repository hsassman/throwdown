import type { FightHudState } from "../sim/useFight";
import "./fightHud.css";

// The in-fight overlay.
//
// Laid out the way a broadcast graphic is — both fighters' bars mirrored across
// a central clock — because that is the arrangement people can read without
// looking at it, which matters here more than usual: the player is physically
// throwing punches and will catch this in peripheral vision at best.
//
// Stamina sits UNDER health as a thinner bar rather than beside it, because the
// two are read at different moments. Health is glanced at constantly; stamina
// is checked when deciding whether to commit to a combination.

interface Props {
  hud: FightHudState;
  /** Shown over the opponent while they wind up. This is the only reason the
   *  AI's telegraph is legible to a player who is looking at the character
   *  rather than at an animation they have learned. */
  showWindup?: boolean;
}

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
}: {
  side: "left" | "right";
  name: string;
  health: number;
  stamina: number;
}) {
  return (
    <div className={`fh-fighter fh-${side}`}>
      <div className="fh-name">{name}</div>
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
    </div>
  );
}

export function FightHud({ hud, showWindup = true }: Props) {
  const over = hud.phase === "stopped" || hud.phase === "decision";

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
          <div className="fh-round">R{hud.round}</div>
          <div className={`fh-clock ${hud.clock < 10 ? "is-low" : ""}`}>
            {clock(hud.clock)}
          </div>
          {hud.phase === "between" && <div className="fh-phase">Rest</div>}
        </div>
        <Bars
          side="right"
          name="Opponent"
          health={hud.opponent.health}
          stamina={hud.opponent.stamina}
        />
      </div>

      {showWindup && hud.windup > 0 && (
        // Deliberately loud. The whole design of the AI rests on its wind-up
        // being readable, and 260ms is not long enough to notice something
        // subtle while you are also moving.
        <div className="fh-windup" role="status" aria-label="Opponent winding up">
          <span style={{ transform: `scaleX(${hud.windup})` }} />
        </div>
      )}

      {over && (
        <div className="fh-result" role="status">
          {hud.log[0] ?? "Fight over"}
          <div className="fh-cards">
            {Object.entries(hud.cards).map(([id, score]) => (
              <span key={id}>
                {id === "player" ? "You" : "Opponent"} {score}
              </span>
            ))}
          </div>
        </div>
      )}

      <ul className="fh-log" aria-live="polite">
        {hud.log.slice(0, 5).map((line, i) => (
          <li key={`${line}-${i}`} style={{ opacity: 1 - i * 0.18 }}>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}
