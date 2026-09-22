import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../../pose/poseTypes";
import { CameraPointer, type PointerTarget } from "./pointerModel";

// Binds the camera pointer to real DOM rows.
// The pointer updates every animation frame. Putting its position in state
// would re-render the whole menu sixty times a second to move one dot, and on
// a machine already spending ~36ms per frame on pose inference that is exactly
// the budget the game cannot spare.
//
// So the fast-changing things - cursor position, dwell progress - are written
// Directly to the DOM: a transform on the cursor element, and a CSS custom
// property on the hovered row that its ring reads. React state is updated only
// when the hovered row changes, which happens a few times a second at most and
// is what the detail panel actually needs.
// Rects are re-measured, not cached forever
//
// `getBoundingClientRect` is measured once per frame for the rows. That sounds
// wasteful and is not: reading layout once per frame in a single batch, before
// any writes, is the cheap pattern. Caching the rects instead would break the
// moment the list scrolled, the window resized, or a row animated - and the
// failure mode is invisible and horrible, because the cursor would activate
// rows that are no longer where it thinks they are.

export interface CameraMenuOptions {
  poseRef: React.RefObject<PoseFrame | null>;
  enabled: boolean;
  /** Confirm handler. Fires once per completed dwell. */
  onConfirm: (id: string) => void;
  /** Ids that may be hovered but never activated. */
  disabledIds?: readonly string[];
}

export interface CameraMenuHandle {
  /** Attach to the element the cursor's coordinates are relative to. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the cursor element. */
  cursorRef: React.RefObject<HTMLDivElement | null>;
  /** Register each activatable row. */
  registerRow: (id: string) => (el: HTMLElement | null) => void;
  /** The row currently hovered. Changes rarely, so it is safe in state. */
  hoverId: string | null;
  /** Whether the pointer has a live reading. */
  tracked: boolean;
  /** Why a dwell is not filling, for the hint line. */
  reason: "moving" | "settling" | "rearm" | null;
}

export function useCameraMenu(options: CameraMenuOptions): CameraMenuHandle {
  const { poseRef, enabled, onConfirm, disabledIds } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());
  const pointerRef = useRef<CameraPointer | null>(null);
  if (!pointerRef.current) pointerRef.current = new CameraPointer();

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [tracked, setTracked] = useState(false);
  const [reason, setReason] = useState<CameraMenuHandle["reason"]>(null);

  // Callbacks in a ref so the animation loop binds once. Re-binding a rAF loop
  // every render is how a menu ends up firing one confirm twice.
  const cbs = useRef({ onConfirm, disabledIds });
  cbs.current = { onConfirm, disabledIds };

  const registerRow = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) rowsRef.current.set(id, el);
      else rowsRef.current.delete(id);
    },
    []
  );

  useEffect(() => {
    if (!enabled) {
      pointerRef.current?.reset();
      setHoverId(null);
      setTracked(false);
      return;
    }
    const pointer = pointerRef.current!;
    let rafId = 0;
    let lastHover: string | null = null;
    let lastReason: CameraMenuHandle["reason"] = null;
    let lastTracked: boolean | null = null;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const container = containerRef.current;
      if (!container) return;

      // --- One layout read, batched, before any writes. ---
      const box = container.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      const targets: PointerTarget[] = [];
      for (const [id, el] of rowsRef.current) {
        const r = el.getBoundingClientRect();
        targets.push({
          id,
          x: (r.left - box.left) / box.width,
          y: (r.top - box.top) / box.height,
          w: r.width / box.width,
          h: r.height / box.height,
          disabled: cbs.current.disabledIds?.includes(id) ?? false,
        });
      }

      const state = pointer.update(poseRef.current, targets, performance.now());

      // --- Writes. ---
      const cursor = cursorRef.current;
      if (cursor) {
        cursor.style.transform = `translate3d(${state.x * box.width}px, ${
          state.y * box.height
        }px, 0)`;
        cursor.style.opacity = state.tracked ? "1" : "0";
        cursor.dataset.hand = state.hand;
        cursor.style.setProperty("--dwell", String(state.progress));
        cursor.dataset.armed = state.progress > 0 ? "true" : "false";
      }

      // The ring lives on the row as well as the cursor, so the player can see
      // which row is filling without having to look at their own hand.
      for (const [id, el] of rowsRef.current) {
        const p = id === state.hoverId ? state.progress : 0;
        el.style.setProperty("--dwell", String(p));
      }

      if (state.pressed) cbs.current.onConfirm(state.pressed);

      // --- State, only when something a human would notice changes. ---
      if (state.hoverId !== lastHover) {
        lastHover = state.hoverId;
        setHoverId(state.hoverId);
      }
      if (state.reason !== lastReason) {
        lastReason = state.reason;
        setReason(state.reason);
      }
      if (state.tracked !== lastTracked) {
        lastTracked = state.tracked;
        setTracked(state.tracked);
      }
    };
    tick();
    return () => cancelAnimationFrame(rafId);
  }, [enabled, poseRef]);

  return { containerRef, cursorRef, registerRow, hoverId, tracked, reason };
}
