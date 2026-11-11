import { useCallback, useEffect, useRef, useState } from "react";
import { HubConnectionBuilder } from "@microsoft/signalr";
import { MatchmakingClient, type MatchmakingStatus } from "./matchmakingClient";
import { PeerLink, type LinkStatus } from "./peerLink";
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

  const attachLink = useCallback((link: PeerLink) => {
    link.onStatus((next) => {
      setLinkStatus(next);
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
    client.onStatus(setMatchStatus);

    client.onMatched(({ opponentConnectionId, isOfferer }) => {
      // host()/accept() each set link.isHost themselves — no need to set it
      // here too.
      const link = new PeerLink(NET_CONFIG.iceServers);
      linkRef.current = link;
      attachLink(link);
      setRole(isOfferer ? "host" : "guest");

      if (isOfferer) {
        link
          .host()
          .then((code) => client.relayOffer(opponentConnectionId, code))
          .catch(() => {
            setMatchStatus({ state: "failed", detail: "Could not reach the other fighter." });
          });
      }
    });

    client.onOffer(async (from, sdp) => {
      const link = linkRef.current;
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
  }, [attachLink]);

  const leave = useCallback(() => {
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
