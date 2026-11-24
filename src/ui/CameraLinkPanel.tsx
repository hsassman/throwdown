import { useState } from "react";
import type { LinkStatus } from "../net/peerLink";
import type { LinkSummary } from "../sensor/linkStats";
import { QrCode } from "./QrCode";
import "./versusPanel.css";
import "./cameraLinkPanel.css";

// The laptop's Phone Camera screen. Same visual language as the Same Network
// panel (versusPanel.css) - it is the same kind of connection.

interface Props {
  status: LinkStatus;
  offerUrl: string | null;
  summary: LinkSummary | null;
  scanning: boolean;
  onStart: () => void;
  onStop: () => void;
  onComplete: (code: string) => void;
}

const ms = (v: number | null) => (v === null ? "…" : `${Math.round(v)} ms`);
const pct = (v: number | null) => (v === null ? "…" : `${v < 1 && v > 0 ? v.toFixed(1) : Math.round(v)}%`);

const LABEL: Record<LinkStatus["state"], string> = {
  idle: "Not connected",
  offering: "Preparing",
  answering: "Preparing",
  connecting: "Waiting for the phone",
  open: "Phone connected",
  closed: "Disconnected",
  failed: "Could not connect",
};

export function CameraLinkPanel({ status, offerUrl, summary, scanning, onStart, onStop, onComplete }: Props) {
  const [typed, setTyped] = useState("");
  const s = summary;

  return (
    <section className="vs" aria-label="Phone camera">
      <header className="vs-head">
        <span className={`vs-dot vs-${status.state}`} aria-hidden="true" />
        <span>{LABEL[status.state]}</span>
        {status.latency !== null && status.state === "open" && <span className="vs-ping">{status.latency} ms</span>}
      </header>
      {status.detail && <p className="vs-detail">{status.detail}</p>}

      {(status.state === "idle" || status.state === "closed" || status.state === "failed") && (
        <>
          <p className="vs-detail">
            Use your phone as a second camera, placed to your side. This first version streams the phone's tracking to
            this laptop and measures the link; it does not change the fight yet. Both devices need to be on the same
            Wi-Fi. No video leaves either device.
          </p>
          <button type="button" className="vs-btn" onClick={onStart}>
            {status.state === "idle" ? "Connect a phone" : "Try again"}
          </button>
        </>
      )}

      {status.state === "connecting" && offerUrl && (
        <>
          <ol className="cl-steps">
            <li>Scan this code with your phone's camera.</li>
            <li>On the phone, tap Start camera.</li>
            <li>Hold the code the phone shows up to this laptop's camera.</li>
          </ol>
          <QrCode className="cl-qr" text={offerUrl} label="QR code for the phone" />
          <p className="vs-detail">{scanning ? "Looking for the phone's code…" : "Reading the code…"}</p>
          <label className="vs-field">
            <span>Or paste the phone's code</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="c1~a~…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div className="vs-choice">
            <button type="button" className="vs-btn" disabled={!typed.trim()} onClick={() => onComplete(typed.trim())}>
              Connect
            </button>
            <button type="button" className="vs-btn vs-leave" onClick={onStop}>
              Cancel
            </button>
          </div>
        </>
      )}

      {status.state === "open" && (
        <>
          <p className="vs-detail">
            "Behind this laptop" is how far the phone's tracking trails this laptop's own camera. Under about 60 ms,
            combining the two views is realistic.
          </p>
          <dl className="cl-stats">
            <div>
              <dt>Behind this laptop (typical)</dt>
              <dd>{ms(s?.lagP50 ?? null)}</dd>
            </div>
            <div>
              <dt>Behind this laptop (worst 5%)</dt>
              <dd>{ms(s?.lagP95 ?? null)}</dd>
            </div>
            <div>
              <dt>Frames per second</dt>
              <dd>{s ? s.fps.toFixed(1) : "…"}</dd>
            </div>
            <div>
              <dt>Lost on Wi-Fi</dt>
              <dd>{pct(s?.lostPct ?? null)}</dd>
            </div>
            <div>
              <dt>Dropped by phone</dt>
              <dd>{pct(s?.phoneDropPct ?? null)}</dd>
            </div>
            <div>
              <dt>Stalls</dt>
              <dd>{s?.stalls ?? 0}</dd>
            </div>
          </dl>
          <p className="vs-detail cl-small">
            Phone frame age {ms(s?.ageP50 ?? null)} · frames received {s?.received ?? 0} · round trip{" "}
            {ms(s?.rttMs ?? null)} · clock offset{" "}
            {s?.offsetMs != null ? `${Math.round(s.offsetMs)} ms` : "…"}
          </p>
          <button type="button" className="vs-btn vs-leave" onClick={onStop}>
            Disconnect
          </button>
        </>
      )}
    </section>
  );
}
