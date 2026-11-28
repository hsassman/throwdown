import { useCallback, useEffect, useState } from "react";

export interface UiPreferences {
  reducedMotion: boolean;
  highContrast: boolean;
}

const KEY = "shadowbox.presentation.v1";

function readPreferences(): UiPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { reducedMotion: saved?.reducedMotion === true, highContrast: saved?.highContrast === true };
  } catch {
    return { reducedMotion: false, highContrast: false };
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
    const next = { ...preferences, [key]: !preferences[key] };
    setPreferences(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // The setting still applies to this session if storage is unavailable.
    }
  }, [preferences]);
  return { preferences, changePreference };
}
