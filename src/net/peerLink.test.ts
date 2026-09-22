import { describe, it, expect } from "vitest";
import { decodeSignal, encodeSignal } from "./peerLink";

// Only the code players copy is testable without a browser — RTCPeerConnection
// does not exist in this environment, so the connection itself is exercised in
// the headless smoke, where two real pages connect to each other.
//
// The codec is worth its own tests anyway, because every one of its failures
// lands on a player at the exact moment they are trying to start a fight with
// a friend, and the only diagnostic they have is "it says that's not a code".

const sdp = (type: "offer" | "answer") =>
  ({
    type,
    sdp: `v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\na=candidate:1 1 udp 2113937151 192.168.1.24 51234 typ host\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
  }) as RTCSessionDescription;

describe("the code players copy", () => {
  it("round-trips an offer", () => {
    const back = decodeSignal(encodeSignal(sdp("offer")));
    expect(back?.type).toBe("offer");
    expect(back?.sdp).toBe(sdp("offer").sdp);
  });

  it("round-trips an answer", () => {
    const back = decodeSignal(encodeSignal(sdp("answer")));
    expect(back?.type).toBe("answer");
  });

  it("uses an alphabet that survives being pasted", () => {
    // `+` and `/` are both characters other software feels entitled to
    // rewrite — a chat client that linkifies, a URL, a QR code.
    const code = encodeSignal(sdp("offer"));
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("survives the line breaks a chat client adds", () => {
    // The code is long and gets wrapped. Refusing it for that would be a
    // support burden that buys nothing.
    const code = encodeSignal(sdp("offer"));
    const wrapped = code.replace(/(.{40})/g, "$1\n  ");
    expect(decodeSignal(wrapped)?.sdp).toBe(sdp("offer").sdp);
  });

  it("preserves the SDP exactly, carriage returns included", () => {
    // SDP is line-oriented and CRLF-delimited, and a codec that normalised the
    // line endings would produce something that parses on one browser and not
    // another.
    const code = encodeSignal(sdp("offer"));
    expect(decodeSignal(code)?.sdp).toContain("\r\n");
  });

  it("returns null rather than throwing on a mistyped code", () => {
    // The expected failure, not an exceptional one: the caller shows "that
    // does not look like a code" rather than the app breaking.
    for (const bad of ["", "   ", "not-a-code", "!!!!", "YWJj"]) {
      expect(decodeSignal(bad), bad).toBeNull();
    }
  });

  it("returns null for a truncated code", () => {
    const code = encodeSignal(sdp("offer"));
    expect(decodeSignal(code.slice(0, Math.floor(code.length / 2)))).toBeNull();
  });

  it("returns null for well-formed base64 that is not a session description", () => {
    const json = JSON.stringify({ t: "something", s: "else" });
    const code = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeSignal(code)).toBeNull();
  });

  it("returns an empty string for a null description", () => {
    expect(encodeSignal(null)).toBe("");
  });
});
