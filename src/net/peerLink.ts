import { compactSignal, expandSignal, isCompactSignal } from "./compactSignal";
import { decode, encode, PROTOCOL_VERSION, type NetMessage } from "./protocol";

// The connection between two fighters.
// WHY PEER-TO-PEER, AND WHY SAME-NETWORK PLAY COPIES A CODE BY HAND

export type LinkState =
  | "idle"
  | "offering"
  | "answering"
  | "connecting"
  | "open"
  | "closed"
  | "failed";

/** What a peer link reports about itself, for the UI. */
export interface LinkStatus {
  state: LinkState;
  /** Round-trip time in milliseconds, or null before the first reply. */
  latency: number | null;
  /** Why it failed or closed, if it did. */
  detail: string | null;
}

/**
 * How long to wait for ICE gathering before giving up on the remaining
 * candidates and producing a code from what we have.
 */
const GATHER_TIMEOUT_MS = 2500;

/** How often each end pings, for the latency readout. */
const PING_INTERVAL_MS = 1000;

export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private candidateCb: ((candidate: string) => void) | null = null;
  /** The local description has been handed out; later candidates trickle. */
  private described = false;
  /** Trickled candidates that arrived before the other end's description. */
  private pendingRemote: RTCIceCandidateInit[] = [];
  private channel: RTCDataChannel | null = null;
  private msgCb: ((m: NetMessage) => void) | null = null;
  private stateCb: ((s: LinkStatus) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sentAt = 0;

  private status: LinkStatus = { state: "idle", latency: null, detail: null };

  /** True on the end that generated the offer. The host runs the simulation -
   *  see protocol.ts on authority. */
  isHost = false;

  /** ICE servers passed to every RTCPeerConnection this link creates. */
  private readonly iceServers: RTCIceServer[];

  /** Produce compact codes (compactSignal.ts) where the description allows
   *  it - for codes that travel as QR codes rather than as pasted text. */
  private readonly compact: boolean;

  constructor(iceServers: RTCIceServer[] = [], options: { compact?: boolean } = {}) {
    this.iceServers = iceServers;
    this.compact = options.compact ?? false;
  }

  private code(sdp: RTCSessionDescription | null): string {
    return (this.compact && compactSignal(sdp)) || encodeSignal(sdp);
  }

  get state(): LinkState {
    return this.status.state;
  }

  get latency(): number | null {
    return this.status.latency;
  }

  onMessage(cb: (m: NetMessage) => void): void {
    this.msgCb = cb;
  }

  onStatus(cb: (s: LinkStatus) => void): void {
    this.stateCb = cb;
    cb(this.status);
  }

  /** Starts a fight and returns the code to send to the other player. */
  async host(): Promise<string> {
    this.reset();
    this.isHost = true;
    this.set("offering");

    const pc = this.makeConnection();
    this.attach(
      pc.createDataChannel("fight", {
        // Ordered and reliable. Pose frames would tolerate loss, but strikes
        // and the fight state would not, and one channel that is correct beats
        // two that have to be kept in step. At 5 KB/s there is nothing to gain
        // from unreliable delivery.
        ordered: true,
      })
    );

    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered(pc);
    this.set("connecting");
    this.described = true;
    return this.code(pc.localDescription);
  }

  /**
   * Joins a fight from the host's code, and returns the reply code.
   */
  async accept(code: string): Promise<string> {
    this.reset();
    this.isHost = false;
    this.set("answering");

    const offer = decodeSignal(code);
    if (!offer || offer.type !== "offer") {
      this.fail("That does not look like a host code.");
      throw new Error("bad offer code");
    }

    const pc = this.makeConnection();
    // The host created the channel, so the guest receives it rather than
    // making its own. Two channels, one per end, is a real and confusing
    // failure: each side sends on a channel the other is not listening to.
    pc.ondatachannel = (e) => this.attach(e.channel);

    await pc.setRemoteDescription(offer);
    await this.flushCandidates(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    await this.gathered(pc);
    this.set("connecting");
    this.described = true;
    return this.code(pc.localDescription);
  }

  /** The host consumes the guest's reply code, which completes the connection. */
  async complete(code: string): Promise<void> {
    const answer = decodeSignal(code);
    if (!answer || answer.type !== "answer") {
      this.fail("That does not look like a reply code.");
      throw new Error("bad answer code");
    }
    if (!this.pc) {
      this.fail("Not hosting.");
      throw new Error("no connection");
    }
    await this.pc.setRemoteDescription(answer);
    await this.flushCandidates(this.pc);
  }

  /**
   * Candidates found after the code was made, for a signalling channel to
   * carry (the server's relay). Gathering can outlast the wait for the code on
   * a slow network, and without these such a code may hold no usable address.
   */
  onCandidate(cb: (candidate: string) => void): void {
    this.candidateCb = cb;
  }

  /** A candidate trickled from the other end. Untrusted: bad ones are dropped. */
  async addCandidate(candidate: string): Promise<void> {
    let init: RTCIceCandidateInit;
    try {
      init = JSON.parse(candidate);
    } catch {
      return;
    }
    // Held until there is a connection with the other end's description.
    if (!this.pc?.remoteDescription) {
      this.pendingRemote.push(init);
      return;
    }
    await this.pc.addIceCandidate(init).catch(() => {});
  }

  private async flushCandidates(pc: RTCPeerConnection): Promise<void> {
    for (const c of this.pendingRemote.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  }

  send(msg: NetMessage): boolean {
    const ch = this.channel;
    if (!ch || ch.readyState !== "open") return false;
    // Dropped rather than queued when the channel is backed up. A pose frame
    // is worthless by the time a backlog clears, and queueing them turns a
    // moment of congestion into a permanently late fighter.
    if (ch.bufferedAmount > 256 * 1024) return false;
    try {
      ch.send(encode(msg));
      return true;
    } catch {
      return false;
    }
  }

  close(reason = "closed"): void {
    if (this.channel?.readyState === "open") {
      this.send({ kind: "bye", reason });
    }
    this.reset();
    this.set("closed", reason);
  }

  // --- internals ---------------------------------------------------------

  private makeConnection(): RTCPeerConnection {
    // iceServers is [] for "Same Network": on a local network the direct host
    // candidates are what connect, and a STUN lookup that cannot reach the
    // internet only adds a timeout to every gather. Online mode passes a real
    // STUN server in (see the constructor).
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate && this.described) this.candidateCb?.(JSON.stringify(e.candidate.toJSON()));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.fail("The connection could not be established.");
      } else if (pc.connectionState === "disconnected") {
        this.set("closed", "The other fighter disconnected.");
      }
    };
    this.pc = pc;
    return pc;
  }

  private attach(ch: RTCDataChannel): void {
    ch.binaryType = "arraybuffer";
    this.channel = ch;
    ch.onopen = () => {
      this.set("open");
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      this.ping();
    };
    ch.onclose = () => this.set("closed", "The other fighter left.");
    ch.onerror = () => this.fail("The connection dropped.");
    ch.onmessage = (e) => {
      const data = e.data;
      if (!(data instanceof ArrayBuffer)) return;
      const msg = decode(data);
      if (!msg) return;

      if (msg.kind === "hello") {
        // A version check, not a formality. Two builds that connect happily
        // and then disagree about where a punch landed is the nastiest failure
        // available here: a refused connection is a message, a silently
        // mismatched one is a bug report about hit detection.
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.fail(
            `The other fighter is on a different version of the game (theirs ${msg.protocol}, yours ${PROTOCOL_VERSION}).`
          );
          return;
        }
        if (msg.ping) {
          // A request. Answered immediately and with nothing else attached, so
          // what the far end times is the round trip and not this end's own
          // scheduling.
          this.hello(false);
          return;
        }
        // A reply to ours.
        if (this.sentAt > 0) {
          this.status.latency = Math.round(performance.now() - this.sentAt);
          this.sentAt = 0;
          this.publish();
        }
        return;
      }
      if (msg.kind === "bye") {
        this.set("closed", "The other fighter left.");
        return;
      }
      this.msgCb?.(msg);
    };
  }

  /** Round-trip timing, measured by sending a hello and timing its reply. */
  private ping(): void {
    // One in flight at a time. A second would restart the clock and report the
    // newer one's trip while the older reply was still coming, which reads as
    // the connection improving every time it gets worse.
    if (this.sentAt > 0) return;
    this.sentAt = performance.now();
    if (!this.hello(true)) this.sentAt = 0;
  }

  private hello(ping: boolean): boolean {
    return this.send({
      kind: "hello",
      protocol: PROTOCOL_VERSION,
      name: this.isHost ? "Host" : "Guest",
      host: this.isHost,
      ping,
    });
  }

  /** Resolves once ICE gathering finishes, or the deadline passes. */
  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private reset(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.sentAt = 0;
    try {
      this.channel?.close();
      this.pc?.close();
    } catch {
      // Closing an already-closed connection is not an error worth reporting;
      // the state below is what the caller reads.
    }
    this.channel = null;
    this.pc = null;
    this.described = false;
  }

  private set(state: LinkState, detail: string | null = null): void {
    this.status = { state, latency: this.status.latency, detail };
    this.publish();
  }

  private fail(detail: string): void {
    this.reset();
    this.status = { state: "failed", latency: null, detail };
    this.publish();
  }

  private publish(): void {
    this.stateCb?.({ ...this.status });
  }
}

// --- The code players copy ------------------------------------------------
//
// Kept as free functions, and pure, because they are the only part of this
// file that can be tested without a browser.

/**
 * Turns a session description into something a person can paste into a chat
 * message.
 */
export function encodeSignal(sdp: RTCSessionDescription | null): string {
  if (!sdp) return "";
  const json = JSON.stringify({ t: sdp.type, s: sdp.sdp });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSignal(code: string): RTCSessionDescriptionInit | null {
  // Either format is accepted wherever a code is, so a reader never has to
  // know which kind the other end produced.
  if (isCompactSignal(code)) return expandSignal(code);
  // Whitespace is stripped rather than rejected. The code is long, it gets
  // pasted out of chat clients that wrap it, and refusing a code because it
  // arrived with a line break in it would be a support burden that buys
  // nothing.
  const clean = code.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!clean) return null;
  try {
    const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !obj ||
      (obj.t !== "offer" && obj.t !== "answer") ||
      typeof obj.s !== "string"
    ) {
      return null;
    }
    return { type: obj.t, sdp: obj.s };
  } catch {
    // A mistyped or truncated code is the expected failure here, not an
    // exceptional one - the caller shows "that does not look like a code".
    return null;
  }
}
