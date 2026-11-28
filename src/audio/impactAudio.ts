// Impact sound, synthesised. No audio files.

import type { StrikeEvent } from "../perception/strikeResolver";
import { getSharedAudioContext } from "./sharedContext";

export interface ImpactAudioOptions {
  master?: number;
  /** Crowd swell on significant hits. */
  crowd?: boolean;
}

export interface ImpactAudio {
  /** Plays the sound for a resolved strike. */
  play(strike: StrikeEvent, opts?: { blocked?: boolean }): void;
  /** Leather-on-air, for a punch that resolved as a miss or a feint. */
  whiff(power: number): void;
  /** Round bell. Two strikes to open, one to close. */
  bell(count?: number): void;
  setMaster(v: number): void;
  /** Browsers suspend audio until a user gesture. Call from a click. */
  resume(): Promise<void>;
  dispose(): void;
}

/** Recorded one-shots in public/sfx (Openverse, CC0 and CC BY; see docs/CREDITS.md). */
const SAMPLES = ["head-1", "head-2", "body-1", "body-2", "block", "whiff", "bell", "crowd-1", "crowd-2"] as const;
type SampleName = (typeof SAMPLES)[number];

/** Decoded once per audio context and shared by every fight. A sample that
 *  fails to load leaves the synthesised sound in its place. */
const sampleCache = new WeakMap<AudioContext, Map<SampleName, AudioBuffer>>();

