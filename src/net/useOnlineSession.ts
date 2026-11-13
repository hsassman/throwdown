import { useCallback, useEffect, useRef, useState } from "react";
import { HubConnectionBuilder } from "@microsoft/signalr";
import { MatchmakingClient, type MatchmakingStatus } from "./matchmakingClient";
import { PeerLink, type LinkStatus } from "./peerLink";
import { fetchIceServers } from "./iceServers";
import { NET_CONFIG } from "../config/tuning";
import type { NetFightState, NetMessage } from "./protocol";
import type { PoseFrame } from "../pose/poseTypes";
import type { StrikeEvent } from "../perception/strikeResolver";

// The online counterpart to useSession.ts. Same reasons for refs-not-state
// apply unchanged — see useSession.ts's header comment. The difference is
// entirely in how the two ends find each other: useSession's PeerLink calls
// are triggered by a person pasting a code; here MatchmakingClient triggers
// the exact same PeerLink calls automatically once the hub pairs two queued
// players.

const PUMP_MS = 20;

export interface OnlineSessionOptions {
  enabled: boolean;
  poseRef: React.RefObject<PoseFrame | null>;
  subscribe: (cb: (s: StrikeEvent) => void) => () => void;
}

export function useOnlineSession({ enabled, poseRef, subscribe }: OnlineSessionOptions) {
  const clientRef = useRef<MatchmakingClient | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [matchStatus, setMatchStatus] = useState<MatchmakingStatus>({
    state: "idle",
    detail: null,
  });
  const [linkStatus, setLinkStatus] = useState<LinkStatus>({
    state: "idle",
    latency: null,
    detail: null,
  });
  const [role, setRole] = useState<"host" | "guest" | null>(null);
  const [busy, setBusy] = useState(false);

  const remotePoseRef = useRef<PoseFrame | null>(null);
  const remoteStrikeQueueRef = useRef<StrikeEvent[]>([]);
  const remoteStateRef = useRef<NetFightState | null>(null);

  const poseHolder = useRef(poseRef);
  poseHolder.current = poseRef;

  const clearConnectTimer = () => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
  };

  /**
   * Ends a pairing that never became a fight, and says why. The player is
   * back at "Find a match" with a reason, rather than stuck on "connecting".
   */
  const abandonMatch = useCallback(async (reason: string) => {
    clearConnectTimer();
    linkRef.current?.close("left");
    linkRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    setRole(null);
    await client?.leave().catch(() => {});
    setMatchStatus({ state: "failed", detail: reason });
  }, []);

  const attachLink = useCallback((link: PeerLink) => {
    link.onStatus((next) => {
      setLinkStatus(next);
      if (next.state === "open") clearConnectTimer();
      // A link that failed or closed is not still "matched" — without this
      // FindMatchPanel hung on "Opponent found, connecting..." forever on
      // the expected STUN-only failure case. Same reason useSession.ts
      // resets on this transition.
      if (next.state === "closed" || next.state === "failed") {
        setRole(null);
        remotePoseRef.current = null;
        remoteStrikeQueueRef.current.length = 0;
        remoteStateRef.current = null;
      }
    });
    link.onMessage((m) => {
      if (m.kind === "pose") {
        remotePoseRef.current = m.frame;
      } else if (m.kind === "strike") {
        remoteStrikeQueueRef.current.push(m.strike);
        const q = remoteStrikeQueueRef.current;
        if (q.length > 32) q.splice(0, q.length - 32);
      } else if (m.kind === "state") {
        remoteStateRef.current = m.state;
      }
    });
  }, []);

  const findMatch = useCallback(async () => {
    setBusy(true);
    // No automatic reconnect: a reconnect gets a new ConnectionId, which the
    // server's matchmaking queue has no way to re-associate with this
    // player's old slot. A dropped connection reports failure instead (see
    // MatchmakingClient's onclose handling) rather than silently resuming
    // under an id nobody can reach.
    const connection = new HubConnectionBuilder().withUrl(NET_CONFIG.matchmakingUrl).build();
    const client = new MatchmakingClient(connection);
    clientRef.current = client;
    // Fetched while queueing, so it is ready by the time a match arrives.
    // Falls back to the built-in STUN list on any failure.
    const iceServersPromise = fetchIceServers(NET_CONFIG.matchmakingUrl, NET_CONFIG.iceServers);
    client.onStatus(setMatchStatus);

    // Resolves to the link once onMatched has built it. onOffer awaits this,
    // because the ICE fetch makes link creation async and an offer can arrive
    // before it finishes.
    let linkReady: Promise<PeerLink | null> = Promise.resolve(null);

    client.onOpponentLeft(() => {
      // Once the peer link is open, its own close is what reports a departure
      // (see attachLink). Before that, this is the only signal there is.
      if (linkRef.current?.state === "open") return;
      void abandonMatch("Your opponent left before the fight started. Find another match.");
    });

    client.onMatched(({ opponentConnectionId, isOfferer }) => {
      clearConnectTimer();
      connectTimerRef.current = setTimeout(() => {
        if (clientRef.current !== client) return;
        if (linkRef.current?.state === "open") return;
        void abandonMatch(
          "Couldn't connect to your opponent. Their network may block it. Find another match."
        );
      }, NET_CONFIG.connectTimeoutMs);

      linkReady = (async () => {
        const iceServers = await iceServersPromise;
        if (clientRef.current !== client) return null; // left while waiting
        // host()/accept() each set link.isHost themselves — no need to set it
        // here too.
        const link = new PeerLink(iceServers);
        linkRef.current = link;
        attachLink(link);
        setRole(isOfferer ? "host" : "guest");
        return link;
      })();

      if (isOfferer) {
        linkReady
          .then((link) => link?.host())
          .then((code) => (code ? client.relayOffer(opponentConnectionId, code) : undefined))
          .catch(() => {
            setMatchStatus({ state: "failed", detail: "Could not reach the other fighter." });
          });
      }
    });

    client.onOffer(async (from, sdp) => {
      const link = await linkReady;
      if (!link) return;
      try {
        const reply = await link.accept(sdp);
        await client.relayAnswer(from, reply);
      } catch {
        setMatchStatus({ state: "failed", detail: "Could not reach the other fighter." });
      }
    });

    client.onAnswer(async (_from, sdp) => {
      try {
        await linkRef.current?.complete(sdp);
      } catch {
        setMatchStatus({ state: "failed", detail: "Could not reach the other fighter." });
      }
    });

    try {
      await client.findMatch();
    } catch {
      // MatchmakingClient already set matchStatus to "failed" with its own
      // detail — this just stops the rejection from being unhandled.
    } finally {
      setBusy(false);
    }
  }, [attachLink, abandonMatch]);

  const leave = useCallback(() => {
    clearConnectTimer();
    linkRef.current?.close("left");
    linkRef.current = null;
    clientRef.current?.leave();
    clientRef.current = null;
    setRole(null);
    setMatchStatus({ state: "idle", detail: null });
    remotePoseRef.current = null;
    remoteStrikeQueueRef.current.length = 0;
    remoteStateRef.current = null;
  }, []);

  const send = useCallback(
    (msg: NetMessage) => linkRef.current?.send(msg) ?? false,
    []
  );

  useEffect(() => {
    if (!enabled) return;
    let lastSent = -1;
    const id = setInterval(() => {
      const l = linkRef.current;
      if (!l || l.state !== "open") return;
      const frame = poseHolder.current.current;
      if (!frame || frame.timestamp === lastSent) return;
      lastSent = frame.timestamp;
      l.send({ kind: "pose", frame });
    }, PUMP_MS);
    return () => clearInterval(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return subscribe((s) => {
      linkRef.current?.send({ kind: "strike", strike: s });
    });
  }, [enabled, subscribe]);

  useEffect(() => {
    if (enabled) return;
    if (linkRef.current || clientRef.current) leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => () => {
    clearConnectTimer();
    linkRef.current?.close("left");
    clientRef.current?.leave();
  }, []);

  return {
    matchStatus,
    linkStatus,
    role,
    busy,
    findMatch,
    leave,
    send,
    remotePoseRef,
    remoteStrikeQueueRef,
    remoteStateRef,
  };
}
