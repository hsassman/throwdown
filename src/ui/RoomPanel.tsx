import { useEffect, useState } from "react";
import type { MatchmakingStatus } from "../net/matchmakingClient";
import type { LinkStatus } from "../net/peerLink";
import { cleanCode, isRoomCode, joinUrl } from "../net/roomCode";
import "./versusPanel.css";

// Play a Friend through the server: the host gets a short code and a QR code,
// the friend types the code or scans the QR with their phone's camera.

interface Props {
  matchStatus: MatchmakingStatus;
  linkStatus: LinkStatus;
  roomCode: string | null;
  busy: boolean;
  onHost: () => void;
  onJoin: (code: string) => void;
  onLeave: () => void;
  /** A code from a scanned QR link, joined as soon as the panel opens. */
  autoJoin?: string | null;
  onAutoJoin?: () => void;
}

/** Quiet zone around the code, in modules. */
const QR_MARGIN = 2;

function QrCode({ text }: { text: string }) {
  const [shape, setShape] = useState<{ size: number; path: string } | null>(null);
  useEffect(() => {
    let live = true;
    // The stage page's encoder, loaded only when a room is hosted.
    void import("../stage/stageModel").then(({ qrMatrix, qrPath }) => {
      const matrix = qrMatrix(text);
      if (live) setShape({ size: matrix.length, path: qrPath(matrix) });
    });
    return () => {
      live = false;
    };
  }, [text]);
  const box = shape ? shape.size + 2 * QR_MARGIN : 0;
  return (
    <div className="room-qr">
      {shape && (
        <svg viewBox={`${-QR_MARGIN} ${-QR_MARGIN} ${box} ${box}`} role="img" aria-label="QR code that joins this fight">
          <path d={shape.path} fill="#000" shapeRendering="crispEdges" />
        </svg>
      )}
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="vs-copy-actions">
      <button type="button" className="vs-copy" onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setStatus("Link copied.");
        } catch {
          setStatus(url);
        }
      }}>Copy link</button>
      <span role="status">{status}</span>
    </div>
  );
}

export function RoomPanel({ matchStatus, linkStatus, roomCode, busy, onHost, onJoin, onLeave, autoJoin, onAutoJoin }: Props) {
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!autoJoin) return;
    setCode(autoJoin);
    onJoin(autoJoin);
    onAutoJoin?.();
  }, [autoJoin, onJoin, onAutoJoin]);

  const connected = linkStatus.state === "open";
  const linking = ["offering", "answering", "connecting"].includes(linkStatus.state);
  const hosting = !!roomCode && matchStatus.state === "waiting";
  const searching = matchStatus.state === "connecting" || matchStatus.state === "matched" || linking;
  const failed = linkStatus.state === "failed" || linkStatus.state === "closed";
  const headline = connected
    ? "Connected"
    : hosting
      ? "Waiting for your friend"
      : matchStatus.state === "matched" || linking
        ? "Friend found, connecting…"
        : matchStatus.state === "connecting"
          ? "Connecting to the fight server…"
          : matchStatus.state === "failed"
            ? "Could not connect"
            : failed
              ? "Disconnected"
              : "Play a friend";
  const dot = connected ? "open" : hosting || searching ? "connecting" : matchStatus.state === "failed" || failed ? "failed" : "idle";
  const detail = matchStatus.detail ?? (failed ? linkStatus.detail : null);

  return (
    <section className="vs vs-friend vs-room" aria-label="Play a friend">
      <header className="vs-head">
        <span className={`vs-dot vs-${dot}`} aria-hidden="true" />
        <strong role="status">{headline}</strong>
        {connected && linkStatus.latency !== null && <span className="vs-ping">{linkStatus.latency} ms</span>}
      </header>

      {connected ? (
        <button type="button" className="vs-btn vs-leave" onClick={onLeave}>Leave the fight</button>
      ) : hosting ? (
        <>
          <p className="room-code" aria-label={`Code ${roomCode.split("").join(" ")}`}>{roomCode}</p>
          <QrCode text={joinUrl(roomCode)} />
          <p className="vs-detail">
            On your friend's phone or computer: scan the QR code with the camera, or open ShadowBox,
            choose Play a Friend and enter the code.
          </p>
          <CopyLink url={joinUrl(roomCode)} />
          <button type="button" className="vs-btn vs-leave" onClick={onLeave}>Cancel</button>
        </>
      ) : searching ? (
        <>
          {matchStatus.state === "connecting" && <p className="vs-detail">A sleeping server can take up to half a minute to wake.</p>}
          <button type="button" className="vs-btn vs-leave" onClick={onLeave}>Cancel</button>
        </>
      ) : (
        <>
          {detail && <p className="vs-detail">{detail}</p>}
          <button type="button" className="vs-btn vs-primary" onClick={onHost} disabled={busy}>Host a fight</button>
          <form className="vs-join" onSubmit={(e) => {
            e.preventDefault();
            if (isRoomCode(code)) onJoin(code);
          }}>
            <label className="vs-field">
              Join a friend's fight
              <input type="text" className="room-input" value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
                placeholder="CODE" maxLength={4} autoCapitalize="characters" autoComplete="off" autoCorrect="off"
                spellCheck={false} enterKeyHint="go" aria-describedby="room-join-hint" />
            </label>
            <button type="submit" className="vs-btn vs-primary" disabled={busy || !isRoomCode(code)}>Join</button>
            <p className="vs-detail" id="room-join-hint">Enter the four-character code on your friend's screen.</p>
          </form>
        </>
      )}
    </section>
  );
}
