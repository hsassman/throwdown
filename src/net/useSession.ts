import { useCallback, useEffect, useState } from "react";
import { PeerLink, type LinkStatus } from "./peerLink";
import { usePeerChannel, type PeerChannelOptions } from "./usePeerChannel";

// Play a Friend: the two ends connect by pasting each other's codes.

export type SessionRole = "host" | "guest";

export function useSession(options: PeerChannelOptions) {
  const channel = usePeerChannel(options);
  const { linkRef, attach, detach, reset } = channel;
  const [status, setStatus] = useState<LinkStatus>({ state: "idle", latency: null, detail: null });
  const [role, setRole] = useState<SessionRole | null>(null);
  /** The code this end produces for the other player to paste. */
  const [outgoingCode, setOutgoingCode] = useState("");
  const [busy, setBusy] = useState(false);

  const link = useCallback(() => {
    if (linkRef.current) return linkRef.current;
    const l = new PeerLink();
    l.onStatus((next) => {
      setStatus(next);
      // A closed link is not one you are still in: back to Host/Join, reason kept.
      if (next.state === "closed" || next.state === "failed") {
        setRole(null);
        setOutgoingCode("");
        reset();
      }
    });
    attach(l);
    return l;
  }, [linkRef, attach, reset]);

  const run = useCallback(async (step: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const code = await step();
      if (typeof code === "string") setOutgoingCode(code);
    } catch {
      // The link publishes its own failure detail.
      setOutgoingCode("");
    } finally {
      setBusy(false);
    }
  }, []);

  const startHost = useCallback(() => {
    setRole("host");
    return run(() => link().host());
  }, [link, run]);

  const join = useCallback(
    (code: string) => {
      setRole("guest");
      return run(() => link().accept(code));
    },
    [link, run]
  );

  const completeHost = useCallback((code: string) => run(() => link().complete(code)), [link, run]);

  const leave = useCallback(() => {
    detach();
    setRole(null);
    setOutgoingCode("");
  }, [detach]);

  // A session never outlives the screen that opened it.
  useEffect(() => {
    if (!options.enabled && linkRef.current) leave();
  }, [options.enabled, linkRef, leave]);
  useEffect(() => () => linkRef.current?.close("left"), [linkRef]);

  return { ...channel, status, role, outgoingCode, busy, startHost, join, completeHost, leave };
}
