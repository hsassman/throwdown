import { useCallback, useEffect, useRef, useState } from "react";
import { PeerLink, type LinkStatus } from "./peerLink";
import type { NetFightState } from "./protocol";
import type { PoseFrame } from "../pose/poseTypes";
import type { StrikeEvent } from "../perception/strikeResolver";

// Owns the connection for the duration of a session.
// EVERYTHING THE FIGHT READS IS A REF, NOT STATE
//
// The same rule useFight already follows, for the same reason. Pose frames
// arrive at about 15 Hz and strikes at whatever rate a fighter throws; routing
// either through a React setter would re-render the tree mid-combination to
// move a figure the render loop is already inside.
//
// So React is given only what a person looks at — the connection status and
// the codes — and everything the simulation and the renderer consume is a ref
// they read on their own clock.

export type SessionRole = "host" | "guest";

/** How often the outgoing pose pump looks for a new frame, milliseconds.
 *  Faster than the pose stream itself, so a frame is never held back waiting
 *  for the next tick — the pump sends only when the timestamp has changed, so
 *  the extra checks cost nothing. */
const PUMP_MS = 20;

export interface SessionOptions {
  /** Nothing is connected, and no pose leaves this machine, until this is
   *  true. A network layer that opened itself on mount would be sending the
   *  player's tracked body somewhere before they asked for a fight. */
  enabled: boolean;
  poseRef: React.RefObject<PoseFrame | null>;
  /** The local player's resolved strikes. Same subscription the fight loop
   *  uses — one measurement, two independent subscribers, so neither drains
   *  the other's punches. */
  subscribe: (cb: (s: StrikeEvent) => void) => () => void;
}

export function useSession({ enabled, poseRef, subscribe }: SessionOptions) {
  const linkRef = useRef<PeerLink | null>(null);
  const [status, setStatus] = useState<LinkStatus>({
    state: "idle",
    latency: null,
    detail: null,
  });
  const [role, setRole] = useState<SessionRole | null>(null);
  /** The code this end produces for the other player to paste. */
  const [outgoingCode, setOutgoingCode] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * The remote fighter's latest pose.
   *
   * A single frame rather than a queue: a pose is a STATE, not an event, and
   * the newest one supersedes every older one completely. Queueing them would
   * make the remote fighter play back a backlog in slow motion after any
   * hiccup, which is the opposite of what is wanted.
   */
  const remotePoseRef = useRef<PoseFrame | null>(null);
  /**
   * Punches the remote fighter has thrown, drained by whoever consumes them.
   *
   * A queue rather than a latest-value, because a strike IS an event: two
   * punches in one network burst are two punches, and keeping only the newer
   * would silently discard the first.
   */
  const remoteStrikeQueueRef = useRef<StrikeEvent[]>([]);
  /** The host's view of the fight, for a guest to render. Null on the host,
   *  which has the real simulation. */
  const remoteStateRef = useRef<NetFightState | null>(null);

  // Mirrored so the pump and the strike subscription never re-run the effect.
  const poseHolder = useRef(poseRef);
  poseHolder.current = poseRef;

  const link = useCallback(() => {
    if (!linkRef.current) {
      const l = new PeerLink();
      l.onStatus((next) => {
        setStatus(next);
        // A link that has gone away is not a link you are still in. Without
        // this the guest kept its role after the host closed the tab, so the
        // panel went on showing "send this reply code back to the host" for a
        // host that no longer existed, with no way back to the Host/Join
        // choice short of leaving the screen. The reason stays on screen; the
        // half-finished handshake does not.
        if (next.state === "closed" || next.state === "failed") {
          setRole(null);
          setOutgoingCode("");
          remotePoseRef.current = null;
          remoteStrikeQueueRef.current.length = 0;
          remoteStateRef.current = null;
        }
      });
      l.onMessage((m) => {
        if (m.kind === "pose") {
          remotePoseRef.current = m.frame;
        } else if (m.kind === "strike") {
          remoteStrikeQueueRef.current.push(m.strike);
          // Bounded, exactly like the opponent's own queue in useFight: if
          // nothing is draining — the tab is hidden, the 3D view failed to
          // load — an unbounded queue grows for the length of the fight.
          const q = remoteStrikeQueueRef.current;
          if (q.length > 32) q.splice(0, q.length - 32);
        } else if (m.kind === "state") {
          remoteStateRef.current = m.state;
        }
      });
      linkRef.current = l;
    }
    return linkRef.current;
  }, []);

  const startHost = useCallback(async () => {
    setBusy(true);
    setRole("host");
    try {
      setOutgoingCode(await link().host());
    } catch {
      // The link publishes its own failure detail; this only stops the spinner.
      setOutgoingCode("");
    } finally {
      setBusy(false);
    }
  }, [link]);

  const join = useCallback(
    async (code: string) => {
      setBusy(true);
      setRole("guest");
      try {
        setOutgoingCode(await link().accept(code));
      } catch {
        setOutgoingCode("");
      } finally {
        setBusy(false);
      }
    },
    [link]
  );

  const completeHost = useCallback(
    async (code: string) => {
      setBusy(true);
      try {
        await link().complete(code);
      } catch {
        // Same: the link has already published why.
      } finally {
        setBusy(false);
      }
    },
    [link]
  );

  const leave = useCallback(() => {
    linkRef.current?.close("left");
    linkRef.current = null;
    setRole(null);
    setOutgoingCode("");
    remotePoseRef.current = null;
    remoteStrikeQueueRef.current.length = 0;
    remoteStateRef.current = null;
  }, []);

  /** Sends something to the other fighter. False if there is no open link. */
  const send = useCallback(
    (msg: Parameters<PeerLink["send"]>[0]) => linkRef.current?.send(msg) ?? false,
    []
  );

  // --- The outgoing pose pump ---------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    let lastSent = -1;
    const id = setInterval(() => {
      const l = linkRef.current;
      if (!l || l.state !== "open") return;
      const frame = poseHolder.current.current;
      // Only genuinely new frames. The pose stream runs at about 15 Hz and the
      // renderer reads the same frame many times between samples; re-sending
      // it would quadruple the traffic to say nothing new.
      if (!frame || frame.timestamp === lastSent) return;
      lastSent = frame.timestamp;
      l.send({ kind: "pose", frame });
    }, PUMP_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // --- Outgoing strikes ----------------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    return subscribe((s) => {
      linkRef.current?.send({ kind: "strike", strike: s });
    });
  }, [enabled, subscribe]);

  // Torn down when the screen is left, so a session can never outlive the
  // screen that opened it and keep streaming the player's body.
  useEffect(() => {
    if (enabled) return;
    if (linkRef.current) leave();
  }, [enabled, leave]);
  useEffect(() => () => {
    linkRef.current?.close("left");
    linkRef.current = null;
  }, []);

  return {
    status,
    role,
    outgoingCode,
    busy,
    startHost,
    join,
    completeHost,
    leave,
    send,
    remotePoseRef,
    remoteStrikeQueueRef,
    remoteStateRef,
  };
}
