import { decode, encode, PROTOCOL_VERSION, type NetMessage } from "./protocol";

// The connection between two fighters.
// WHY PEER-TO-PEER, AND WHY THE CODE IS COPIED BY HAND
//
// Shadow Box is a static build. There is no server, and inventing one is a
// much larger decision than adding a second fighter — it means hosting,
// accounts, moderation and a bill. WebRTC connects two browsers directly, and
// the only thing it genuinely needs from the outside world is a way to hand
// one blob of text to the other end ONCE.
//
// So the players do that themselves: the host generates a code, sends it to
// their opponent however they already talk to them, and pastes the reply back.
// It is clumsy for thirty seconds and then it is a direct connection with
// nobody in the middle. The alternative is a signalling server, which is the
// same clumsiness moved into infrastructure somebody has to run.
//
// This is what the menu calls "Same Network". On a LAN the direct host
// candidates connect without a STUN server at all, which is why `iceServers`
// is empty: a STUN lookup that cannot reach the internet only adds a timeout.
// NO TRICKLE
//
// ICE candidates are normally exchanged continuously, which needs a live
// channel between the peers — exactly the thing that is missing. So the code
// is generated only once gathering has FINISHED and every candidate is already
// inside the SDP. One code each way, and no further contact needed.

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
 *
 * There is a real deadline here rather than an indefinite wait: gathering
 * finishing is not guaranteed, and a host staring at a spinner has no idea
 * whether to keep waiting. Host candidates on a LAN arrive in a few
 * milliseconds, so anything still outstanding at this point was not going to
 * help a same-network fight.
 */
const GATHER_TIMEOUT_MS = 2500;

/** How often each end pings, for the latency readout. */
const PING_INTERVAL_MS = 1000;

export class PeerLink {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private msgCb: ((m: NetMessage) => void) | null = null;
  private stateCb: ((s: LinkStatus) => void) | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sentAt = 0;

  private status: LinkStatus = { state: "idle", latency: null, detail: null };

  /** True on the end that generated the offer. The host runs the simulation —
   *  see protocol.ts on authority. */
  isHost = false;

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

  /**
   * Starts a fight and returns the code to send to the other player.
   *
   * The data channel is created HERE, before the offer, and only by the host.
   * An offer with no channel in it negotiates a connection with nothing to
   * carry, and the answering end has no way to add one afterwards without a
   * second round of signalling — which is the round there is no channel for.
   */
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
    return encodeSignal(pc.localDescription);
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
    await pc.setLocalDescription(await pc.createAnswer());
    await this.gathered(pc);
    this.set("connecting");
    return encodeSignal(pc.localDescription);
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
    // No STUN. On a local network the direct host candidates are what connect,
    // and a STUN lookup that cannot reach the internet only adds a timeout to
    // every gather. The "Online" mode in the menu is where relays belong, and
    // it is still honestly marked as not built.
    const pc = new RTCPeerConnection({ iceServers: [] });
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

  /**
   * Round-trip timing, measured by sending a hello and timing its reply.
   *
   * Reuses the handshake rather than adding a ping message: it already carries
   * the version check both ends need, it is tiny, and one fewer message type
   * is one fewer thing that can go stale. The `ping` flag is what makes it a
   * request/response pair rather than two independent announcements — see
   * NetMessage, and the 1051 ms it used to report.
   */
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
 *
 * Base64 of the JSON, with the URL-safe alphabet and no padding so it survives
 * being pasted into a chat client that linkifies, a URL, or a QR code without
 * anything mangling it. `+` and `/` are both characters that other software
 * feels entitled to rewrite.
 *
 * Not encrypted and not claiming to be — it is a connection offer, it contains
 * the local network addresses of the machine, and anyone who can read the
 * message it is sent in can read it. That is the same exposure as telling
 * someone your IP address, and it is why this is the LAN mode.
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
    // exceptional one — the caller shows "that does not look like a code".
    return null;
  }
}
