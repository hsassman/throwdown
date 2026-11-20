import { useEffect, useRef, useState } from "react";
import { POPUP_LANES as LANES, freeLane, popupFor, type ImpactLog, type Popup } from "../sim/impactFeedback";
import "./impactPopups.css";

// Words over the fight when a punch lands, is blocked or is slipped, and a
// red edge flash when the player is hit. This is the "did that count?"
// answer: a player standing back from a webcam can't read a log, and a punch
// that lands with no visible response feels like the tracking missed it.
//
// Polls the impact log on its own animation frame rather than waiting for the
// HUD's 10 Hz refresh, so the word appears in the same frame as the hit.

interface Shown extends Popup {
  id: number;
  /** Slight horizontal spread, so a combination reads as several words. */
  x: number;
  /** Which row the word sits in - see `freeLane`. */
  lane: number;
}


const LIFETIME_MS = 700;

export function ImpactPopups({ logRef }: { logRef: React.RefObject<ImpactLog> }) {
  const [shown, setShown] = useState<Shown[]>([]);
  const [flash, setFlash] = useState(0);
  const lastSeq = useRef(logRef.current?.since(0).at(-1)?.seq ?? 0);

  useEffect(() => {
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    /** The words on screen, kept here so lanes are assigned outside React's
     *  state updaters, which must stay free of side effects. */
    let live: Shown[] = [];
    const tick = () => {
      const fresh = logRef.current?.since(lastSeq.current) ?? [];
      for (const imp of fresh) {
        lastSeq.current = imp.seq;
        if (imp.kind === "taken") {
          // Keyed so a second hit restarts the animation.
          setFlash(imp.seq);
          continue;
        }
        const p = popupFor(imp);
        if (!p) continue;
        // At most one word per lane is alive; the oldest gives way.
        if (live.length >= LANES.length) live.shift();
        const item: Shown = {
          ...p,
          id: imp.seq,
          x: ((imp.seq * 37) % 13) - 6,
          lane: freeLane(live.map((w) => w.lane)),
        };
        live.push(item);
        setShown([...live]);
        timers.push(
          setTimeout(() => {
            live = live.filter((w) => w.id !== item.id);
            setShown([...live]);
          }, LIFETIME_MS)
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [logRef]);

  return (
    <div className="impact-layer" aria-hidden="true">
      {flash > 0 && <div key={flash} className="impact-flash" />}
      {shown.map((p) => (
        <span
          key={p.id}
          className={`impact-word impact-${p.tone} impact-size-${p.size}`}
          style={{ left: `calc(50% + ${p.x}vw)`, top: `${LANES[p.lane]}%` }}
        >
          {p.text}
        </span>
      ))}
    </div>
  );
}
