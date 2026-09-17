// Rolling performance statistics.
//
// the project's working rules requires milestone "done when" criteria to be
// actually measured, not assumed. The Flap project logged a single FPS number
// once a second, which is fine for a spot check but useless for deciding
// whether we clear the implementation plan's 24-30 FPS fallback trigger — a
// mean of 30 hides a p5 of 12, and it's the slow frames that lose punches.
//
// So: keep a rolling window of raw samples and report percentiles.

export interface Stats {
  count: number;
  mean: number;
  median: number;
  p5: number;
  p95: number;
  min: number;
  max: number;
}

const EMPTY: Stats = {
  count: 0,
  mean: 0,
  median: 0,
  p5: 0,
  p95: 0,
  min: 0,
  max: 0,
};

/** Fixed-capacity ring buffer of numeric samples with percentile readout. */
export class RollingStats {
  private samples: number[] = [];
  private head = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.samples.length < this.capacity) {
      this.samples.push(value);
    } else {
      this.samples[this.head] = value;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  reset(): void {
    this.samples = [];
    this.head = 0;
  }

  get size(): number {
    return this.samples.length;
  }

  compute(): Stats {
    const n = this.samples.length;
    if (n === 0) return EMPTY;

    const sorted = [...this.samples].sort((a, b) => a - b);
    // Nearest-rank percentile. With n in the hundreds the difference from an
    // interpolating definition is well below the noise floor here.
    const at = (q: number) =>
      sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];

    let sum = 0;
    for (const v of sorted) sum += v;

    return {
      count: n,
      mean: sum / n,
      median: at(0.5),
      p5: at(0.05),
      p95: at(0.95),
      min: sorted[0],
      max: sorted[n - 1],
    };
  }
}

export function formatStats(s: Stats, unit: string, digits = 1): string {
  if (s.count === 0) return "no samples";
  const f = (v: number) => v.toFixed(digits);
  return `med ${f(s.median)}${unit}  mean ${f(s.mean)}${unit}  p5 ${f(
    s.p5
  )}${unit}  p95 ${f(s.p95)}${unit}  min ${f(s.min)}  max ${f(s.max)}  n=${s.count}`;
}