function loadSamples(ctx: AudioContext): Map<SampleName, AudioBuffer> {
  let bank = sampleCache.get(ctx);
  if (bank) return bank;
  bank = new Map();
  sampleCache.set(ctx, bank);
  if (typeof fetch !== "function") return bank;
  const base = `${import.meta.env.BASE_URL}sfx/`;
  for (const name of SAMPLES) {
    fetch(`${base}${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((data) => ctx.decodeAudioData(data))
      .then((buf) => bank!.set(name, buf))
      .catch(() => {});
  }
  return bank;
}

/** One buffer of white noise, shared by every impact. */
function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export function createImpactAudio(options: ImpactAudioOptions = {}): ImpactAudio | null {
  // The app-wide context, unlocked by a real tap (see sharedContext.ts). A
  // context created here, when a fight starts, would never be inside a user
  // gesture on a camera-driven menu, and would stay silent.
  const shared = getSharedAudioContext();
  if (!shared) return null;
  const ctx: AudioContext = shared;
  const master = ctx.createGain();
  master.gain.value = options.master ?? 0.8;

  // A limiter on the bus. Not polish - a five-punch combination stacks five
  // overlapping transients, and without compression the sum clips audibly on
  // exactly the moments that should sound best.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.14;

  // Room. A short convolution reverb built from decaying noise - an impulse
  // response costs nothing to generate and is what stops every hit sounding
  // like it happened in a padded box.
  const room = ctx.createConvolver();
  room.buffer = (() => {
    const seconds = 0.9;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
    }
    return buf;
  })();
  const roomSend = ctx.createGain();
  roomSend.gain.value = 0.22;

  master.connect(limiter);
  limiter.connect(ctx.destination);
  master.connect(roomSend);
  roomSend.connect(room);
  room.connect(limiter);

  const noise = noiseBuffer(ctx, 1);
  const samples = loadSamples(ctx);
  let disposed = false;
  let flip = 0;

  /** Plays a recorded one-shot. False when it has not loaded, so the caller can synthesise. */
  function sample(name: SampleName, t0: number, gain: number, rate = 0.94 + Math.random() * 0.12): boolean {
    const buf = samples.get(name);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(master);
    src.start(t0);
    return true;
  }

  /** Schedules one impact. All timing is relative to `t0`. */
  function impact(
    t0: number,
    { bright, weight, level }: { bright: number; weight: number; level: number }
  ) {
    // --- Slap: filtered noise transient --------------------------------
    const src = ctx.createBufferSource();
    src.buffer = noise;
    // Random start offset into the shared buffer, so repeated punches are not
    // bit-identical. Two consecutive samples of the exact same noise is the
    // single most obvious "this is synthesised" tell.
    src.loop = true;
    src.loopStart = Math.random() * 0.8;
    src.loopEnd = src.loopStart + 0.2;

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    // 900 Hz for a body shot up to ~3.2 kHz for a flush head shot.
    band.frequency.value = 900 + bright * 2300;
    band.Q.value = 0.8;

    const slapGain = ctx.createGain();
    const slapLen = 0.045 + (1 - bright) * 0.05;
    slapGain.gain.setValueAtTime(0, t0);
    slapGain.gain.linearRampToValueAtTime(level * 0.9, t0 + 0.002);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, t0 + slapLen);

    src.connect(band);
    band.connect(slapGain);
    slapGain.connect(master);
    src.start(t0);
    src.stop(t0 + slapLen + 0.02);

    // --- Thud: pitched body resonance ----------------------------------
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const baseHz = 58 + (1 - weight) * 55;
    osc.frequency.setValueAtTime(baseHz * 2.1, t0);
    // The downward sweep is what makes it read as an impact rather than a
    // note. A static sine at 60 Hz sounds like a test tone.
    osc.frequency.exponentialRampToValueAtTime(baseHz, t0 + 0.09);

    const thudGain = ctx.createGain();
    const thudLen = 0.1 + weight * 0.22;
    thudGain.gain.setValueAtTime(0, t0);
    thudGain.gain.linearRampToValueAtTime(level * weight * 1.1, t0 + 0.006);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, t0 + thudLen);

    osc.connect(thudGain);
    thudGain.connect(master);
    osc.start(t0);
    osc.stop(t0 + thudLen + 0.02);
  }

  /** A crowd swell - filtered noise with a slow envelope. */
  function swell(t0: number, level: number) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "bandpass";
    lp.frequency.value = 700;
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level * 0.28, t0 + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + 1.6);
  }

  return {
    play(strike, opts = {}) {
      if (disposed || ctx.state === "suspended") return;
      const t0 = ctx.currentTime;

      // The one axis that does most of the work: head shots are bright and
      // short, body shots dark and long. Taken from the continuous impact
      // height rather than the coarse zone, so the transition between them is
      // a gradient rather than a switch.
      const bright = Math.max(0, Math.min(1, (strike.impact.height - 0.55) / 0.75));
      const weight = 1 - bright * 0.55;

      let level = 0.25 + strike.power * 0.75;
      if (opts.blocked) {
        // A block is the same impact heard through a forearm: quieter, duller,
        // and with the crack taken off it.
        if (!sample("block", t0, level * 0.7)) {
          impact(t0, { bright: bright * 0.35, weight: weight * 0.8, level: level * 0.45 });
        }
        return;
      }

      // A strike to a soft target sounds different from one that hit bone. The
      // damage multiplier already encodes that distinction, so it is reused
      // rather than duplicated as a second table.
      level *= 0.7 + Math.min(1.6, strike.region.damage) * 0.3;
      flip ^= 1;
      const hit: SampleName = bright > 0.5 ? (flip ? "head-1" : "head-2") : flip ? "body-1" : "body-2";
      if (!sample(hit, t0, Math.min(1, level))) impact(t0, { bright, weight, level });

      if (options.crowd !== false && strike.damage > 1.1) {
        const swellLevel = Math.min(1, strike.damage / 2.2);
        if (!sample(flip ? "crowd-1" : "crowd-2", t0 + 0.08, swellLevel * 0.55, 1)) swell(t0 + 0.08, swellLevel);
      }
    },

    whiff(power) {
      if (disposed || ctx.state === "suspended") return;
      const t0 = ctx.currentTime;
      if (sample("whiff", t0, 0.25 + 0.45 * power)) return;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.09 * power, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      src.connect(hp);
      hp.connect(g);
      g.connect(master);
      src.start(t0);
      src.stop(t0 + 0.22);
    },

    bell(count = 1) {
      if (disposed || ctx.state === "suspended") return;
      if (samples.has("bell")) {
        for (let i = 0; i < count; i++) sample("bell", ctx.currentTime + i * 0.45, 0.6, 1);
        return;
      }
      for (let i = 0; i < count; i++) {
        const t0 = ctx.currentTime + i * 0.42;
        // Two detuned partials. A bell is inharmonic - a single sine sounds
        // like a doorbell, and the beating between the two is the metallic
        // part of the timbre.
        for (const [hz, gain] of [
          [784, 0.3],
          [1173, 0.18],
          [2350, 0.07],
        ] as const) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = hz;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t0);
          g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8);
          osc.connect(g);
          g.connect(master);
          osc.start(t0);
          osc.stop(t0 + 1.9);
        }
      }
    },

    setMaster(v) {
      master.gain.value = Math.max(0, Math.min(1, v));
    },

    async resume() {
      // Every browser suspends an AudioContext created outside a user gesture.
      // This has to be called from a click, or nothing is ever heard and there
      // is no error to explain why.
      if (ctx.state === "suspended") await ctx.resume();
    },

    dispose() {
      disposed = true;
      // The context is shared and outlives this fight; unplug this fight's
      // nodes instead of closing it.
      master.disconnect();
      roomSend.disconnect();
      room.disconnect();
      limiter.disconnect();
    },
  };
}
