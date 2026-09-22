// Confusion matrix and accuracy scoring for Milestone 1.
//
// Reports per-class recall/precision/F1 and a macro average, never a single
// blended number - headline accuracy is misleading under class imbalance. The
// bars below were fixed before any data was collected (risk log OQ2).

import { PUNCH_FAMILY, type PunchEvent, type PunchType } from "../perception/punchTypes";

export const PUNCH_TYPES: PunchType[] = ["jab", "cross", "hook", "uppercut"];

/** One prompted rep. `detected` is null when nothing was detected at all. */
export interface Trial {
  prompted: PunchType;
  detected: PunchType | null;
  event: PunchEvent | null;
  at: number;
}

export interface ClassScore {
  type: PunchType;
  prompted: number;
  detected: number;
  correct: number;
  recall: number;
  precision: number;
  f1: number;
}

export interface Evaluation {
  trials: number;
  /** matrix[prompted][detected|"none"] */
  matrix: Record<PunchType, Record<string, number>>;
  perClass: ClassScore[];
  macroRecall: number;
  macroF1: number;
  /** Fraction of prompted punches that produced any detection at all. */
  detectionRate: number;
  /** Accuracy of straight-vs-curved, over detected punches only. */
  familyAccuracy: number;
  /** Accuracy of lead-vs-rear hand, over detected punches only. */
  handAccuracy: number;
  /** Mean pose samples per detected punch - low values mean frame starvation. */
  meanSampleCount: number;
}

function emptyMatrix(): Record<PunchType, Record<string, number>> {
  const m = {} as Record<PunchType, Record<string, number>>;
  for (const p of PUNCH_TYPES) {
    m[p] = { none: 0 };
    for (const d of PUNCH_TYPES) m[p][d] = 0;
  }
  return m;
}

export function evaluate(trials: Trial[]): Evaluation {
  const matrix = emptyMatrix();
  for (const t of trials) {
    matrix[t.prompted][t.detected ?? "none"]++;
  }

  const perClass: ClassScore[] = PUNCH_TYPES.map((type) => {
    const prompted = trials.filter((t) => t.prompted === type).length;
    const detected = trials.filter((t) => t.detected === type).length;
    const correct = trials.filter(
      (t) => t.prompted === type && t.detected === type
    ).length;
    const recall = prompted > 0 ? correct / prompted : 0;
    const precision = detected > 0 ? correct / detected : 0;
    const f1 =
      recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
    return { type, prompted, detected, correct, recall, precision, f1 };
  });

  const withDetection = trials.filter((t) => t.detected !== null);
  const familyCorrect = withDetection.filter(
    (t) => PUNCH_FAMILY[t.prompted] === PUNCH_FAMILY[t.detected as PunchType]
  ).length;

  // Lead/rear is scored from the expected role of the prompted punch: jab and
  // hook are thrown with the lead hand in this protocol, cross and uppercut
  // with the rear. Scored only where a punch was detected.
  const handCorrect = withDetection.filter((t) => {
    const expectRole = t.prompted === "jab" || t.prompted === "hook" ? "lead" : "rear";
    return t.event?.role === expectRole;
  }).length;

  const sampleCounts = withDetection
    .map((t) => t.event?.features.sampleCount ?? 0)
    .filter((n) => n > 0);

  const classesWithData = perClass.filter((c) => c.prompted > 0);
  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  return {
    trials: trials.length,
    matrix,
    perClass,
    macroRecall: avg(classesWithData.map((c) => c.recall)),
    macroF1: avg(classesWithData.map((c) => c.f1)),
    detectionRate: trials.length ? withDetection.length / trials.length : 0,
    familyAccuracy: withDetection.length ? familyCorrect / withDetection.length : 0,
    handAccuracy: withDetection.length ? handCorrect / withDetection.length : 0,
    meanSampleCount: avg(sampleCounts),
  };
}

/** The bars fixed before measurement. See the risk log. */
export const BARS = {
  detectionRate: 0.9,
  handAccuracy: 0.95,
  familyAccuracy: 0.85,
  macroRecall: 0.7,
  minClassRecall: 0.5,
};

export interface BarResult {
  label: string;
  value: number;
  bar: number;
  pass: boolean;
}

export function checkBars(e: Evaluation): BarResult[] {
  const worstClass = e.perClass
    .filter((c) => c.prompted > 0)
    .reduce((min, c) => Math.min(min, c.recall), 1);

  return [
    {
      label: "Detection rate",
      value: e.detectionRate,
      bar: BARS.detectionRate,
      pass: e.detectionRate >= BARS.detectionRate,
    },
    {
      label: "Lead vs rear hand",
      value: e.handAccuracy,
      bar: BARS.handAccuracy,
      pass: e.handAccuracy >= BARS.handAccuracy,
    },
    {
      label: "Straight vs curved",
      value: e.familyAccuracy,
      bar: BARS.familyAccuracy,
      pass: e.familyAccuracy >= BARS.familyAccuracy,
    },
    {
      label: "4-way macro recall",
      value: e.macroRecall,
      bar: BARS.macroRecall,
      pass: e.macroRecall >= BARS.macroRecall,
    },
    {
      label: "Worst class recall",
      value: worstClass,
      bar: BARS.minClassRecall,
      pass: worstClass >= BARS.minClassRecall,
    },
  ];
}

/** Plain-text report, for pasting straight into the risk log. */
export function formatReport(e: Evaluation): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const lines: string[] = [];

  lines.push(`Trials: ${e.trials}`);
  lines.push("");
  lines.push("Confusion matrix (rows = thrown, cols = detected):");
  lines.push(
    `${"".padEnd(10)}${PUNCH_TYPES.map((t) => t.padStart(9)).join("")}${"none".padStart(9)}`
  );
  for (const p of PUNCH_TYPES) {
    const row = PUNCH_TYPES.map((d) => String(e.matrix[p][d]).padStart(9)).join("");
    lines.push(`${p.padEnd(10)}${row}${String(e.matrix[p].none).padStart(9)}`);
  }

  lines.push("");
  lines.push("Per class:");
  lines.push(
    `${"type".padEnd(10)}${"n".padStart(5)}${"recall".padStart(9)}${"prec".padStart(9)}${"F1".padStart(9)}`
  );
  for (const c of e.perClass) {
    lines.push(
      `${c.type.padEnd(10)}${String(c.prompted).padStart(5)}` +
        `${pct(c.recall).padStart(9)}${pct(c.precision).padStart(9)}${pct(c.f1).padStart(9)}`
    );
  }

  lines.push("");
  lines.push("Against the pre-set bars:");
  for (const b of checkBars(e)) {
    lines.push(
      `  ${b.pass ? "PASS" : "FAIL"}  ${b.label.padEnd(22)} ` +
        `${pct(b.value).padStart(5)}  (bar ${pct(b.bar)})`
    );
  }

  lines.push("");
  lines.push(`Macro F1: ${pct(e.macroF1)}`);
  lines.push(
    `Mean pose samples per punch: ${e.meanSampleCount.toFixed(1)}` +
      (e.meanSampleCount < 5
        ? "  <-- LOW: frame rate may be starving the classifier"
        : "")
  );

  return lines.join("\n");
}
