import {
  ALL_POSE_KEYS,
  type AnyPoseKey,
  type Keypoint,
  type PoseFrame,
} from "../pose/poseTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { FightPhase } from "../sim/fightState";

// What two fighters send each other.
// WHAT GOES OVER THE WIRE, AND WHY IT IS THE POSE
//
// The remote fighter is driven by their POSE FRAME, not by a summary of what
// they did. Their frame goes into the same RigDriver that draws the local
// player, so the figure on your screen ducks, slips, steps and throws exactly
// as the person at the other end did — because it is running the identical
// code on the identical input. Sending a digest instead ("they are slipping
// left, guard high") would mean building a second, lossier animation path and
// then maintaining the two in step.
//
// It is also small. Twenty-one landmarks at four floats each is 336 bytes, and
// the pose stream runs at about 15 Hz, so a fighter costs roughly 5 KB/s.
// AUTHORITY
//
// The HOST runs the simulation and the guest is told the result. This is not
// rollback netcode and does not pretend to be — there is no prediction and no
// reconciliation, so the guest sees the fight about one round-trip late.
//
// That is an honest arrangement for a first working version and a dishonest
// one to describe as anything more. The CPU's seeded determinism was built with
// rollback in mind and still is; what is missing is the input-history and
// re-simulation machinery, not the determinism underneath it.

/**
 * Bumped whenever the shape of anything below changes.
 *
 * Checked in the handshake, because the failure it prevents is the nastiest
 * one available here: two builds that connect happily and then disagree about
 * where a punch landed. A refused connection is a message; a silently
 * mismatched one is a bug report about hit detection.
 */
export const PROTOCOL_VERSION = 2;

export type NetMessage =
  | {
      kind: "hello";
      protocol: number;
      name: string;
      host: boolean;
      /**
       * True on a hello that WANTS a reply, false on the reply itself.
       *
       * Latency is measured by timing that exchange. Without the flag the only
       * hello a peer ever saw was the other end's own scheduled one, so the
       * number on screen was the time until their next ping — around half the
       * ping interval on average, and up to all of it. The host happened to
       * read 75 ms and the guest 1051 ms in the same session, which is the
       * kind of number that is worse than showing none at all.
       */
      ping?: boolean;
    }
  | { kind: "pose"; frame: PoseFrame }
  | { kind: "strike"; strike: StrikeEvent }
  | { kind: "state"; state: NetFightState }
  | { kind: "bye"; reason: string };

/**
 * The host's view of the fight, as the guest needs to draw it.
 *
 * Deliberately NOT the whole FightSim. Only what the HUD and the figures read
 * is sent, so a change to the simulation's internals cannot quietly become a
 * change to the wire format.
 */
export interface NetFightState {
  round: number;
  clock: number;
  phase: FightPhase;
  /** [host, guest] — always in that order, so neither end has to know which
   *  one it is to read the array. */
  health: [number, number];
  stamina: [number, number];
  down: [number, number];
  hurt: [number, number];
  count: number;
  /** Who the count is against, or null. */
  countOn: "host" | "guest" | null;
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

/** A peer is untrusted. Anything that does not look like a message we know is
 *  dropped rather than handed on to code that assumes its shape. */
function isMessage(m: unknown): m is NetMessage {
  if (!m || typeof m !== "object") return false;
  const kind = (m as { kind?: unknown }).kind;
  return (
    kind === "hello" || kind === "strike" || kind === "state" || kind === "bye"
  );
}
