import { describe, it, expect } from "vitest";
import { compactSignal, expandSignal, isCompactSignal } from "./compactSignal";

const FP =
  "8B:4E:2A:91:0C:7F:33:D5:16:AE:58:F0:C2:94:7B:21:E6:03:5D:B8:49:1A:FC:62:87:3E:D0:A5:14:69:CB:F7";

/** Shaped like a real Chrome data-channel offer after gathering. */
const OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 54400 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 192.168.1.23",
  "a=candidate:2999745851 1 udp 2122260223 192.168.1.23 54400 typ host generation 0 network-id 1",
  "a=candidate:1061316541 1 udp 2122194687 fd00::1c2b:3aff:fe11:2233 54401 typ host generation 0",
  "a=candidate:4233069003 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0",
  "a=candidate:842163049 1 udp 1686052607 41.13.8.200 54400 typ srflx raddr 192.168.1.23 rport 54400",
  "a=ice-ufrag:Xk9+",
  "a=ice-pwd:aB3/dE6fGh9jK2mN5pQ8rS1t",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FP}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "",
].join("\r\n");

describe("compact connection codes", () => {
  it("is small enough for a webcam-readable QR code", () => {
    const code = compactSignal({ type: "offer", sdp: OFFER })!;
    expect(code).not.toBeNull();
    expect(isCompactSignal(code)).toBe(true);
    // The full base64 description is ~1.3 KB for this input.
    expect(code.length).toBeLessThan(200);
    // Rides in a URL fragment unescaped: no space, +, / or %.
    expect(code).toMatch(/^[A-Za-z0-9~._,:-]+$/);
  });

  it("round-trips everything the connection depends on", () => {
    const back = expandSignal(compactSignal({ type: "offer", sdp: OFFER })!)!;
    expect(back.type).toBe("offer");
    const sdp = back.sdp!;
    expect(sdp).toContain("a=ice-ufrag:Xk9+\r\n");
    expect(sdp).toContain("a=ice-pwd:aB3/dE6fGh9jK2mN5pQ8rS1t\r\n");
    expect(sdp).toContain(`a=fingerprint:sha-256 ${FP}\r\n`);
    expect(sdp).toContain("a=setup:actpass\r\n");
    expect(sdp).toContain("a=mid:0\r\n");
    expect(sdp).toMatch(/ 192\.168\.1\.23 54400 typ host/);
    expect(sdp).toMatch(/ fd00::1c2b:3aff:fe11:2233 54401 typ host/);
    expect(sdp).toMatch(/ 41\.13\.8\.200 54400 typ srflx/);
    // TCP candidates are dropped: a LAN data channel never needs them.
    expect(sdp).not.toMatch(/tcp/);
  });

  it("keeps an answer's role", () => {
    const answer = OFFER.replace("a=setup:actpass", "a=setup:active");
    const back = expandSignal(compactSignal({ type: "answer", sdp: answer })!)!;
    expect(back.type).toBe("answer");
    expect(back.sdp).toContain("a=setup:active\r\n");
  });

  it("carries mDNS candidates", () => {
    const mdns = OFFER.replace(
      /192\.168\.1\.23 54400 typ host/,
      "3f1c8a2e-7b4d-4e19-9a0c-5d2b6e8f1a33.local 54400 typ host"
    );
    const back = expandSignal(compactSignal({ type: "offer", sdp: mdns })!)!;
    expect(back.sdp).toContain("3f1c8a2e-7b4d-4e19-9a0c-5d2b6e8f1a33.local 54400 typ host");
  });

  it("declines what it cannot rebuild, so the caller falls back", () => {
    expect(compactSignal({ type: "offer", sdp: OFFER.replace("sha-256", "sha-1") })).toBeNull();
    expect(compactSignal({ type: "offer", sdp: OFFER + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" })).toBeNull();
    expect(compactSignal({ type: "offer", sdp: OFFER.replace(/a=candidate:.*\r\n/g, "") })).toBeNull();
    expect(compactSignal(null)).toBeNull();
  });

  it("refuses malformed or hostile input", () => {
    const good = compactSignal({ type: "offer", sdp: OFFER })!;
    expect(expandSignal("")).toBeNull();
    expect(expandSignal("c1~o~p")).toBeNull();
    // An address that would inject another line into the description.
    expect(expandSignal(good.replace("h192.168.1.23_54400", "h1.2.3.4\r\na=evil_1"))).toBeNull();
    expect(expandSignal(good.replace(/~p~/, "~x~"))).toBeNull();
  });
});
