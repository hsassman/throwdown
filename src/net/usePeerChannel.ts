import { useCallback, useEffect, useRef, useState } from "react";
import type { PeerLink } from "./peerLink";
import type { NetDefence, NetFightState, NetMessage } from "./protocol";
import type { PoseFrame } from "../pose/poseTypes";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { FightEvent } from "../sim/fightState";

// The part of a session that does not care how the two ends found each other:
// what goes over an open link and what comes back. Everything the fight and
// the renderer read is a ref, read on their own clock.

/** How often the pose pump looks for a new frame, ms. It sends only new frames. */
const PUMP_MS = 20;
/** Cap on any queue nothing is draining (hidden tab, no 3D view). */
export const QUEUE_CAP = 32;

export interface RemoteEvent {
  event: FightEvent;
  strike?: StrikeEvent;
}

export interface RematchState {
  local: boolean;
  remote: boolean;
}

export interface PeerChannelOptions {
  /** Nothing is sent until this is true. */
  enabled: boolean;
  poseRef: React.RefObject<PoseFrame | null>;
  /** The local player's resolved strikes. */
  subscribe: (cb: (s: StrikeEvent) => void) => () => void;
}

export function pushBounded<T>(q: T[], item: T, cap = QUEUE_CAP) {
  q.push(item);
  if (q.length > cap) q.splice(0, q.length - cap);
}

export function usePeerChannel({ enabled, poseRef, subscribe }: PeerChannelOptions) {
  const linkRef = useRef<PeerLink | null>(null);
  /** Latest only: a pose is a state, and a backlog would replay in slow motion. */
  const remotePoseRef = useRef<PoseFrame | null>(null);
  const remoteStrikeQueueRef = useRef<StrikeEvent[]>([]);
  /** Guest only: the host's latest view of the fight. */
  const remoteStateRef = useRef<NetFightState | null>(null);
  /** Host only: the guest's latest guard and head movement. */
  const remoteDefenceRef = useRef<NetDefence | null>(null);
  /** Guest only: fight events from the host, in order. */
  const remoteEventQueueRef = useRef<RemoteEvent[]>([]);
  const [rematch, setRematch] = useState<RematchState>({ local: false, remote: false });
  /** Bumped each time both players have asked for another fight. */
  const [rematchKey, setRematchKey] = useState(0);

  useEffect(() => {
    if (!rematch.local || !rematch.remote) return;
    setRematchKey((k) => k + 1);
    setRematch({ local: false, remote: false });
  }, [rematch]);

  const reset = useCallback(() => {
    remotePoseRef.current = null;
    remoteStrikeQueueRef.current.length = 0;
    remoteStateRef.current = null;
    remoteDefenceRef.current = null;
    remoteEventQueueRef.current.length = 0;
    setRematch({ local: false, remote: false });
  }, []);

  const onMessage = useCallback(
    (m: NetMessage) => {
      switch (m.kind) {
        case "pose":
          remotePoseRef.current = m.frame;
          break;
        case "strike":
          pushBounded(remoteStrikeQueueRef.current, m.strike);
          break;
        case "state":
          remoteStateRef.current = m.state;
          break;
        case "defence":
          remoteDefenceRef.current = m.defence;
          break;
        case "event":
          pushBounded(remoteEventQueueRef.current, { event: m.event, strike: m.strike });
          break;
        case "rematch":
          setRematch((r) => ({ ...r, remote: true }));
          break;
      }
    },
    []
  );

  /** Takes over an open or opening link's messages. */
  const attach = useCallback(
    (link: PeerLink) => {
      linkRef.current = link;
      link.onMessage(onMessage);
    },
    [onMessage]
  );

  const detach = useCallback(() => {
    linkRef.current?.close("left");
    linkRef.current = null;
    reset();
  }, [reset]);

  /** False when there is no open link. */
  const send = useCallback((msg: NetMessage) => linkRef.current?.send(msg) ?? false, []);

  const requestRematch = useCallback(() => {
    if (!send({ kind: "rematch" })) return;
    setRematch((r) => ({ ...r, local: true }));
  }, [send]);

  useEffect(() => {
    if (!enabled) return;
    let lastSent = -1;
    const id = setInterval(() => {
      const l = linkRef.current;
      if (!l || l.state !== "open") return;
      const frame = poseRef.current;
      if (!frame || frame.timestamp === lastSent) return;
      lastSent = frame.timestamp;
      l.send({ kind: "pose", frame });
    }, PUMP_MS);
    return () => clearInterval(id);
  }, [enabled, poseRef]);

  useEffect(() => {
    if (!enabled) return;
    return subscribe((s) => {
      linkRef.current?.send({ kind: "strike", strike: s });
    });
  }, [enabled, subscribe]);

  return {
    linkRef,
    attach,
    detach,
    reset,
    send,
    rematch,
    rematchKey,
    requestRematch,
    remotePoseRef,
    remoteStrikeQueueRef,
    remoteStateRef,
    remoteDefenceRef,
    remoteEventQueueRef,
  };
}

export type PeerChannel = ReturnType<typeof usePeerChannel>;
