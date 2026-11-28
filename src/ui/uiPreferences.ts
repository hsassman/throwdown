import { useCallback, useEffect, useState } from "react";

export interface UiPreferences {
  reducedMotion: boolean;
  highContrast: boolean;
  /** The webcam picture in the corner inset. Off shows only the tracked skeleton. */
  showCamera: boolean;
  /** Fights from behind the fighter instead of through their eyes. */
  thirdPerson: boolean;
}

const DEFAULTS: UiPreferences = { reducedMotion: false, highContrast: false, showCamera: false, thirdPerson: false };

const KEY = "shadowbox.presentation.v1";

function readPreferences(): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof UiPreferences)[]) {
      if (typeof saved[key] === "boolean") out[key] = saved[key];
    }
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

export function useUiPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-ui-reduced", preferences.reducedMotion);
    root.toggleAttribute("data-ui-contrast", preferences.highContrast);
    return () => {
      root.removeAttribute("data-ui-reduced");
      root.removeAttribute("data-ui-contrast");
    };
  }, [preferences]);

  const changePreference = useCallback((key: keyof UiPreferences) => {
    setPreferences((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // The setting still applies to this session if storage is unavailable.
      }
      return next;
    });
  }, []);
  return { preferences, changePreference };
}
