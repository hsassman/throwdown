import { describe, it, expect, vi } from "vitest";
import { MatchmakingClient, type HubConnectionLike } from "./matchmakingClient";

// A fake good enough to drive the state machine: it records what was invoked
// and lets a test fire the handler MatchmakingClient registered for a given
// hub method, the same way the real hub would call it over the wire.
class FakeConnection implements HubConnectionLike {
  startShouldFail = false;
  startCalled = false;
  stopCalled = false;
  invoked: { method: string; args: unknown[] }[] = [];
  private handlers = new Map<string, (...args: unknown[]) => void>();

  async start(): Promise<void> {
    if (this.startShouldFail) throw new Error("connection refused");
    this.startCalled = true;
  }

  async stop(): Promise<void> {
    this.stopCalled = true;
  }

  async invoke<T = void>(methodName: string, ...args: unknown[]): Promise<T> {
    this.invoked.push({ method: methodName, args });
    return undefined as T;
  }

  on(methodName: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(methodName, callback);
  }

  off(methodName: string): void {
    this.handlers.delete(methodName);
  }

  trigger(methodName: string, ...args: unknown[]): void {
    this.handlers.get(methodName)?.(...args);
  }
}

describe("MatchmakingClient", () => {
  it("starts idle", () => {
    const client = new MatchmakingClient(new FakeConnection());
    expect(client.state).toBe("idle");
  });

  it("findMatch starts the connection and joins the queue", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);

    await client.findMatch();

    expect(conn.startCalled).toBe(true);
    expect(conn.invoked).toEqual([{ method: "JoinQueue", args: [] }]);
  });

  it("reports failure when the connection cannot be started", async () => {
    const conn = new FakeConnection();
    conn.startShouldFail = true;
    const client = new MatchmakingClient(conn);
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s.state));

    await expect(client.findMatch()).rejects.toThrow();

    expect(client.state).toBe("failed");
    expect(statuses).toContain("failed");
  });

  it("moves to waiting when the hub reports Waiting", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    await client.findMatch();

    conn.trigger("Waiting");

    expect(client.state).toBe("waiting");
  });

  it("reports the match when the hub reports Matched", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    const matches: unknown[] = [];
    client.onMatched((m) => matches.push(m));
    await client.findMatch();

    conn.trigger("Matched", "match-1", "conn-99", true);

    expect(client.state).toBe("matched");
    expect(matches).toEqual([
      { matchId: "match-1", opponentConnectionId: "conn-99", isOfferer: true },
    ]);
  });

  it("fires onOffer when the hub reports ReceiveOffer", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    const offers: unknown[] = [];
    client.onOffer((from, sdp) => offers.push([from, sdp]));
    await client.findMatch();

    conn.trigger("ReceiveOffer", "conn-1", "sdp-blob");

    expect(offers).toEqual([["conn-1", "sdp-blob"]]);
  });

  it("fires onAnswer when the hub reports ReceiveAnswer", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    const answers: unknown[] = [];
    client.onAnswer((from, sdp) => answers.push([from, sdp]));
    await client.findMatch();

    conn.trigger("ReceiveAnswer", "conn-1", "sdp-blob");

    expect(answers).toEqual([["conn-1", "sdp-blob"]]);
  });

  it("relayOffer invokes RelayOffer with the target and the code", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    await client.findMatch();
    conn.invoked.length = 0;

    await client.relayOffer("conn-2", "my-offer-code");

    expect(conn.invoked).toEqual([
      { method: "RelayOffer", args: ["conn-2", "my-offer-code"] },
    ]);
  });

  it("relayAnswer invokes RelayAnswer with the target and the code", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    await client.findMatch();
    conn.invoked.length = 0;

    await client.relayAnswer("conn-2", "my-answer-code");

    expect(conn.invoked).toEqual([
      { method: "RelayAnswer", args: ["conn-2", "my-answer-code"] },
    ]);
  });

  it("leave stops the connection and reports closed", async () => {
    const conn = new FakeConnection();
    const client = new MatchmakingClient(conn);
    await client.findMatch();

    await client.leave();

    expect(conn.stopCalled).toBe(true);
    expect(client.state).toBe("closed");
  });

  it("onStatus replays the current status immediately, like PeerLink.onStatus", () => {
    const client = new MatchmakingClient(new FakeConnection());
    const cb = vi.fn();

    client.onStatus(cb);

    expect(cb).toHaveBeenCalledWith({ state: "idle", detail: null });
  });
});
