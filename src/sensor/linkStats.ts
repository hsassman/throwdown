import { SENSOR_CONFIG } from "../config/tuning";

// Measures the phone-to-laptop pose link: how far apart the two clocks are,
// how old a phone frame is by the time the laptop has it, and how many go
// missing. Pure, with every time passed in, so it is tested without a network.
//
// THE CLOCKS
//
// A phone frame is stamped with the phone's performance.now(), which shares
// no origin with the laptop's. The offset between them comes from a classic
// NTP exchange: the laptop sends t0, the phone stamps t1 and echoes both, the
// laptop receives at t2. If the two legs take equally long, the phone's clock
// read t1 at laptop time (t0 + t2) / 2, so
//
//   offset = t1 - (t0 + t2) / 2        (phone clock minus laptop clock)
//
// Wi-Fi legs are not equal, and the error is at most half the asymmetry, so
// the estimate is taken from the sample with the SHORTEST round trip in the
// window - the one with the least queueing on either leg to be asymmetric.

export interface SyncSample {
  rtt: number;
  offset: number;
}

export class ClockSync {
  private samples: SyncSample[] = [];

  /** One completed exchange. Times in ms, t0/t2 laptop clock, t1 phone. */
  add(t0: number, t1: number, t2: number): void {
    const rtt = t2 - t0;
    if (!(rtt >= 0) || !Number.isFinite(t1)) return;
    this.samples.push({ rtt, offset: t1 - (t0 + t2) / 2 });
    if (this.samples.length > SENSOR_CONFIG.syncWindow) this.samples.shift();
  }

  private best(): SyncSample | null {
    let best: SyncSample | null = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }

  /** Phone clock minus laptop clock, ms, or null before the first sample. */
  get offset(): number | null {
    return this.best()?.offset ?? null;
  }

  /** The fastest recent round trip, ms. */
  get rtt(): number | null {
    return this.best()?.rtt ?? null;
  }

  /** A phone timestamp on the laptop's clock. */
  toLocal(remote: number): number | null {
    const o = this.offset;
    return o === null ? null : remote - o;
  }
}

export interface LinkSummary {
  /** Phone clock minus laptop clock, ms. */
  offsetMs: number | null;
  rttMs: number | null;
  /** How old a phone frame is on arrival, measured from the moment the phone
   *  stamped it (its camera frame time) to the laptop receiving it. */
  ageP50: number | null;
  ageP95: number | null;
  /**
   * How far the phone's pose trails the laptop's own, ms: a phone frame's age
   * less the laptop's latest frame's age at the same moment. This is the
   * number that decides whether fusing the two views works. The phone's
   * tracking time is inside `age`, but the laptop's own camera pays a
   * similar cost, so what a fused pose actually has to bridge is the gap.
   */
  lagP50: number | null;
  lagP95: number | null;
  /** Frames per second arriving at the laptop. */
  fps: number;
  received: number;
  /** The phone's own counters, from its last report. */
  produced: number;
  sent: number;
  /** Frames the phone sent that never arrived, as a share of those sent. */
  lostPct: number | null;
  /** Frames the phone tracked but could not send (channel backed up). */
  phoneDropPct: number | null;
  /** Gaps between arrivals longer than SENSOR_CONFIG.stallMs. */
  stalls: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

export class LinkStats {
  readonly clock = new ClockSync();
  private ages: number[] = [];
  private lags: number[] = [];
  private arrivals: number[] = [];
  private lastArrival: number | null = null;
  private lastTimestamp: number | null = null;
  private received = 0;
  private stalls = 0;
  private produced = 0;
  private sent = 0;
  /** `received` when the phone's last report arrived, so loss is compared
   *  like for like rather than against frames still in flight. */
  private receivedAtReport = 0;

  /** A pose frame arrived. `stamp` is the phone's timestamp, `now` the
   *  laptop's clock, `localAge` the age of the laptop's own latest pose if
   *  it has one. A frame repeating the last timestamp is ignored. */
  frame(stamp: number, now: number, localAge: number | null = null): void {
    if (stamp === this.lastTimestamp) return;
    this.lastTimestamp = stamp;
    this.received++;
    if (this.lastArrival !== null && now - this.lastArrival > SENSOR_CONFIG.stallMs) this.stalls++;
    this.lastArrival = now;
    this.arrivals.push(now);
    const cutoff = now - SENSOR_CONFIG.fpsWindowMs;
    while (this.arrivals.length > 0 && this.arrivals[0] < cutoff) this.arrivals.shift();

    const local = this.clock.toLocal(stamp);
    if (local !== null) {
      this.ages.push(now - local);
      if (this.ages.length > SENSOR_CONFIG.ageWindow) this.ages.shift();
      if (localAge !== null) {
        this.lags.push(now - local - localAge);
        if (this.lags.length > SENSOR_CONFIG.ageWindow) this.lags.shift();
      }
    }
  }

  /** The phone's counters arrived. */
  report(produced: number, sent: number): void {
    this.produced = produced;
    this.sent = sent;
    this.receivedAtReport = this.received;
  }

  summary(now: number): LinkSummary {
    const sorted = [...this.ages].sort((a, b) => a - b);
    const lags = [...this.lags].sort((a, b) => a - b);
    const recent = this.arrivals.filter((t) => t >= now - SENSOR_CONFIG.fpsWindowMs);
    // The channel is ordered, so every frame counted in a report that has
    // arrived has either arrived itself or been lost.
    const lostPct =
      this.sent > 0 ? Math.max(0, (this.sent - this.receivedAtReport) / this.sent) * 100 : null;
    return {
      offsetMs: this.clock.offset,
      rttMs: this.clock.rtt,
      ageP50: percentile(sorted, 0.5),
      ageP95: percentile(sorted, 0.95),
      lagP50: percentile(lags, 0.5),
      lagP95: percentile(lags, 0.95),
      fps: recent.length / (SENSOR_CONFIG.fpsWindowMs / 1000),
      received: this.received,
      produced: this.produced,
      sent: this.sent,
      lostPct,
      phoneDropPct: this.produced > 0 ? ((this.produced - this.sent) / this.produced) * 100 : null,
      stalls: this.stalls,
    };
  }
}
