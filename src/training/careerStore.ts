import { reviveCareerProfile, type CareerProfile } from "./career";

// localStorage persistence for the career ladder. Same contract as
// training/profileStore.ts — every operation is allowed to fail, none of
// them may throw. See that file for the full reasoning; not repeated here.

const KEY = "shadowbox.career.v1";

export interface CareerStoreResult {
  profile: CareerProfile;
  restored: boolean;
  error: string | null;
}

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

export function loadCareerProfile(now = 0): CareerStoreResult {
  const s = storage();
  if (!s) {
    return {
      profile: reviveCareerProfile(null, now),
      restored: false,
      error: "This browser is not allowing saved data, so career progress will not be remembered.",
    };
  }
  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
  } catch {
    return {
      profile: reviveCareerProfile(null, now),
      restored: false,
      error: "Could not read saved career data.",
    };
  }
  if (raw === null) {
    return { profile: reviveCareerProfile(null, now), restored: false, error: null };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      profile: reviveCareerProfile(null, now),
      restored: false,
      error: "Saved career data was damaged and has been reset.",
    };
  }
  const profile = reviveCareerProfile(parsed, now);
  const fresh = reviveCareerProfile(null, now);
  const restored =
    profile.rank !== fresh.rank ||
    profile.record.wins > 0 ||
    profile.record.losses > 0 ||
    profile.record.draws > 0;
  return { profile, restored, error: null };
}

export function saveCareerProfile(profile: CareerProfile): string | null {
  const s = storage();
  if (!s) return "Career progress is not being saved.";
  try {
    s.setItem(KEY, JSON.stringify(profile));
    return null;
  } catch (e) {
    const quota =
      e instanceof Error &&
      (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return quota
      ? "Browser storage is full, so career progress is not being saved."
      : "Career progress could not be saved.";
  }
}

export function clearCareerProfile(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing useful to do, and nothing depends on it having worked.
  }
}
