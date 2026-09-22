import { describe, it, expect } from "vitest";
import { decode, encode, PROTOCOL_VERSION, type NetMessage } from "./protocol";
import { ALL_POSE_KEYS, type PoseFrame } from "../pose/poseTypes";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
} from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";

// The wire format is the one place in this project where BOTH ends of a bug
// are out of reach: a mismatch does not throw, it makes the other fighter
// stand slightly wrong, or a punch land somewhere it did not. So every field
// that crosses is asserted to come back, rather than the shape being spot
// checked.

const kp = (x: number, y: number, c = 1) => ({ x, y, confidence: c });

const frame = (): PoseFrame => ({
  timestamp: 1234567.8125,
  leftShoulder: kp(0.58, 0.38),
  rightShoulder: kp(0.42, 0.38),
  leftElbow: kp(0.63, 0.5),
  rightElbow: kp(0.37, 0.5),
  leftWrist: kp(0.66, 0.62, 0.8),
  rightWrist: kp(0.34, 0.63),
  leftHip: kp(0.56, 0.72),
  rightHip: kp(0.44, 0.72),
  nose: kp(0.5, 0.22),
  leftEye: kp(0.53, 0.21),
  rightEye: kp(0.47, 0.21),
  leftEar: kp(0.56, 0.22),
  rightEar: kp(0.44, 0.22),
  leftKnee: kp(0.55, 0.88, 0.4),
  rightKnee: kp(0.45, 0.88, 0.4),
});

describe("pose frames", () => {
  it("survives the round trip landmark for landmark", () => {
    const sent = frame();
    const got = decode(encode({ kind: "pose", frame: sent }));
    expect(got?.kind).toBe("pose");
    const back = (got as { frame: PoseFrame }).frame;
    for (const key of ALL_POSE_KEYS) {
      const a = sent[key];
      const b = back[key];
      if (!a) {
        // Absent landmarks come back as confidence 0 rather than missing, so
        // every message is the same size and the decoder never parses a
        // variable layout. A desk webcam loses the legs constantly; that is
        // the normal case, not an error.
        expect(b?.confidence, key).toBe(0);
        continue;
      }
      expect(b, `${key} is missing`).toBeDefined();
      expect(b!.x, `${key}.x`).toBeCloseTo(a.x, 5);
      expect(b!.y, `${key}.y`).toBeCloseTo(a.y, 5);
      expect(b!.confidence, `${key}.confidence`).toBeCloseTo(a.confidence, 5);
    }
  });

  it("keeps the timestamp to sub-millisecond precision", () => {
    // Carried as a float64 for this reason: performance.now() runs into the
    // millions of milliseconds in a long session, where a float32 has already
    // lost whole milliseconds — and the timestamp is what the latency estimate
    // and the pose predictor both key off.
    const sent = { ...frame(), timestamp: 9_876_543.211 };
    const got = decode(encode({ kind: "pose", frame: sent }));
    expect((got as { frame: PoseFrame }).frame.timestamp).toBeCloseTo(
      sent.timestamp,
      6
    );
  });

  it("is small enough to send at pose rate", () => {
    // 21 landmarks at 4 floats is 336 bytes plus a 16-byte header. At ~15 Hz
    // that is about 5 KB/s per fighter, which is the whole argument for
    // sending the pose itself rather than a digest of it.
    expect(encode({ kind: "pose", frame: frame() }).byteLength).toBeLessThan(400);
  });

  it("is a fixed size regardless of which landmarks are present", () => {
    const full = {
      ...frame(),
      leftAnkle: kp(0.55, 0.98),
      rightAnkle: kp(0.45, 0.98),
    };
    expect(encode({ kind: "pose", frame: full }).byteLength).toBe(
      encode({ kind: "pose", frame: frame() }).byteLength
    );
  });
});

describe("control messages", () => {
  it("round-trips a handshake", () => {
    const hello: NetMessage = {
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      name: "Red",
      host: true,
    };
    expect(decode(encode(hello))).toEqual(hello);
  });

  it("round-trips a strike with its geometry intact", () => {
    // The strike carries everything hit resolution already derived. Re-deriving
    // it on the far side from a summary would let the two ends disagree about
    // what a punch was worth, which is the one disagreement that matters.
    const impact = { lateral: 0.12, height: 1.18, depth: 0.1 };
    const region = regionAt(impact);
    const approach = approachOf(0.2, 0.3, 2.6);
    const strike: StrikeEvent = {
      hand: "right",
      zone: coarseZone(impact),
      impact,
      region,
      approach,
      damage: damageOf(region, 0.8, approach),
      power: 0.8,
      speed: 4.2,
      contactReach: 1.29,
      timestamp: 4242,
    };
    const back = decode(encode({ kind: "strike", strike }));
    expect(back).toEqual({ kind: "strike", strike });
  });

  it("round-trips a fight state", () => {
    const state = {
      round: 2,
      clock: 74.5,
      phase: "fighting" as const,
      health: [88, 61] as [number, number],
      stamina: [0.7, 0.44] as [number, number],
      down: [0, 1] as [number, number],
      hurt: [0.2, 1] as [number, number],
      count: 4,
      countOn: "guest" as const,
    };
    expect(decode(encode({ kind: "state", state }))).toEqual({
      kind: "state",
      state,
    });
  });
});

describe("a peer is untrusted input", () => {
  // Every one of these arrives inside the data channel's own callback. A throw
  // there takes the connection down with it, so a malformed frame has to drop
  // quietly rather than propagate.
  it("drops an empty frame", () => {
    expect(decode(new ArrayBuffer(0))).toBeNull();
  });

  it("drops an unknown tag", () => {
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf)[0] = 99;
    expect(decode(buf)).toBeNull();
  });

  it("drops a truncated pose frame", () => {
    const full = encode({ kind: "pose", frame: frame() });
    expect(decode(full.slice(0, full.byteLength - 12))).toBeNull();
  });

  it("drops malformed JSON", () => {
    const bad = new Uint8Array([2, 0x7b, 0x7b, 0x7b]);
    expect(decode(bad.buffer)).toBeNull();
  });

  it("drops a well-formed message of an unknown kind", () => {
    const json = new TextEncoder().encode(JSON.stringify({ kind: "surprise", n: 1 }));
    const out = new Uint8Array(1 + json.length);
    out[0] = 2;
    out.set(json, 1);
    expect(decode(out.buffer)).toBeNull();
  });
});
