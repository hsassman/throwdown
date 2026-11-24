import { useCallback, useEffect, useRef, useState } from "react";
import { SENSOR_CONFIG } from "../config/tuning";
import { isCompactSignal } from "../net/compactSignal";
import { PeerLink, type LinkStatus } from "../net/peerLink";
import type { PoseFrame } from "../pose/poseTypes";
import { LinkStats, type LinkSummary } from "./linkStats";
import { loadQrDecoder, scanFrame } from "./qrScan";

// The laptop's end of the phone camera link.
//
// Step 1 of the two-camera plan: get the phone's pose onto the laptop and
// measure what arrives - delay, rate, loss. Nothing here is fused into the
// fight yet; whether that is worth building depends on these numbers.
//
// Pairing has no server and no typing. The laptop hosts and shows its offer
// as a QR code linking to the game in sensor mode (SensorPage.tsx); the phone
// opens it, answers, and shows its reply as a QR code; the laptop reads that
// off its own webcam. Both codes are compact (compactSignal.ts) so a webcam
// can read the reply at arm's length.
//
// The phone sends pose frames, never video - the project's rule holds.

export interface CameraLinkOptions {
  enabled: boolean;
  /** The laptop's webcam, for reading the phone's reply code. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** The laptop's own unsmoothed pose, to measure how far the phone trails it. */
  localPoseRef: React.RefObject<PoseFrame | null>;
}

declare global {
  interface Window {
    /** Live link numbers, for tools/ and for reading off a console. */
    __shadowboxSensor?: () => LinkSummary | null;
  }
}

/** The laptop's own pose older than this is not a live comparison, ms. */
const LOCAL_STALE_MS = 500;

export function useCameraLink({ enabled, videoRef, localPoseRef }: CameraLinkOptions) {
  const [status, setStatus] = useState<LinkStatus>({ state: "idle", latency: null, detail: null });
  const [offerUrl, setOfferUrl] = useState<string | null>(null);
  const [summary, setSummary] = useState<LinkSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  /** The phone's latest pose. A ref: it moves at 15 Hz and nothing in React
   *  needs to re-render for it. */
  const remotePoseRef = useRef<PoseFrame | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const statsRef = useRef<LinkStats | null>(null);
  const answeredRef = useRef(false);

  const stop = useCallback(() => {
    linkRef.current?.close("The laptop ended the link.");
    linkRef.current = null;
    statsRef.current = null;
    remotePoseRef.current = null;
    answeredRef.current = false;
    setOfferUrl(null);
    setSummary(null);
    setStatus({ state: "idle", latency: null, detail: null });
  }, []);

  const start = useCallback(async () => {
    linkRef.current?.close();
    const link = new PeerLink([], { compact: true });
    const stats = new LinkStats();
    linkRef.current = link;
    statsRef.current = stats;
    answeredRef.current = false;
    remotePoseRef.current = null;
    link.onStatus(setStatus);
    link.onMessage((m) => {
      const now = performance.now();
      if (m.kind === "pose") {
        const local = localPoseRef.current;
        const localAge = local ? now - local.timestamp : null;
        stats.frame(m.frame.timestamp, now, localAge !== null && localAge < LOCAL_STALE_MS ? localAge : null);
        remotePoseRef.current = m.frame;
      } else if (m.kind === "sync" && m.t1 !== undefined) {
        stats.clock.add(m.t0, m.t1, now);
      } else if (m.kind === "sensorStats") {
        stats.report(m.produced, m.sent);
      }
    });
    try {
      const code = await link.host();
      if (linkRef.current !== link) return;
      // The code rides in the fragment: it never reaches a server's logs.
      const url = new URL(window.location.href);
      url.search = "?sensor";
      url.hash = code;
      setOfferUrl(url.toString());
    } catch {
      // PeerLink has already published the failure.
    }
  }, [localPoseRef]);

  /** For a reply typed or pasted in, when the webcam cannot read it. */
  const complete = useCallback(async (code: string) => {
    const link = linkRef.current;
    if (!link || answeredRef.current) return;
    answeredRef.current = true;
    try {
      await link.complete(code);
    } catch {
      answeredRef.current = false;
    }
  }, []);

  // Read the phone's reply off the webcam while waiting for it.
  const waiting = enabled && offerUrl !== null && status.state === "connecting";
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    let timer: ReturnType<typeof setTimeout> | null = null;
    setScanning(true);
    void loadQrDecoder().then((jsQR) => {
      const tick = () => {
        if (cancelled) return;
        const video = videoRef.current;
        const text = video ? scanFrame(jsQR, video, canvas) : null;
        if (text && isCompactSignal(text) && !answeredRef.current) {
          void complete(text);
          setScanning(false);
          return;
        }
        timer = setTimeout(tick, SENSOR_CONFIG.scanIntervalMs);
      };
      tick();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      setScanning(false);
    };
  }, [waiting, videoRef, complete]);

  // Once open: clock sync out, summary up to React twice a second.
  const open = status.state === "open";
  useEffect(() => {
    if (!open) return;
    const sync = setInterval(() => {
      linkRef.current?.send({ kind: "sync", t0: performance.now() });
    }, SENSOR_CONFIG.syncIntervalMs);
    const show = setInterval(() => {
      setSummary(statsRef.current?.summary(performance.now()) ?? null);
    }, 500);
    return () => {
      clearInterval(sync);
      clearInterval(show);
    };
  }, [open]);

  useEffect(() => {
    window.__shadowboxSensor = () => statsRef.current?.summary(performance.now()) ?? null;
    return () => {
      delete window.__shadowboxSensor;
    };
  }, []);

  // Leaving the screen ends the link.
  useEffect(() => {
    if (!enabled) stop();
  }, [enabled, stop]);
  useEffect(() => () => linkRef.current?.close(), []);

  return { status, offerUrl, summary, scanning, remotePoseRef, start, stop, complete };
}
