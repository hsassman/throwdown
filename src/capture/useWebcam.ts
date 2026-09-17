import { useEffect, useRef, useState } from "react";
import { CAMERA_CONFIG } from "../config/tuning";

// Ported from the Flap project's pose/useWebcam.ts, with an added readout of
// the resolution/frame rate the browser actually granted (the constraints below
// are requests, not guarantees, and the risk log warns that
// real hardware behaviour is the thing to verify, not the requested config).

export type WebcamStatus = "idle" | "requesting" | "ready" | "denied" | "error";

export interface CameraInfo {
  width: number;
  height: number;
  frameRate: number;
  label: string;
}

export function useWebcam(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * The live stream, kept so it can be RE-ATTACHED if the <video> element is
   * ever replaced.
   *
   * This exists because of a real bug. The stream is attached exactly once, to
   * whatever element the ref held at that moment. If React unmounts that
   * element and mounts another — which it does whenever the same <video> is
   * written in two different branches of a tree — the ref silently points at a
   * fresh element with no `srcObject`, while the old one keeps the camera.
   * The result is a live camera, a green permission light, and a completely
   * frozen picture, with no error anywhere.
   *
   * The App is also structured to keep one element mounted, which is the real
   * fix. This is the belt to that pair of braces: a remount is a very easy
   * mistake to reintroduce and an extremely confusing one to diagnose.
   */
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<WebcamStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<CameraInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let stream: MediaStream | null = null;
    let cancelled = false;
    // The element the stream was actually attached to. Held separately from
    // videoRef so cleanup detaches from that same element rather than whatever
    // the ref happens to point at by teardown — the same reasoning as
    // `subscribedVideo` in usePoseTracking.ts.
    let attachedVideo: HTMLVideoElement | null = null;

    async function start() {
      setStatus("requesting");
      setError(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: CAMERA_CONFIG.width },
            height: { ideal: CAMERA_CONFIG.height },
            frameRate: { ideal: CAMERA_CONFIG.frameRate },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          attachedVideo = videoRef.current;
          attachedVideo.srcObject = stream;
          await attachedVideo.play();
        }

        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        setInfo({
          width: settings.width ?? 0,
          height: settings.height ?? 0,
          frameRate: settings.frameRate ?? 0,
          label: track?.label ?? "unknown camera",
        });
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setStatus("denied");
        } else {
          setStatus("error");
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    start();

    return () => {
      cancelled = true;
      streamRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      // Detach the ended stream too. Stopping tracks releases the camera, but
      // the element keeps holding the MediaStream (and its last frame) until
      // srcObject is cleared.
      if (attachedVideo) attachedVideo.srcObject = null;
    };
  }, [enabled]);

  // Runs after EVERY render, deliberately without a dependency array: its whole
  // job is to notice that the element under the ref has been swapped, and a ref
  // changing does not trigger anything. It is a couple of property reads when
  // nothing has changed.
  useEffect(() => {
    const el = videoRef.current;
    const stream = streamRef.current;
    if (!el || !stream || el.srcObject === stream) return;
    el.srcObject = stream;
    // A newly mounted element starts paused. Failure here is not actionable —
    // autoplay policy, or the element being torn down again mid-call — and
    // throwing out of an effect would take the app down over a video element.
    void el.play().catch(() => {});
  });

  return { videoRef, status, error, info };
}
