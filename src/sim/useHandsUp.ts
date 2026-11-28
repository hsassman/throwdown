import { useEffect, useRef } from "react";
import type { BodyMotion } from "../perception/bodyMotion";

/** Wrists this far above the hips, torso units, is both hands over the head: well above any guard. */
export const HANDS_UP_HEIGHT = 1.6;
export const HANDS_UP_HOLD_MS = 1200;

/** True once hands have been up continuously for `holdMs`, given the time they went up. */
export function handsUpHeld(upSince: number | null, now: number, holdMs = HANDS_UP_HOLD_MS): boolean {
  return upSince !== null && now - upSince >= holdMs;
}

/** Calls `onHold` when the player holds both hands over their head, a gesture
 *  for screens with no cursor (the end of a fight). */
export function useHandsUp(bodyRef: React.RefObject<BodyMotion | null>, active: boolean, onHold: () => void) {
  const cb = useRef(onHold);
  cb.current = onHold;
  useEffect(() => {
    if (!active) return;
    let since: number | null = null;
    let raf = 0;
    const tick = () => {
      const b = bodyRef.current;
      const now = performance.now();
      if (!b?.tracked || b.guardHeight < HANDS_UP_HEIGHT) since = null;
      else since ??= now;
      if (handsUpHeld(since, now)) {
        since = null;
        cb.current();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, bodyRef]);
}
