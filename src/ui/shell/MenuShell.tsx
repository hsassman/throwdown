import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PoseFrame } from "../../pose/poseTypes";
import {
  CATEGORY_LABEL,
  ITEM_BY_ID,
  SHELL_ITEMS,
  grouped,
  isPlayable,
  type ShellItem,
} from "../../menu/shellModel";
import { useCameraMenu } from "./useCameraMenu";
import { POINTER_CONFIG } from "../../config/tuning";
import "./shell.css";

// The menu.
// Two inputs, one source of truth
//
// The list is driven by both the camera pointer and the keyboard, and they
// must never disagree about where focus is. So there is exactly one `focusId`
// in state, and each input writes to it - the camera on hover, the keyboard on
// arrow keys. The detail panel reads only that.
//
// The alternative, which is what usually gets built, is a `hoverIndex` for the
// mouse and a `focusIndex` for the keyboard, and then a permanent low-grade
// bug where the panel shows one thing and the confirm activates another.
//
// Real DOM focus is kept in sync too, so a screen reader and Tab still work.
// The camera is an addition to the keyboard here, never a replacement - a
// player whose camera is not working must still be able to reach the tracking
// diagnostics that would tell them why.

interface Props {
  poseRef: React.RefObject<PoseFrame | null>;
  /** True once the camera is delivering usable poses. */
  cameraReady: boolean;
  onLaunch: (id: string) => void;
}

const GROUPS = grouped();
const FLAT: ShellItem[] = GROUPS.flatMap((g) => g.items);
const LOCKED = SHELL_ITEMS.filter((i) => !isPlayable(i)).map((i) => i.id);

