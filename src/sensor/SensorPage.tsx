import { useEffect, useRef, useState } from "react";
import { useWebcam } from "../capture/useWebcam";
import { SENSOR_CONFIG } from "../config/tuning";
import { PeerLink, type LinkStatus } from "../net/peerLink";
import { usePoseTracking } from "../pose/usePoseTracking";
import { QrCode } from "../ui/QrCode";
import { useWakeLock } from "../ui/useWakeLock";
import "./sensor.css";

// The phone's end of the phone camera link: opened from the QR code on the
// laptop (?sensor#<offer>). It runs its own pose tracking and streams the
// frames to the laptop - pose only, never video. See useCameraLink.ts.

/** Faster than the pose stream, and sends only when the frame is new, so a
 *  frame never waits on the pump. Same value the fight's own pump uses. */
const PUMP_MS = 20;

export function SensorPage() {
  const offer = window.location.hash.slice(1);
  // A tap to start: iOS will not play a camera stream into a video element
  // that was not started from a user gesture.
  const [started, setStarted] = useState(false);
  const { videoRef, status: camStatus, error: camError } = useWebcam(started);
  const { rawPoseRef, status: poseStatus } = usePoseTracking(videoRef, started && camStatus === "ready");
  useWakeLock(started);

  const [link] = useState(() => new PeerLink([], { compact: true }));
  const [status, setStatus] = useState<LinkStatus>({ state: "idle", latency: null, detail: null });
  const [answer, setAnswer] = useState<string | null>(null);
  const [counts, setCounts] = useState({ produced: 0, sent: 0 });
  const countsRef = useRef({ produced: 0, sent: 0 });

  useEffect(() => {
    link.onStatus(setStatus);
    link.onMessage((m) => {
      // Answered at once, so what the laptop times is the round trip and not
      // this end's scheduling.
      if (m.kind === "sync" && m.t1 === undefined) link.send({ kind: "sync", t0: m.t0, t1: performance.now() });
    });
    return () => link.close("The phone left.");
  }, [link]);

  // Answer once the camera is live. Chrome only puts the phone's real LAN
  // address in the answer while the page has camera access; before that it
  // hides it behind an mDNS name, which some routers will not resolve.
  const camReady = camStatus === "ready";
  useEffect(() => {
    if (!camReady || !offer || answer) return;
    link.accept(offer).then(setAnswer, () => {});
  }, [camReady, offer, answer, link]);

  const open = status.state === "open";
  useEffect(() => {
    if (!open) return;
    let last = 0;
    const pump = setInterval(() => {
      const frame = rawPoseRef.current;
      if (!frame || frame.timestamp === last) return;
      last = frame.timestamp;
      countsRef.current.produced++;
      if (link.send({ kind: "pose", frame })) countsRef.current.sent++;
    }, PUMP_MS);
    const report = setInterval(() => {
      link.send({ kind: "sensorStats", ...countsRef.current });
      setCounts({ ...countsRef.current });
    }, SENSOR_CONFIG.statsIntervalMs);
    return () => {
      clearInterval(pump);
      clearInterval(report);
    };
  }, [open, link, rawPoseRef]);

  let body: React.ReactNode;
  if (!offer) {
    body = <p className="sensor-msg">Open this page by scanning the QR code on the laptop's Phone Camera screen.</p>;
  } else if (!started) {
    body = (
      <>
        <p className="sensor-msg">This phone will track you from the side and send your movement to the laptop. No video leaves the phone.</p>
        <button type="button" className="sensor-btn" onClick={() => setStarted(true)}>
          Start camera
        </button>
      </>
    );
  } else if (camStatus === "denied" || camError) {
    body = <p className="sensor-msg sensor-err">{camError ?? "Camera permission was denied. Allow it and reload."}</p>;
  } else if (status.state === "failed" || status.state === "closed") {
    body = <p className="sensor-msg sensor-err">{status.detail ?? "The link closed."} Scan the laptop's code again to reconnect.</p>;
  } else if (open) {
    body = (
      <>
        <p className="sensor-ok">Connected. Prop the phone up to your side, at chest height, about two metres away.</p>
        <dl className="sensor-stats">
          <div><dt>Tracking</dt><dd>{poseStatus === "ready" ? "on" : poseStatus}</dd></div>
          <div><dt>Frames sent</dt><dd>{counts.sent}</dd></div>
          <div><dt>Round trip</dt><dd>{status.latency !== null ? `${status.latency} ms` : "…"}</dd></div>
        </dl>
      </>
    );
  } else if (answer) {
    body = (
      <>
        <p className="sensor-msg">Hold this up to the laptop's camera.</p>
        <QrCode className="sensor-qr" text={answer} label="Reply code for the laptop" />
        <details className="sensor-code">
          <summary>Camera can't read it?</summary>
          <p>Type or paste this on the laptop instead:</p>
          <code>{answer}</code>
        </details>
      </>
    );
  } else {
    body = <p className="sensor-msg">Starting…</p>;
  }

  return (
    <main className="sensor">
      <h1 className="sensor-title">Phone camera</h1>
      <video ref={videoRef} className="sensor-video" playsInline muted />
      {body}
    </main>
  );
}
