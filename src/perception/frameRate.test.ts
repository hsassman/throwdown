import { describe, expect, it } from "vitest";
import { PunchClassifier } from "./punchClassifier";
import { syntheticPunch, type PunchShape } from "./synthetic";
import { TEST_CALIBRATION as CAL } from "./testCalibration";
import type { PunchEvent } from "./punchTypes";

// Frame-rate sensitivity of punch detection.
//
// Added after the first real measured run returned a 19% detection rate - a
// detection failure, not the classification failure the project documentation
// anticipates. The dev laptop runs pose tracking at ~15 FPS (66ms per frame),
// and the run reported a mean of 5.0 pose samples per detected punch, so the
// hypothesis is that the FSM is being starved of frames rather than defeated
// by the geometry.
//
// These tests hold the punch's real-world duration fixed and vary only the
// sampling rate, which isolates frame rate from every other variable.


/**
 * Throws one synthetic punch sampled at `fps`, holding the punch's physical
 * duration at roughly `durationMs`.
 *
 * `durationMs` is the outward phase only - the generator appends a retract of
 * the same length, so the whole punch takes twice this. 150ms out (300ms
 * round trip) is representative of a real jab; the earlier default of 300ms
 * out described a punch twice as slow as anything a boxer throws, and made
 * the mean-speed gate look borderline when it was the test that was wrong.
 */
function detectAt(
  kind: PunchShape,
  fps: number,
  durationMs = 150
): PunchEvent[] {
  const frameIntervalMs = 1000 / fps;
  const frames = Math.max(1, Math.round(durationMs / frameIntervalMs));
  const c = new PunchClassifier();
  const events: PunchEvent[] = [];
  for (const f of syntheticPunch(kind, {
    hand: "left",
    frames,
    frameIntervalMs,
    guardFrames: Math.max(3, Math.round(fps / 5)),
  })) {
    events.push(...c.update(f, CAL, f.timestamp));
  }
  return events;
}

describe("frame-rate sensitivity of punch detection", () => {
  // Every shape must detect at every plausible frame rate. The foreshortened
  // straight is the one that matters most: it is what a punch thrown at the
  // lens actually looks like, and it is what the first measured run consisted
  // of. It was undetectable at any frame rate under the previous design.
  for (const fps of [30, 20, 15, 12, 10]) {
    for (const shape of [
      "straight",
      "straightForeshortened",
      "hook",
      "uppercut",
    ] as const) {
      it(`detects a ${shape} punch at ${fps} FPS`, () => {
        expect(detectAt(shape, fps)).toHaveLength(1);
      });
    }
  }

  it("still detects a slow, lazy punch", () => {
    expect(detectAt("straightForeshortened", 30, 300)).toHaveLength(1);
  });

  it("reports how many samples each rate yields", () => {
    // Not an assertion so much as a recorded observation - the sample count is
    // what the results screen warns on, so it is worth having the synthetic
    // equivalent visible next to the real number.
    const rows: string[] = [];
    for (const fps of [30, 20, 15, 12, 10]) {
      for (const kind of [
        "straight",
        "straightForeshortened",
        "hook",
        "uppercut",
      ] as const) {
        const e = detectAt(kind, fps);
        rows.push(
          `${String(fps).padStart(3)}fps ${kind.padEnd(9)} ` +
            `detected=${e.length} samples=${e[0]?.features.sampleCount ?? "-"}`
        );
      }
    }
    console.log("\n" + rows.join("\n"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
