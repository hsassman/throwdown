import { CAREER_LADDER, currentOpponent, type CareerProfile, type FightOutcome } from "../training/career";
import "./careerPanel.css";

interface Props {
  profile: CareerProfile;
  lastOutcome: FightOutcome | null;
}

const OUTCOME_COPY: Record<FightOutcome, string> = {
  win: "Win recorded.",
  loss: "Loss recorded. Your next bout is a rematch.",
  draw: "Draw recorded. Your next bout is a rematch.",
};

export function CareerPanel({ profile, lastOutcome }: Props) {
  const opponent = currentOpponent(profile);
  const { wins, losses, draws } = profile.record;

  return (
    <section className="cpanel" aria-label="Career record and opponents">
      <div className="cpanel-poster">
        <div className="cpanel-poster-copy">
          <p>{opponent ? (lastOutcome ? "Next opponent" : "Current opponent") : "Career complete"}</p>
          <h3 className="cpanel-name">{opponent?.name ?? "Ladder cleared"}</h3>
        </div>
      </div>
      {opponent && <p className="cpanel-blurb">{opponent.blurb}</p>}

      <dl className="cpanel-record" aria-label="Career record">
        <div><dt>Wins</dt><dd>{wins}</dd></div>
        <div><dt>Losses</dt><dd>{losses}</dd></div>
        <div><dt>Draws</dt><dd>{draws}</dd></div>
      </dl>
      {lastOutcome && <p className="cpanel-outcome" data-outcome={lastOutcome} role="status">{OUTCOME_COPY[lastOutcome]}</p>}

      <div className="cpanel-roster">
        <h4>Opponents <span>{profile.rank}/{CAREER_LADDER.length} cleared</span></h4>
        <ol aria-label="Career ladder">
          {CAREER_LADDER.map((fighter, i) => {
            const current = profile.rank === i;
            const cleared = i < profile.rank;
            return (
              <li key={fighter.id} aria-current={current ? "step" : undefined}>
                <span>{fighter.name}</span>
                <small>{cleared ? "Cleared" : current ? "Active" : "Upcoming"}</small>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
