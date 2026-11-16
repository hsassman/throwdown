import { useEffect } from "react";

// Keeps the screen on while `active`. This game is played standing back from
// the device with nobody touching it, so a phone would otherwise dim and lock
// mid-fight. Uses the Screen Wake Lock API (Chrome on Android, Safari 16.4+
// on iOS); does nothing where it is unsupported. The browser drops the lock
// whenever the page is hidden, so it is re-requested when it comes back.

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      wakeLock
        .request("screen")
        .then((s) => {
          if (cancelled) void s.release();
          else sentinel = s;
        })
        .catch(() => {
          // Denied (low battery, power saving) - the screen may still sleep.
        });
    };

    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => {});
    };
  }, [active]);
}
