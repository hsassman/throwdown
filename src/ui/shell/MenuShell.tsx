import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { PoseFrame } from "../../pose/poseTypes";
import { ITEM_BY_ID, SHELL_ITEMS, isPlayable } from "../../menu/shellModel";
import { BrandMark, UiIcon } from "../BrandMark";
import SpotlightCard from "../react-bits/SpotlightCard";
import type { UiPreferences } from "../uiPreferences";
import { useCameraMenu } from "./useCameraMenu";
import "./shell.css";

interface Props {
  poseRef: React.RefObject<PoseFrame | null>;
  cameraReady: boolean;
  cameraProblem?: string | null;
  pointerPaused?: boolean;
  preferences: UiPreferences;
  onPreference: (key: keyof UiPreferences) => void;
  onLaunch: (id: string) => void;
}

const FEATURED_IDS = new Set(["dummy", "cpu", "internet"]);
const FEATURED = SHELL_ITEMS.filter((item) => FEATURED_IDS.has(item.id)).map((item) => item.id);
const PLAY = ["career", "lan", "fighter", "stages"].filter((id) => ITEM_BY_ID.has(id));
const TOOLS = SHELL_ITEMS.filter((item) => item.category === "tools");
const QUICK_TOOL = TOOLS.length === 1 && isPlayable(TOOLS[0]) ? TOOLS[0] : null;
const SETTINGS_TOOLS = QUICK_TOOL ? [] : TOOLS.map((item) => item.id);
const SETTINGS = "settings";
const MOTION = "reducedMotion";
const CONTRAST = "highContrast";
const PLAY_ORDER = [...FEATURED, ...PLAY, ...(QUICK_TOOL ? [QUICK_TOOL.id] : []), SETTINGS];
const SETTINGS_ORDER = [MOTION, CONTRAST, ...SETTINGS_TOOLS, SETTINGS];
const LOCKED = SHELL_ITEMS.filter((item) => !isPlayable(item)).map((item) => item.id);
const CARD_ART: Record<string, string> = {
  dummy: "training", cpu: "fight", internet: "online",
  career: "career", fighter: "kit", stages: "venue", lan: "network",
};

