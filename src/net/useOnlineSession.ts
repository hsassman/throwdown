import { useCallback, useEffect, useRef, useState } from "react";
import { MatchmakingClient, type MatchmakingStatus } from "./matchmakingClient";
import { PeerLink, type LinkStatus } from "./peerLink";
import { fetchIceServers } from "./iceServers";
import { NET_CONFIG } from "../config/tuning";
import { NO_SERVER_MESSAGE } from "./leaderboard";
import { usePeerChannel, type PeerChannelOptions } from "./usePeerChannel";

// Online: the matchmaking hub pairs two queued players and relays the same
// offer and answer the Play a Friend codes carry.

const UNREACHABLE = "Could not reach the other fighter.";
const NO_LINK: LinkStatus = { state: "idle", latency: null, detail: null };

export function useOnlineSession(options: PeerChannelOptions) {
  const channel = usePeerChannel(options);
  const { linkRef, attach, detach, reset } = channel;
  const clientRef = useRef<MatchmakingClient | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [matchStatus, setMatchStatus] = useState<MatchmakingStatus>({ state: "idle", detail: null });
  const [linkStatus, setLinkStatus] = useState<LinkStatus>(NO_LINK);
  const [role, setRole] = useState<"host" | "guest" | null>(null);
  const [busy, setBusy] = useState(false);

  const clearConnectTimer = () => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = null;
  };

  /** Ends the current pairing, if any, and closes its hub connection. */
  const dropMatch = useCallback(async () => {
    clearConnectTimer();
    detach();
    const client = clientRef.current;
    clientRef.current = null;
    setRole(null);
    await client?.leave().catch(() => {});
  }, [detach]);

  /** Ends a pairing that never became a fight, and says why. */
  const abandonMatch = useCallback(
    async (reason: string) => {
      await dropMatch();
      setMatchStatus({ state: "failed", detail: reason });
    },
    [dropMatch]
  );

  const findMatchRef = useRef<() => Promise<void>>(async () => {});

  const findMatch = useCallback(async () => {
    const serverUrl = NET_CONFIG.matchmakingUrl;
    if (!serverUrl) {
      setMatchStatus({ state: "failed", detail: NO_SERVER_MESSAGE });
      return;
    }
    setBusy(true);
    // A new search ends whatever came before, so an old hub connection is not
    // left queued or paired on the server.
    await dropMatch();
    setLinkStatus(NO_LINK);
    // No automatic reconnect: a new connection id has no slot in the queue.
    // withCredentials false: different origins, no cookies, and the server
    // does not send Access-Control-Allow-Credentials.
    const { HubConnectionBuilder } = await import("@microsoft/signalr");
    const connection = new HubConnectionBuilder().withUrl(serverUrl, { withCredentials: false }).build();
    const client = new MatchmakingClient(connection);
    clientRef.current = client;
    const iceServersPromise = fetchIceServers(serverUrl, NET_CONFIG.iceServers);
    client.onStatus(setMatchStatus);

    // Resolves once onMatched has built the link; an offer can arrive first.
    let linkReady: Promise<PeerLink | null> = Promise.resolve(null);
    /** The pairing became a fight; from then on the link's own close reports a departure. */
    let fought = false;

    client.onOpponentLeft(() => {
      if (clientRef.current !== client || fought) return;
      // Paired with someone already gone (the server hears of a closed tab a
      // little late): back into the queue rather than back to the menu.
      void findMatchRef.current();
    });

    client.onMatched(({ opponentConnectionId, isOfferer }) => {
      clearConnectTimer();
      connectTimerRef.current = setTimeout(() => {
        if (clientRef.current !== client || linkRef.current?.state === "open") return;
        void abandonMatch("Couldn't connect to your opponent. Their network may block it. Find another match.");
      }, NET_CONFIG.connectTimeoutMs);

      linkReady = (async () => {
        const iceServers = await iceServersPromise;
        if (clientRef.current !== client) return null;
        const link = new PeerLink(iceServers);
        link.onStatus((next) => {
          // A dropped link still reports its channel closing; only the current one counts.
          if (linkRef.current !== link) return;
          setLinkStatus(next);
          if (next.state === "open") {
            fought = true;
            clearConnectTimer();
          }
          if (next.state === "closed" || next.state === "failed") {
            setRole(null);
            reset();
          }
        });
        attach(link);
        setRole(isOfferer ? "host" : "guest");
        return link;
      })();

      if (isOfferer) {
        linkReady
          .then((link) => link?.host())
          .then((code) => (code ? client.relayOffer(opponentConnectionId, code) : undefined))
          .catch(() => setMatchStatus({ state: "failed", detail: UNREACHABLE }));
      }
    });

    client.onOffer(async (from, sdp) => {
      const link = await linkReady;
      if (!link) return;
      try {
        await client.relayAnswer(from, await link.accept(sdp));
      } catch {
        setMatchStatus({ state: "failed", detail: UNREACHABLE });
      }
    });

    client.onAnswer(async (_from, sdp) => {
      try {
        await linkRef.current?.complete(sdp);
      } catch {
        setMatchStatus({ state: "failed", detail: UNREACHABLE });
      }
    });

    try {
      await client.findMatch();
    } catch {
      // MatchmakingClient has already reported the failure.
    } finally {
      setBusy(false);
    }
  }, [linkRef, attach, reset, abandonMatch, dropMatch]);
  findMatchRef.current = findMatch;

  const leave = useCallback(() => {
    clearConnectTimer();
    detach();
    clientRef.current?.leave();
    clientRef.current = null;
    setRole(null);
    setMatchStatus({ state: "idle", detail: null });
  }, [detach]);

  // A session never outlives the screen that opened it.
  useEffect(() => {
    if (!options.enabled && (linkRef.current || clientRef.current)) leave();
  }, [options.enabled, linkRef, leave]);
  useEffect(
    () => () => {
      clearConnectTimer();
      linkRef.current?.close("left");
      clientRef.current?.leave();
    },
    [linkRef]
  );

  return { ...channel, matchStatus, linkStatus, role, busy, findMatch, leave };
}
