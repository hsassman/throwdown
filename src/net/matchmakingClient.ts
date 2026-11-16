// Drives the MatchmakingHub (server/Throwdown.Server/MatchmakingHub.cs): joins
// the queue, reports when another player is found, and relays the two SDP
// codes PeerLink produces. It does not touch WebRTC at all — see
// useOnlineSession.ts for where this and PeerLink meet.
//
// HubConnectionLike, not @microsoft/signalr's HubConnection directly, so this
// file's state machine can be unit-tested with a fake instead of a real
// socket — the same reason peerLink.ts's codec is split out from the
// RTCPeerConnection code that cannot run under Vitest.

export type MatchmakingState =
  | "idle"
  | "connecting"
  | "waiting"
  | "matched"
  | "closed"
  | "failed";

export interface MatchmakingStatus {
  state: MatchmakingState;
  detail: string | null;
}

export interface MatchFoundEvent {
  matchId: string;
  opponentConnectionId: string;
  isOfferer: boolean;
}

export interface HubConnectionLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  invoke<T = void>(methodName: string, ...args: unknown[]): Promise<T>;
  on(methodName: string, newMethod: (...args: unknown[]) => void): void;
  off(methodName: string): void;
  onclose(callback: (error?: Error) => void): void;
}

export class MatchmakingClient {
  private status: MatchmakingStatus = { state: "idle", detail: null };
  private statusCb: ((s: MatchmakingStatus) => void) | null = null;
  private matchedCb: ((m: MatchFoundEvent) => void) | null = null;
  private offerCb: ((from: string, sdp: string) => void) | null = null;
  private answerCb: ((from: string, sdp: string) => void) | null = null;
  private opponentLeftCb: (() => void) | null = null;
  private readonly connection: HubConnectionLike;

  constructor(connection: HubConnectionLike) {
    this.connection = connection;
    connection.on("Waiting", () => this.set("waiting"));
    connection.on("Matched", (...args: unknown[]) => {
      const [matchId, opponentConnectionId, isOfferer] = args as [string, string, boolean];
      this.set("matched");
      this.matchedCb?.({ matchId, opponentConnectionId, isOfferer });
    });
    connection.on("ReceiveOffer", (...args: unknown[]) => {
      const [from, sdp] = args as [string, string];
      this.offerCb?.(from, sdp);
    });
    connection.on("ReceiveAnswer", (...args: unknown[]) => {
      const [from, sdp] = args as [string, string];
      this.answerCb?.(from, sdp);
    });
    // The hub sends this when the player we were paired with disconnects or
    // queues again. Before the peer link opens it is the only way to find out:
    // otherwise this side waits on "connecting" for a fighter who is gone.
    connection.on("OpponentLeft", () => this.opponentLeftCb?.());
    connection.onclose(() => {
      // Only report failure if this wasn't a deliberate leave() — leave()
      // already set state to "closed" itself; onclose can fire for that too
      // (stop() closing the connection), and re-marking it "failed" would
      // be wrong in that case.
      if (this.status.state !== "closed") {
        this.set("failed", "Lost connection to the matchmaking server.");
      }
    });
  }

  get state(): MatchmakingState {
    return this.status.state;
  }

  onStatus(cb: (s: MatchmakingStatus) => void): void {
    this.statusCb = cb;
    cb(this.status);
  }

  onMatched(cb: (m: MatchFoundEvent) => void): void {
    this.matchedCb = cb;
  }

  onOffer(cb: (from: string, sdp: string) => void): void {
    this.offerCb = cb;
  }

  onAnswer(cb: (from: string, sdp: string) => void): void {
    this.answerCb = cb;
  }

  onOpponentLeft(cb: () => void): void {
    this.opponentLeftCb = cb;
  }

  async findMatch(): Promise<void> {
    this.set("connecting");
    try {
      await this.connection.start();
      await this.connection.invoke("JoinQueue");
    } catch (err) {
      this.set("failed", err instanceof Error ? err.message : "Could not connect.");
      throw err;
    }
  }

  async relayOffer(targetConnectionId: string, sdp: string): Promise<void> {
    await this.connection.invoke("RelayOffer", targetConnectionId, sdp);
  }

  async relayAnswer(targetConnectionId: string, sdp: string): Promise<void> {
    await this.connection.invoke("RelayAnswer", targetConnectionId, sdp);
  }

  async leave(): Promise<void> {
    await this.connection.stop();
    this.set("closed");
  }

  private set(state: MatchmakingState, detail: string | null = null): void {
    this.status = { state, detail };
    this.statusCb?.(this.status);
  }
}