export const MenuShell = memo(function MenuShell({ poseRef, cameraReady, cameraProblem, pointerPaused = false, preferences, onPreference, onLaunch }: Props) {
  const [settings, setSettings] = useState(false);
  const [focusId, setFocusId] = useState(PLAY_ORDER[0]);
  const [rejected, setRejected] = useState<string | null>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const drawerFocus = useRef(false);

  const activate = useCallback((id: string) => {
    if (id === SETTINGS) {
      drawerFocus.current = true;
      setRejected(null);
      setFocusId(settings ? SETTINGS : MOTION);
      setSettings(!settings);
      return;
    }
    if (id === MOTION || id === CONTRAST) {
      onPreference(id);
      return;
    }
    const item = ITEM_BY_ID.get(id);
    if (!item) return;
    setFocusId(id);
    if (!isPlayable(item)) {
      setRejected(id);
      return;
    }
    onLaunch(id);
  }, [onLaunch, onPreference, settings]);

  const camera = useCameraMenu({
    poseRef,
    enabled: cameraReady && !pointerPaused,
    onConfirm: activate,
    disabledIds: LOCKED,
    scrollRef,
  });

  useEffect(() => {
    if (camera.hoverId) setFocusId(camera.hoverId);
  }, [camera.hoverId]);

  useEffect(() => {
    if (drawerFocus.current) {
      targets.current.get(settings ? MOTION : SETTINGS)?.focus({ preventScroll: true });
      drawerFocus.current = false;
    }
  }, [settings]);

  useEffect(() => {
    if (rejected && rejected !== focusId) setRejected(null);
  }, [rejected, focusId]);

  useEffect(() => {
    if (pointerPaused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (settings && event.key === "Escape") {
        event.preventDefault();
        activate(SETTINGS);
        return;
      }
      const order = settings ? SETTINGS_ORDER : PLAY_ORDER;
      const keyboardTarget = order.find((id) => targets.current.get(id) === event.target);
      const index = order.indexOf(keyboardTarget ?? focusId);
      const forward = ["ArrowRight", "ArrowDown", "s"].includes(event.key);
      const backward = ["ArrowLeft", "ArrowUp", "w"].includes(event.key);
      if (forward || backward) {
        event.preventDefault();
        const next = order[(index + (forward ? 1 : -1) + order.length) % order.length];
        setFocusId(next);
        targets.current.get(next)?.focus({ preventScroll: false });
      } else if (event.key === "Enter" || event.key === " ") {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        if (event.target instanceof HTMLButtonElement) return;
        event.preventDefault();
        activate(focusId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activate, focusId, pointerPaused, settings]);

  const refFor = (id: string) => (element: HTMLElement | null) => {
    camera.registerRow(id)(element);
    if (element) targets.current.set(id, element);
    else targets.current.delete(id);
  };

  const focus = ITEM_BY_ID.get(focusId);
  const hint = !cameraReady
    ? cameraProblem ?? "Camera is getting ready."
    : !camera.tracked
      ? "Raise a hand to point at a mode."
      : camera.reason === "moving"
        ? "Hold still to select."
        : camera.reason === "rearm"
          ? "Move away before selecting again."
          : "Point and hold to select.";

  function modeCard(id: string, featured = false) {
    const item = ITEM_BY_ID.get(id);
    if (!item) return null;
    const available = isPlayable(item);
    const art = CARD_ART[id];
    const card = (
        <button type="button" className="shell-row"
          data-mode-id={id} data-focused={id === focusId} data-locked={!available} data-rejected={rejected === id}
          disabled={pointerPaused} ref={refFor(id)}
          onFocus={() => setFocusId(id)}
          onPointerMove={(event) => {
            if (event.pointerType === "mouse" && id !== focusId) setFocusId(id);
          }}
          onClick={() => activate(id)}>
          {art && <img className="mode-image" src={`/ui/${art}.webp`} loading={featured ? "eager" : "lazy"} alt="" />}
          <span className="mode-shade" aria-hidden="true" />
          <span className="shell-row-text">
            <span className="shell-row-title">{item.title}</span>
            <span className="shell-row-blurb">{available ? item.blurb : "Unavailable"}</span>
          </span>
          <span className="mode-icon"><UiIcon name={available ? "open" : "lock"} /></span>
          {rejected === id && <span className="shell-detail-reject" role="alert">{item.lockedReason}</span>}
        </button>
    );
    if (!featured) return <div key={id} className="mode-tile">{card}</div>;
    return (
      <SpotlightCard key={id} className="mode-tile mode-tile-featured"
        spotlightColor="#d5baff" proximity={0} borderGlow={0} intensity={0.22} flare={false}>
        {card}
      </SpotlightCard>
    );
  }

  function preferenceRow(key: keyof UiPreferences, name: string, description: string) {
    return (
      <button className="presentation-option" ref={refFor(key)} type="button" aria-pressed={preferences[key]}
        data-focused={key === focusId} onFocus={() => setFocusId(key)} onClick={() => activate(key)}>
        <span><strong>{name}</strong><small>{description}</small></span>
        <span className="preference-state">{preferences[key] ? "On" : "Off"}</span>
      </button>
    );
  }

  return (
    <main className="shell" ref={camera.containerRef}>
      <header className="shell-head">
        <div className="shell-identity"><BrandMark compact /><span>ShadowBox</span></div>
        <div className="shell-actions">
          {QUICK_TOOL && !settings && (
            <button className="shell-settings" ref={refFor(QUICK_TOOL.id)} type="button" disabled={pointerPaused}
              aria-label={QUICK_TOOL.title} title={QUICK_TOOL.title} data-mode-id={QUICK_TOOL.id}
              data-focused={focusId === QUICK_TOOL.id}
              onFocus={() => setFocusId(QUICK_TOOL.id)} onClick={() => activate(QUICK_TOOL.id)}>
              <UiIcon name="camera" />
            </button>
          )}
          <button className="shell-settings" ref={refFor(SETTINGS)} type="button" disabled={pointerPaused}
            aria-label={settings ? "Close settings" : "Settings"} aria-expanded={settings} aria-controls={settings ? "shell-settings-panel" : undefined}
            data-focused={focusId === SETTINGS} onFocus={() => setFocusId(SETTINGS)} onClick={() => activate(SETTINGS)}>
            <UiIcon name={settings ? "close" : "settings"} />
          </button>
        </div>
      </header>

      <div className="shell-list-wrap" ref={scrollRef} key={settings ? "settings" : "play"}>
        {settings ? (
          <div className="shell-content shell-settings-panel" id="shell-settings-panel">
            <h1>Settings</h1>
            <section aria-labelledby="presentation-heading">
              <h2 id="presentation-heading">Presentation</h2>
              {preferenceRow(MOTION, "Reduce UI motion", "Keep the interface still.")}
              {preferenceRow(CONTRAST, "High contrast", "Use solid backgrounds behind labels.")}
            </section>
            {SETTINGS_TOOLS.length > 0 && <section aria-labelledby="tools-heading">
              <h2 id="tools-heading">Camera tools</h2>
              <div className="mode-grid mode-grid-secondary">{SETTINGS_TOOLS.map((id) => modeCard(id))}</div>
            </section>}
          </div>
        ) : (
          <div className="shell-content">
            <section className="shell-hero" aria-label="ShadowBox">
              <div className="shell-hero-art" aria-hidden="true" />
              <div className="shell-hero-copy">
                <h1 className="shell-title"><BrandMark /></h1>
                <p>Motion-controlled boxing</p>
              </div>
            </section>
            <section className="shell-list" aria-labelledby="play-heading">
              <h2 id="play-heading">Play</h2>
              <div className="mode-grid mode-grid-featured">{FEATURED.map((id) => modeCard(id, true))}</div>
              <div className="mode-grid mode-grid-secondary">{PLAY.map((id) => modeCard(id))}</div>
            </section>
          </div>
        )}
      </div>

      <footer className="shell-footer">
        <div className="shell-camera-state"><UiIcon name="camera" /><span role="status">{hint}</span></div>
        <div className="shell-detail" aria-live="polite">
          {focus && <><span className="shell-detail-title">{focus.title}</span><span className="shell-detail-body">{focus.lockedReason ?? focus.detail}</span></>}
        </div>
        <ul className="shell-inputs" aria-label="How to navigate">
          <li><kbd>←</kbd><kbd>→</kbd> Move</li>
          <li><kbd>Enter</kbd> Open</li>
          <li>Click or tap</li>
          <li>Webcam</li>
        </ul>
      </footer>

      <div className="shell-cursor" ref={camera.cursorRef} aria-hidden="true">
        <svg viewBox="0 0 48 48" className="shell-cursor-ring">
          <circle className="shell-cursor-track" cx="24" cy="24" r="20" />
          <circle className="shell-cursor-progress" cx="24" cy="24" r="20" />
        </svg>
        <span className="shell-cursor-dot" />
      </div>
    </main>
  );
});