export function MenuShell({ poseRef, cameraReady, onLaunch }: Props) {
  const [focusId, setFocusId] = useState<string>(FLAT[0].id);
  const [rejected, setRejected] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());

  const launch = useCallback(
    (id: string) => {
      const item = ITEM_BY_ID.get(id);
      if (!item) return;
      setFocusId(id);
      if (!isPlayable(item)) {
        // Pressing a locked row must explain, not silently do nothing. Silence
        // is indistinguishable from the input being broken - and with a camera
        // pointer the player's first assumption will always be that the
        // tracking failed.
        setRejected(id);
        return;
      }
      onLaunch(id);
    },
    [onLaunch]
  );

  const camera = useCameraMenu({
    poseRef,
    enabled: cameraReady,
    onConfirm: launch,
    disabledIds: LOCKED,
  });

  // The camera's hover is the focus. One source of truth.
  useEffect(() => {
    if (camera.hoverId) setFocusId(camera.hoverId);
  }, [camera.hoverId]);

  // Clear a rejection message once the player moves on.
  useEffect(() => {
    if (rejected && rejected !== focusId) setRejected(null);
  }, [focusId, rejected]);

  // Keyboard, kept working alongside the camera.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const i = FLAT.findIndex((x) => x.id === focusId);
      if (i < 0) return;
      const move = (d: number) => {
        e.preventDefault();
        // Wrapping, not clamping - pressing down on the last row to reach the
        // first is the convention and it is genuinely faster.
        const next = FLAT[(((i + d) % FLAT.length) + FLAT.length) % FLAT.length];
        setFocusId(next.id);
        rowEls.current.get(next.id)?.focus({ preventScroll: false });
      };
      switch (e.key) {
        case "ArrowDown":
        case "s":
          move(1);
          break;
        case "ArrowUp":
        case "w":
          move(-1);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          launch(focusId);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusId, launch]);

  const focused = useMemo(() => ITEM_BY_ID.get(focusId) ?? FLAT[0], [focusId]);

  // What the camera is doing right now. Only ever about the camera, because
  // that is the input whose state the player cannot see for themselves - the
  // keyboard and mouse either work or the machine is broken, and reporting on
  // them frame by frame would be noise.
  const hint = !cameraReady
    ? "Camera not running."
    : !camera.tracked
      ? "Raise a hand into frame to point."
      : camera.reason === "moving"
        ? "Hold still to select."
        : camera.reason === "rearm"
          ? "Move away, then back, to choose again."
          : "Hold your hand over a row to choose it.";

  return (
    <div className="shell">
      <div className="shell-bg" aria-hidden="true">
        <div className="shell-glow" />
        <div className="shell-grid" />
      </div>

      <header className="shell-head">
        <h1 className="shell-title">
          Shadow<span>Box</span>
        </h1>
        <p className="shell-hint" role="status">
          {hint}
        </p>
        {/* Every input the shell accepts, stated once and always visible. The
            three are genuinely equal here - the camera is the headline, but a
            player whose webcam is covered, or who is simply sitting down,
            needs to know the list is fully navigable without it, and that was
            previously only mentioned once the camera had already failed. */}
        <ul className="shell-inputs" aria-label="How to navigate">
          <li>
            <kbd>&uarr;</kbd>
            <kbd>&darr;</kbd> move
          </li>
          <li>
            <kbd>Enter</kbd> select
          </li>
          <li>Mouse: hover and click</li>
          <li>Camera: hold a hand over a row</li>
        </ul>
      </header>

      <div className="shell-body">
        <div className="shell-list-wrap" ref={camera.containerRef}>
          <ul className="shell-list" role="menu" aria-label="Game modes">
            {GROUPS.map((group) => (
              <li key={group.category} className="shell-group">
                <h2 className="shell-group-label">{CATEGORY_LABEL[group.category]}</h2>
                <ul className="shell-group-items">
                  {group.items.map((item) => {
                    const playable = isPlayable(item);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          role="menuitem"
                          className="shell-row"
                          data-availability={item.availability}
                          data-focused={item.id === focusId}
                          data-rejected={rejected === item.id}
                          data-locked={!playable}
                          /* Deliberately not aria-disabled. A locked row is
                             not a dead control - activating it explains why it
                             is locked, which is the whole point. Marking it
                             disabled would promise assistive technology that
                             pressing it does nothing, which is false, and it
                             also makes the row unreachable to automation.
                             The "Not built" badge is inside the button, so it
                             is part of the accessible name already. */
                          ref={(el) => {
                            camera.registerRow(item.id)(el);
                            if (el) rowEls.current.set(item.id, el);
                            else rowEls.current.delete(item.id);
                          }}
                          onMouseEnter={() => setFocusId(item.id)}
                          onFocus={() => setFocusId(item.id)}
                          onClick={() => launch(item.id)}
                        >
                          {/* The dwell ring, drawn on the row itself so the
                              player can watch the row fill rather than having
                              to look at their own hand. */}
                          <span className="shell-row-fill" aria-hidden="true" />
                          <span className="shell-row-text">
                            <span className="shell-row-title">{item.title}</span>
                            <span className="shell-row-blurb">{item.blurb}</span>
                          </span>
                          <Badge availability={item.availability} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <div className="shell-cursor" ref={camera.cursorRef} aria-hidden="true">
            <svg viewBox="0 0 48 48" className="shell-cursor-ring">
              <circle className="shell-cursor-track" cx="24" cy="24" r="20" />
              <circle className="shell-cursor-progress" cx="24" cy="24" r="20" />
            </svg>
            <span className="shell-cursor-dot" />
          </div>
        </div>

        <aside className="shell-detail" aria-live="polite">
          <h2 className="shell-detail-title">{focused.title}</h2>
          <Badge availability={focused.availability} />
          <p className="shell-detail-body">{focused.detail}</p>
          {focused.lockedReason && (
            <p className="shell-detail-locked">{focused.lockedReason}</p>
          )}
          {rejected === focused.id && (
            <p className="shell-detail-reject" role="alert">
              Not available yet - {focused.lockedReason}
            </p>
          )}
          <p className="shell-detail-dwell">
            Hold for {(POINTER_CONFIG.dwellMs / 1000).toFixed(1)}s to confirm.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Badge({ availability }: { availability: ShellItem["availability"] }) {
  const label =
    availability === "ready" ? "Ready" : availability === "preview" ? "Rough" : "Not built";
  return (
    <span className="shell-badge" data-availability={availability}>
      {label}
    </span>
  );
}
