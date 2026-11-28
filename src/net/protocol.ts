import { ALL_POSE_KEYS, type AnyPoseKey, type Keypoint, type PoseFrame } from "../pose/poseTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { Evasion, FightEvent, FightPhase, GuardPosture } from "../sim/fightState";

// What two fighters send each other. Each end draws the other from their pose
// frames, run through the same RigDriver as the local player. The host runs
// the simulation; the guest sends its punches and its defence, and gets the
// state and every fight event back.

/** Bumped whenever a message shape changes. Checked in the handshake. */
export const PROTOCOL_VERSION = 4;

export interface NetDefence {
  guard: GuardPosture;
  evasion: Evasion;
}

export type NetMessage =
  | {
      kind: "hello";
      protocol: number;
      name: string;
      host: boolean;
      /** True on a hello that wants a reply; latency is timed on that exchange. */
      ping?: boolean;
    }
  | { kind: "pose"; frame: PoseFrame }
  | { kind: "strike"; strike: StrikeEvent }
  | { kind: "state"; state: NetFightState }
  /** Guest to host: the guest's guard and head movement, from its own camera. */
  | { kind: "defence"; defence: NetDefence }
  /** Host to guest: a fight event, with the strike that caused it when there was one. */
  | { kind: "event"; event: FightEvent; strike?: StrikeEvent }
  /** Either way: this player wants another fight. */
  | { kind: "rematch" }
  | { kind: "bye"; reason: string };

/** The host's view of the fight, as the guest needs to draw it. Arrays are [host, guest]. */
export interface NetFightState {
  round: number;
  clock: number;
  phase: FightPhase;
  health: [number, number];
  stamina: [number, number];
  down: [number, number];
  hurt: [number, number];
  landed: [number, number];
  count: number;
  countOn: "host" | "guest" | null;
}

/**
 * A host event as the guest sees it. The host's sim names its own player
 * `self` and the guest `other`; the guest's names are the other way round.
 */
export function mirrorEvent(e: FightEvent, self: string, other: string): FightEvent {
  const swap = (id: string) => (id === self ? other : id === other ? self : id);
  const swapKeys = (r: Record<string, number>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [swap(k), v]));
  switch (e.type) {
    case "land":
    case "block":
    case "miss":
    case "knockdown":
      return { ...e, target: swap(e.target) };
    case "foul":
      return { ...e, by: swap(e.by) };
    case "roundEnd":
      return { ...e, scores: swapKeys(e.scores) };
    case "stoppage":
      return { ...e, winner: swap(e.winner) };
    case "decision":
      return { ...e, winner: e.winner === null ? null : swap(e.winner), cards: swapKeys(e.cards) };
  }
}

/** 4 floats per landmark — x, y, z, confidence — matching the layout the pose
 *  worker already uses across its own boundary. One transport order, defined
 *  once in ALL_POSE_KEYS, so the two cannot drift apart. */
const FLOATS_PER_KEY = 4;
const POSE_FLOATS = ALL_POSE_KEYS.length * FLOATS_PER_KEY;
const TAG_POSE = 1;
const TAG_JSON = 2;

// Pose frame layout. Fixed offsets rather than a packed header, because a
// Float32Array view onto a buffer must start on a 4-byte boundary and a
// Float64 on an 8-byte one - a misaligned view throws rather than reading
// something slightly wrong, so the padding is load-bearing.
//
//   0        tag byte
//   8..16    float64 timestamp - performance.now() runs into the millions of
//                                milliseconds in a long session, where a
//                                float32 has already lost whole milliseconds,
//                                and this is what the latency estimate and
//                                the pose predictor both key off
//   16..     4 floats per landmark, in ALL_POSE_KEYS order
const POSE_TIME = 8;
const POSE_BODY = 16;

/**
 * A landmark missing from the frame is sent as confidence 0 rather than
 * omitted, so every pose message is exactly the same size and the decoder
 * never has to parse a variable layout. `EXTRA_POSE_KEYS` are absent most of
 * the time at a desk webcam — that is the normal case, not an error.
 */
const ABSENT: Keypoint = { x: 0, y: 0, confidence: 0 };

export function encode(msg: NetMessage): ArrayBuffer {
  if (msg.kind !== "pose") {
    const json = new TextEncoder().encode(JSON.stringify(msg));
    const out = new Uint8Array(1 + json.length);
    out[0] = TAG_JSON;
    out.set(json, 1);
    return out.buffer;
  }

  const buf = new ArrayBuffer(POSE_BODY + POSE_FLOATS * 4);
  new Uint8Array(buf)[0] = TAG_POSE;
  new DataView(buf).setFloat64(POSE_TIME, msg.frame.timestamp, true);

  const f = new Float32Array(buf, POSE_BODY, POSE_FLOATS);
  for (let i = 0; i < ALL_POSE_KEYS.length; i++) {
    const kp = msg.frame[ALL_POSE_KEYS[i]] ?? ABSENT;
    const o = i * FLOATS_PER_KEY;
    f[o] = kp.x;
    f[o + 1] = kp.y;
    f[o + 2] = kp.z ?? 0;
    f[o + 3] = kp.confidence;
  }
  return buf;
}

export function decode(buf: ArrayBuffer): NetMessage | null {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return null;

  if (bytes[0] === TAG_JSON) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
      return isMessage(msg) ? msg : null;
    } catch {
      // A peer is untrusted input. A malformed frame drops, it does not throw
      // into the data channel's callback and take the connection with it.
      return null;
    }
  }

  if (bytes[0] !== TAG_POSE) return null;
  if (buf.byteLength !== POSE_BODY + POSE_FLOATS * 4) return null;

  const f = new Float32Array(buf, POSE_BODY, POSE_FLOATS);
  const frame: Record<string, unknown> = {
    timestamp: new DataView(buf).getFloat64(POSE_TIME, true),
  };
  for (let i = 0; i < ALL_POSE_KEYS.length; i++) {
    const o = i * FLOATS_PER_KEY;
    const key: AnyPoseKey = ALL_POSE_KEYS[i];
    frame[key] = { x: f[o], y: f[o + 1], z: f[o + 2], confidence: f[o + 3] };
  }
  return { kind: "pose", frame: frame as unknown as PoseFrame };
}

const GUARDS = new Set(["high", "low", "none"]);
const EVASIONS = new Set(["none", "slipLeft", "slipRight", "duck"]);
const EVENTS = new Set(["land", "block", "miss", "foul", "knockdown", "roundEnd", "stoppage", "decision"]);

/** A peer is untrusted: anything that does not look like a known message is dropped. */
function isMessage(m: unknown): m is NetMessage {
  if (!m || typeof m !== "object") return false;
  const msg = m as Record<string, unknown>;
  switch (msg.kind) {
    case "hello":
    case "strike":
    case "state":
    case "rematch":
    case "bye":
      return true;
    case "defence": {
      const d = msg.defence as Record<string, unknown> | undefined;
      return !!d && GUARDS.has(d.guard as string) && EVASIONS.has(d.evasion as string);
    }
    case "event": {
      const e = msg.event as Record<string, unknown> | undefined;
      return !!e && EVENTS.has(e.type as string);
    }
    default:
      return false;
  }
}
