// A connection code small enough for a webcam to read off a phone screen.

const VERSION = "c1";
const SEP = "~";

const SETUP = { actpass: "p", active: "a", passive: "s" } as const;
const SETUP_BACK: Record<string, string> = { p: "actpass", a: "active", s: "passive" };

const TYPE = { host: "h", srflx: "s", prflx: "p", relay: "r" } as const;
const TYPE_BACK: Record<string, keyof typeof TYPE> = { h: "host", s: "srflx", p: "prflx", r: "relay" };

/** Standard RFC 8445 type preferences, so the rebuilt candidates are paired
 *  in the order the original browser would have paired them. */
const PRIORITY: Record<keyof typeof TYPE, number> = {
  host: 2122260223,
  prflx: 1845501695,
  srflx: 1686052607,
  relay: 41885439,
};

/** ICE credentials are `ice-char`s: letters, digits, `+` and `/`. The last two
 *  are mapped to URL-safe ones so the code can ride in a link unescaped. */
const iceOut = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");
const iceIn = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");

const ICE_CHARS = /^[A-Za-z0-9+/]{4,256}$/;
const MID = /^[A-Za-z0-9]{1,16}$/;

function hexToB64url(hex: string): string | null {
  const parts = hex.split(":");
  if (parts.length !== 32 || parts.some((p) => !/^[0-9A-Fa-f]{2}$/.test(p))) return null;
  let bin = "";
  for (const p of parts) bin += String.fromCharCode(parseInt(p, 16));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToHex(s: string): string | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=");
    if (bin.length !== 32) return null;
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join(":");
  } catch {
    return null;
  }
}

/** An address the rebuilt candidate line can carry: IPv4, IPv6, or an mDNS
 *  name. Nothing else, because this arrives from another device. */
const ADDRESS = /^([0-9.]+|[0-9A-Fa-f:]+|[A-Za-z0-9-]+\.local)$/;

export function compactSignal(sdp: RTCSessionDescriptionInit | null): string | null {
  if (!sdp?.sdp || (sdp.type !== "offer" && sdp.type !== "answer")) return null;
  const lines = sdp.sdp.split(/\r?\n/);
  const value = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();

  if (!lines.some((l) => l.startsWith("m=application"))) return null;
  // One media section only. A description with audio or video in it is not
  // something this format can rebuild.
  if (lines.filter((l) => l.startsWith("m=")).length !== 1) return null;

  const ufrag = value("a=ice-ufrag:");
  const pwd = value("a=ice-pwd:");
  const mid = value("a=mid:") ?? "0";
  const setup = value("a=setup:") as keyof typeof SETUP | undefined;
  const fpLine = value("a=fingerprint:");
  if (!ufrag || !pwd || !setup || !fpLine || !(setup in SETUP)) return null;
  if (!ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd) || !MID.test(mid)) return null;
  const [algo, hex] = fpLine.split(/\s+/);
  if (algo?.toLowerCase() !== "sha-256" || !hex) return null;
  const fp = hexToB64url(hex);
  if (!fp) return null;

  const candidates: string[] = [];
  for (const l of lines) {
    if (!l.startsWith("a=candidate:")) continue;
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
    const f = l.slice("a=candidate:".length).split(/\s+/);
    if (f.length < 8 || f[1] !== "1" || f[2].toLowerCase() !== "udp" || f[6] !== "typ") continue;
    const t = TYPE[f[7] as keyof typeof TYPE];
    if (!t || !ADDRESS.test(f[4]) || !/^\d{1,5}$/.test(f[5])) continue;
    candidates.push(`${t}${f[4]}_${f[5]}`);
  }
  if (candidates.length === 0) return null;

  return [
    VERSION,
    sdp.type === "offer" ? "o" : "a",
    SETUP[setup],
    mid,
    iceOut(ufrag),
    iceOut(pwd),
    fp,
    candidates.join(","),
  ].join(SEP);
}

export function isCompactSignal(code: string): boolean {
  return code.trim().startsWith(VERSION + SEP);
}

export function expandSignal(code: string): RTCSessionDescriptionInit | null {
  const f = code.trim().split(SEP);
  if (f.length !== 8 || f[0] !== VERSION) return null;
  const [, t, s, mid, ufragOut, pwdOut, fp, cands] = f;
  const type = t === "o" ? "offer" : t === "a" ? "answer" : null;
  const setup = SETUP_BACK[s];
  const ufrag = iceIn(ufragOut);
  const pwd = iceIn(pwdOut);
  const hex = b64urlToHex(fp);
  if (!type || !setup || !hex || !MID.test(mid) || !ICE_CHARS.test(ufrag) || !ICE_CHARS.test(pwd)) {
    return null;
  }

  const candLines: string[] = [];
  for (const [i, c] of cands.split(",").entries()) {
    const kind = TYPE_BACK[c[0]];
    const sep = c.lastIndexOf("_");
    const address = c.slice(1, sep);
    const port = c.slice(sep + 1);
    if (!kind || sep < 2 || !ADDRESS.test(address) || !/^\d{1,5}$/.test(port)) return null;
    candLines.push(`a=candidate:${i + 1} 1 udp ${PRIORITY[kind] - i} ${address} ${port} typ ${kind}`);
  }
  if (candLines.length === 0) return null;

  const sdp = [
    "v=0",
    // The session id only has to be unique per description; nothing checks it
    // against the original.
    `o=- ${Math.floor(Math.random() * 1e15)} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    ...candLines,
    "a=end-of-candidates",
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${hex}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    "a=sctp-port:5000",
    "a=max-message-size:262144",
    "",
  ].join("\r\n");
  return { type, sdp };
}
