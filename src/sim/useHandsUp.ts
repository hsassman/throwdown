import { useEffect, useRef } from "react";
import type { BodyMotion } from "../perception/bodyMotion";

/** Wrists this far above the hips, torso units, is both hands over the head: well above any guard. */
const HANDS_UP_HEIGHT = 1.6;
const HOLD_MS = 1200;

/** Calls `onHold` when the player holds both hands over their head, a gesture
 *  for screens with no cursor (the end of a fight). */
export function useHandsUp(bodyRef: React.RefObject<BodyMotion | null>, active: boolean, onHold: () => void) {
  const cb = useRef(onHold);
  cb.current = onHold;
  useEffect(() => {
    if (!active) return;
    // Fills while the hands are up and drains twice as fast while they are
    // not, so one dropped tracking frame does not restart the hold.
    let held = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const b = bodyRef.current;
      held = b?.tracked && b.guardHeight >= HANDS_UP_HEIGHT ? held + dt : Math.max(0, held - 2 * dt);
      if (held >= HOLD_MS) {
        held = 0;
        cb.current();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, bodyRef]);
}
