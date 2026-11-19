import { useEffect, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import { FRAMING_CONFIG } from "../config/tuning";
import { assessFraming, FramingCoach, lumaOf, type FramingIssue, type LumaSample } from "./framingCheck";

// Runs the framing check against the live camera. See framingCheck.ts.
//
// Brightness comes from the video itself, drawn into a tiny canvas twice a
// second - a 32x24 readback is a few microseconds and nothing else in the
// game needs it. The pose is read from the same ref everything else reads.
// React state changes only when the prompt does.

const SAMPLE_W = 32;
const SAMPLE_H = 24;
/** How often the pose is assessed, ms. Well below the coach's own hold
 *  times, so the hysteresis is what sets the pace, not this. */
const ASSESS_MS = 150;

export function useFramingCoach(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  poseRef: React.RefObject<PoseFrame | null>,
  enabled: boolean
): FramingIssue | null {
  const [issue, setIssue] = useState<FramingIssue | null>(null);

  useEffect(() => {
    if (!enabled) {
      setIssue(null);
      return;
    }
    const coach = new FramingCoach();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let luma: LumaSample | null = null;
    let lastLuma = 0;
    let shown: FramingIssue | null = null;

    const timer = window.setInterval(() => {
      const now = performance.now();
      const video = videoRef.current;
      if (ctx && video && video.readyState >= 2 && now - lastLuma >= FRAMING_CONFIG.lumaIntervalMs) {
        lastLuma = now;
        try {
          ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
          luma = lumaOf(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, SAMPLE_W, SAMPLE_H);
        } catch {
          // A video mid-transition throws; the last sample stands.
        }
      }
      const next = coach.update(assessFraming(poseRef.current, luma), now);
      if (next !== shown) {
        shown = next;
        setIssue(next);
      }
    }, ASSESS_MS);

    return () => window.clearInterval(timer);
  }, [videoRef, poseRef, enabled]);

  return issue;
}
