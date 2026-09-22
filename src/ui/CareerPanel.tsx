import type { CareerProfile } from "../training/career";
import { currentOpponent, isComplete } from "../training/career";
import "./careerPanel.css";

// The side-panel view of the career ladder: record, who's next, and what just
// happened. The fight itself is shown by FightHud, same as "Fight the CPU" —
// this only answers the question FightHud doesn't: why THIS opponent, and
// what does winning get you.

interface Props {
  profile: CareerProfile;
  /** Set right after a fight on this screen resolves, cleared on the next one. */
  lastOutcome: "win" | "loss" | "draw" | null;
}

export function CareerPanel({ profile, lastOutcome }: Props) {
  const opponent = currentOpponent(profile);
  const { wins, losses, draws } = profile.record;

  return (
    <div className="cpanel">
      <div className="cpanel-record">
        <span className="cpanel-w">{wins}W</span>
        <span className="cpanel-l">{losses}L</span>
        <span className="cpanel-d">{draws}D</span>
      </div>

      {lastOutcome && (
        <p className={`cpanel-outcome cpanel-${lastOutcome}`}>
          {lastOutcome === "win"
            ? "Won — moving up the ladder."
            : lastOutcome === "loss"
              ? "Lost — same opponent next time."
              : "Draw — same opponent next time."}
        </p>
      )}

      {opponent ? (
        <div className="cpanel-next">
          <div className="cpanel-rank">Rung {profile.rank + 1}</div>
          <div className="cpanel-name">{opponent.name}</div>
          <p className="cpanel-blurb">{opponent.blurb}</p>
        </div>
      ) : (
        isComplete(profile) && (
          <div className="cpanel-next">
            <div className="cpanel-name">Ladder cleared</div>
            <p className="cpanel-blurb">
              You have beaten every opponent currently in the game. Nothing left to fight yet.
            </p>
          </div>
        )
      )}
    </div>
  );
}
