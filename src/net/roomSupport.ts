import { useEffect, useState } from "react";
import { NET_CONFIG } from "../config/tuning";

// Whether the server pairs friends by room code. Its /health says so; an older
// server does not, and Play a Friend then falls back to pasted codes. Asking
// also wakes a sleeping free-tier server. Asked once per page load.

let asked: Promise<boolean> | null = null;

export function serverHasRooms(url = NET_CONFIG.matchmakingUrl): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  asked ??= fetch(new URL("/health", url))
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { rooms?: unknown } | null) => body?.rooms === true)
    .catch(() => {
      // Unreachable now is not unreachable for good: ask again next time.
      asked = null;
      return false;
    });
  return asked;
}

/** Null until the server has answered. */
export function useRoomSupport(enabled: boolean): boolean | null {
  const [rooms, setRooms] = useState<boolean | null>(() => (NET_CONFIG.matchmakingUrl ? null : false));
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void serverHasRooms().then((has) => live && setRooms(has));
    return () => {
      live = false;
    };
  }, [enabled]);
  return rooms;
}
