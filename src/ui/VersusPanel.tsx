import { useEffect, useRef, useState } from "react";
import type { LinkStatus } from "../net/peerLink";
import type { SessionRole } from "../net/useSession";
import "./versusPanel.css";

// Setting up a fight against a person.
// WHY THE PLAYERS COPY A CODE
//
// Shadow Box is a static build with no server behind it. WebRTC connects two
// browsers directly, and the only thing it genuinely needs from the outside
// world is one blob of text handed from one end to the other, once. So the
// players do that themselves, through whatever they already use to talk to
// each other.
//
// It is clumsy for thirty seconds and then it is a direct connection with
// nobody in the middle. The alternative is a signalling server — the same
// thirty seconds of clumsiness moved into infrastructure somebody has to run,
// pay for and keep up.

interface Props {
  status: LinkStatus;
  role: SessionRole | null;
  outgoingCode: string;
  busy: boolean;
  onHost: () => void;
  onJoin: (code: string) => void;
  onComplete: (code: string) => void;
  onLeave: () => void;
}

const STATE_LABEL: Record<LinkStatus["state"], string> = {
  idle: "Not connected",
  offering: "Making your code…",
  answering: "Reading their code…",
  connecting: "Waiting for the other fighter",
  open: "Connected",
  closed: "Disconnected",
  failed: "Could not connect",
};

/**
 * A block of code with a copy button.
 *
 * The button is not decoration. The code is about a kilobyte of base64 and
 * selecting it by hand out of a scrolling box is genuinely awkward, which is
 * the moment most people would give up on the whole feature.
 */
function CodeBox({ code, label }: { code: string; label: string }) {
  const [status, setStatus] = useState("");
  const codeRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setStatus(""), [code]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setStatus("Code copied.");
    } catch {
      codeRef.current?.focus();
      codeRef.current?.select();
      setStatus("Code selected. Copy it from your device’s menu.");
    }
  }

  return (
    <div className="vs-code">
      <label>
        {label}
        <textarea ref={codeRef} readOnly value={code} rows={3} spellCheck={false} />
      </label>
      <div className="vs-copy-actions">
        <button type="button" className="vs-copy" onClick={copyCode}>Copy code</button>
        <span role="status">{status}</span>
      </div>
    </div>
  );
}

/**
 * The connected state, small enough to float over the fight.
 *
 * Once the two ends are talking there is nothing left to read — the codes have
 * done their job — and a full side panel for three lines of text was taking a
 * quarter of the screen away from the one thing the player is looking at. What
 * is left is what they might actually want mid-fight: whether the link is
 * still up, how far behind it is, and a way out that does not need a keyboard.
 */
export function VersusChip({
  status,
  role,
  onLeave,
}: Pick<Props, "status" | "role" | "onLeave">) {
  return (
    <div className="vs-chip">
      <span className={`vs-dot vs-${status.state}`} aria-hidden="true" />
      <span className="vs-chip-role">{role === "host" ? "Host" : "Guest"}</span>
      {status.latency !== null && (
        <span className="vs-ping">{status.latency} ms</span>
      )}
      <button type="button" className="vs-chip-leave" onClick={onLeave}>
        Leave
      </button>
    </div>
  );
}

export function VersusPanel({
  status,
  role,
  outgoingCode,
  busy,
  onHost,
  onJoin,
  onComplete,
  onLeave,
}: Props) {
  const [theirCode, setTheirCode] = useState("");
  useEffect(() => setTheirCode(""), [role]);
  const connected = status.state === "open";

  return (
    <section className="vs vs-friend" aria-label="Same-network fight">
      <header className="vs-head">
        <span className={`vs-dot vs-${status.state}`} aria-hidden="true" />
        <strong role="status">{STATE_LABEL[status.state]}</strong>
        {connected && status.latency !== null && (
          <span className="vs-ping">{status.latency} ms</span>
        )}
      </header>

      {status.detail && <p className="vs-detail">{status.detail}</p>}

      {connected ? (
        <>
          <p className="vs-detail">
            Playing as {role === "host" ? "host" : "guest"}.
          </p>
          <button type="button" className="vs-btn vs-leave" onClick={onLeave}>
            Leave the fight
          </button>
        </>
      ) : !role ? (
        <>
          <button type="button" className="vs-btn vs-primary" onClick={onHost} disabled={busy}>Host a fight</button>
          <p className="vs-detail">Start a fight and share the code with your friend.</p>
          <div className="vs-join">
            <label className="vs-field">
              Their host code
              <textarea
                value={theirCode}
                onChange={(e) => setTheirCode(e.target.value)}
                rows={3}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                placeholder="Paste your friend’s code"
              />
            </label>
            <button
              type="button"
              className="vs-btn vs-primary"
              onClick={() => onJoin(theirCode)}
              disabled={busy || theirCode.trim().length < 20}
            >
              Join with a code
            </button>
          </div>
        </>
      ) : role === "host" ? (
        <>
          {outgoingCode && (
            <CodeBox label="Send this code to your friend" code={outgoingCode} />
          )}
          <label className="vs-field">
            Your friend's reply code
            <textarea
              value={theirCode}
              onChange={(e) => setTheirCode(e.target.value)}
              rows={3}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="Paste the reply code"
            />
          </label>
          <button
            type="button"
            className="vs-btn vs-primary"
            onClick={() => onComplete(theirCode)}
            disabled={busy || theirCode.trim().length < 20}
          >
            Start the fight
          </button>
          <button type="button" className="vs-btn vs-leave" onClick={onLeave}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {outgoingCode && (
            <CodeBox label="Send this reply code back to the host" code={outgoingCode} />
          )}
          <p className="vs-detail">
            Wait for the host to start the fight.
          </p>
          <button type="button" className="vs-btn vs-leave" onClick={onLeave}>
            Cancel
          </button>
        </>
      )}
    </section>
  );
}
