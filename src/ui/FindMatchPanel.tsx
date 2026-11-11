import type { MatchmakingStatus } from "../net/matchmakingClient";
import type { LinkStatus } from "../net/peerLink";
import "./versusPanel.css";

// "Find a match": the online counterpart to VersusPanel.tsx. Much simpler,
// because there is no code to paste — the only choices are "start looking"
// and "give up looking". Reuses versusPanel.css's classes rather than adding
// a new stylesheet for what is visually the same card.

interface Props {
  matchStatus: MatchmakingStatus;
  linkStatus: LinkStatus;
  onFindMatch: () => void;
  onLeave: () => void;
}

const MATCH_STATE_LABEL: Record<MatchmakingStatus["state"], string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  waiting: "Finding an opponent…",
  matched: "Opponent found, connecting…",
  closed: "Disconnected",
  failed: "Could not connect",
};

// versusPanel.css only defines dot colours for PeerLink's LinkState values.
// These three matchmaking-only states reuse the existing yellow "in
// progress" look rather than adding new CSS for the same meaning.
const DOT_CLASS: Record<MatchmakingStatus["state"], string> = {
  idle: "idle",
  connecting: "connecting",
  waiting: "connecting",
  matched: "connecting",
  closed: "closed",
  failed: "failed",
};

export function FindMatchPanel({ matchStatus, linkStatus, onFindMatch, onLeave }: Props) {
  const connected = linkStatus.state === "open";
  const searching =
    matchStatus.state === "connecting" ||
    matchStatus.state === "waiting" ||
    matchStatus.state === "matched";

  return (
    <section className="vs" aria-label="Online fight">
      <header className="vs-head">
        <span
          className={`vs-dot vs-${connected ? "open" : DOT_CLASS[matchStatus.state]}`}
          aria-hidden="true"
        />
        <strong>{connected ? "Connected" : MATCH_STATE_LABEL[matchStatus.state]}</strong>
        {connected && linkStatus.latency !== null && (
          <span className="vs-ping">{linkStatus.latency} ms</span>
        )}
      </header>

      {(matchStatus.detail || linkStatus.detail) && (
        <p className="vs-detail">{matchStatus.detail ?? linkStatus.detail}</p>
      )}

      {connected ? (
        <button type="button" className="vs-btn vs-leave" onClick={onLeave}>
          Leave the fight
        </button>
      ) : searching ? (
        <button type="button" className="vs-btn vs-leave" onClick={onLeave}>
          Cancel
        </button>
      ) : (
        <button type="button" className="vs-btn" onClick={onFindMatch}>
          Find a match
        </button>
      )}
    </section>
  );
}
