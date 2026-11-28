import { midpoint, type PoseFrame } from "../pose/poseTypes";
import { FRAMING_CONFIG as C } from "../config/tuning";

// Is the camera seeing the player well enough to play, and if not, what
// should they do?

export type FramingIssue =
  | "noBody"
  | "tooDark"
  | "backlit"
  | "tooClose"
  | "tooFar"
  | "offLeft"
  | "offRight"
  | "handsHidden";

/** Most important first: the first issue found is the one shown. */
export const FRAMING_PRIORITY: readonly FramingIssue[] = [
  "noBody",
  "tooDark",
  "backlit",
  "tooClose",
  "tooFar",
  "offLeft",
  "offRight",
  "handsHidden",
];

/** What to tell the player. Instructions, not diagnoses. */
export const FRAMING_ADVICE: Record<FramingIssue, string> = {
  noBody: "Step into view of the camera",
  tooDark: "Too dark - turn on a light in front of you",
  backlit: "Bright light behind you - face the window or lamp instead",
  tooClose: "Step back - head to hips should be in view",
  tooFar: "Step closer to the camera",
  offLeft: "Step to your left",
  offRight: "Step to your right",
  handsHidden: "Keep both hands in view",
};

/** A brightness sample of the frame. */
export interface LumaSample {
  /** Mean luma of the whole frame, 0-255. */
  mean: number;
  /** Mean luma of the centre region, where the player stands. */
  centre: number;
  /** Mean luma of the outer ring. */
  edge: number;
}

/** Every issue present in this sample, in priority order. */
export function assessFraming(pose: PoseFrame | null, luma: LumaSample | null): FramingIssue[] {
  const issues: FramingIssue[] = [];
  const seen = (k: { confidence: number } | undefined) => !!k && k.confidence >= C.minConfidence;

  if (luma) {
    if (luma.mean < C.minLuma) issues.push("tooDark");
    else if (luma.edge - luma.centre > C.backlightMargin) issues.push("backlit");
  }

  const shoulders = pose ? midpoint(pose.leftShoulder, pose.rightShoulder) : null;
  if (!pose || !shoulders || shoulders.confidence < C.minConfidence) {
    // Darkness explains a missing body better than "step into view" does.
    if (!issues.includes("tooDark")) issues.unshift("noBody");
    return order(issues);
  }

  const hips = midpoint(pose.leftHip, pose.rightHip);
  const headTop = pose.nose && seen(pose.nose) ? pose.nose.y : null;
  const hipsSeen = hips.confidence >= C.minConfidence && hips.y <= 1 - C.edgeMargin;
  const torso = hipsSeen ? Math.hypot(shoulders.x - hips.x, shoulders.y - hips.y) : null;

  if (!hipsSeen || (headTop !== null && headTop < C.minNoseY) || (torso !== null && torso > C.maxTorso)) {
    issues.push("tooClose");
  } else if (torso !== null && torso < C.minTorso) {
    issues.push("tooFar");
  }

  // The raw camera frame is unmirrored, but the player sees a mirror. Small x
  // is the player's own right side of the image, which in their mirror view is
  // the right of the screen: they are standing too far to their right.
  if (shoulders.x < C.offCentre) issues.push("offLeft");
  else if (shoulders.x > 1 - C.offCentre) issues.push("offRight");

  if (!seen(pose.leftWrist) || !seen(pose.rightWrist)) issues.push("handsHidden");

  return order(issues);
}

function order(issues: FramingIssue[]): FramingIssue[] {
  return FRAMING_PRIORITY.filter((i) => issues.includes(i));
}

/** Turns per-sample assessments into a steady prompt. */
export class FramingCoach {
  private shown: FramingIssue | null = null;
  private candidate: FramingIssue | null = null;
  private candidateSince = 0;
  private cleanSince: number | null = null;

  /** Feeds one assessment at time `t` (ms); returns the issue to show, if any. */
  update(issues: FramingIssue[], t: number): FramingIssue | null {
    const top = issues[0] ?? null;
    if (top === null) {
      this.candidate = null;
      if (this.cleanSince === null) this.cleanSince = t;
      if (this.shown && t - this.cleanSince >= C.hideAfterMs) this.shown = null;
      return this.shown;
    }
    this.cleanSince = null;
    if (top !== this.candidate) {
      this.candidate = top;
      this.candidateSince = t;
    }
    // Switching from one shown problem to another is immediate once the new
    // one has held - the player is already reading a prompt.
    if (t - this.candidateSince >= C.showAfterMs) this.shown = top;
    return this.shown;
  }

  reset(): void {
    this.shown = null;
    this.candidate = null;
    this.cleanSince = null;
  }
}

/**
 * Brightness of an RGBA pixel buffer: whole frame, centre third, outer ring.
 * Rec. 601 luma, which is what "too dark for the camera" means.
 */
export function lumaOf(data: Uint8ClampedArray, width: number, height: number): LumaSample {
  let all = 0;
  let centre = 0;
  let centreN = 0;
  let edge = 0;
  let edgeN = 0;
  const x0 = width / 3;
  const x1 = (2 * width) / 3;
  const y0 = height / 3;
  const y1 = (2 * height) / 3;
  const ex = width / 6;
  const ey = height / 6;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      all += l;
      if (x >= x0 && x < x1 && y >= y0 && y < y1) {
        centre += l;
        centreN++;
      } else if (x < ex || x >= width - ex || y < ey || y >= height - ey) {
        edge += l;
        edgeN++;
      }
    }
  }
  const n = width * height;
  return {
    mean: n ? all / n : 0,
    centre: centreN ? centre / centreN : 0,
    edge: edgeN ? edge / edgeN : 0,
  };
}
