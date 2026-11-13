import { useCallback, useEffect, useRef, useState } from "react";
import { NET_CONFIG } from "../config/tuning";
import {
  cleanName,
  fetchTop,
  fightScore,
  MAX_NAME_LENGTH,
  submitScore,
  type LeaderboardRow,
} from "../net/leaderboard";
import type { FightResult } from "../sim/useFight";
import "./versusPanel.css";

// Top scores from the server, plus a one-time "save your score" form once a
// fight has a result. Reuses versusPanel.css's card look. The name is
// remembered per browser so a demo crowd doesn't retype it every fight.

const NAME_KEY = "shadowbox.leaderboardName";

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private mode or blocked storage: the name just isn't remembered.
  }
}

interface Props {
  /** The finished fight's result, or null while it is still going. */
  result: FightResult | null;
  /** Punches the player landed in this fight. */
  landed: number;
}

export function LeaderboardPanel({ result, landed }: Props) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(loadName);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The result object is stable for the life of one finished fight, so it is
  // the key for "already submitted this one".
  const submittedFor = useRef<FightResult | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const refresh = useCallback(() => {
    fetchTop(NET_CONFIG.matchmakingUrl)
      .then((r) => {
        setRows(r);
        setLoadError(null);
      })
      .catch(() => setLoadError("Leaderboard is offline."));
  }, []);

  useEffect(refresh, [refresh]);

  // A new fight clears the "submitted" state.
  useEffect(() => {
    if (result !== submittedFor.current) {
      setSubmitted(false);
      setSendError(null);
    }
  }, [result]);

  const score = result ? fightScore(result, landed) : 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!result || submittedFor.current === result) return;
    const clean = cleanName(name);
    if (!clean) {
      setSendError(`Enter a name, up to ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    setSending(true);
    try {
      await submitScore(NET_CONFIG.matchmakingUrl, clean, score);
      submittedFor.current = result;
      setSubmitted(true);
      setSendError(null);
      saveName(clean);
      refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Score not saved.");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="vs" aria-label="Leaderboard">
      <header className="vs-head">
        <strong>Leaderboard</strong>
      </header>

      {result && !submitted && (
        <form onSubmit={onSubmit}>
          <p className="vs-detail">
            You scored <strong>{score}</strong>. Save it?
          </p>
          <input
            type="text"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Your name"
            aria-label="Your name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="vs-btn" disabled={sending}>
            {sending ? "Saving…" : "Save score"}
          </button>
        </form>
      )}
      {submitted && <p className="vs-detail">Score saved.</p>}
      {sendError && <p className="vs-detail">{sendError}</p>}

      {loadError && <p className="vs-detail">{loadError}</p>}
      {rows && rows.length === 0 && <p className="vs-detail">No scores yet. Be the first.</p>}
      {rows && rows.length > 0 && (
        <ol className="lb-list">
          {rows.map((r, i) => (
            <li key={`${r.name}-${r.at}-${i}`}>
              <span>{r.name}</span> <strong>{r.score}</strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
