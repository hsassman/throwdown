import { reviveProfile, type TrainingProfile } from "./profile";

// localStorage persistence for the training profile.
// EVERY OPERATION HERE IS ALLOWED TO FAIL, AND NONE OF THEM MAY THROW
//
// `localStorage` is not the reliable key-value store it looks like:
//
//   * It is absent entirely in a Vitest/node environment, and in a worker.
//   * Access to it THROWS (not returns null) in a browser configured to block
//     site data, and in some private-browsing modes.
//   * `setItem` throws `QuotaExceededError` when full — and Safari reports a
//     zero quota in private mode, so the very first write can fail.
//
// A training mode that dies because the browser declined to remember a score
// would be a spectacularly bad trade. So reads fall back to a fresh profile
// and writes fail silently-but-observably: `lastError` records what happened
// so the UI can mention it once, rather than the app either crashing or
// pretending the save worked.

const KEY = "shadowbox.training.v1";

export interface StoreResult {
  profile: TrainingProfile;
  /** True when the profile came off disk rather than being freshly created. */
  restored: boolean;
  /** Human-readable problem, if any. Null when everything worked. */
  error: string | null;
}

/** Narrow wrapper so a missing or hostile localStorage is handled in one place. */
function storage(): Storage | null {
  try {
    // The access itself can throw, so it must be inside the try — checking
    // `typeof localStorage` first is not enough.
    const s = globalThis.localStorage;
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

export function loadProfile(now = 0): StoreResult {
  const s = storage();
  if (!s) {
    return {
      profile: reviveProfile(null, now),
      restored: false,
      error: "This browser is not allowing saved data, so training will not be remembered.",
    };
  }
  let raw: string | null = null;
  try {
    raw = s.getItem(KEY);
  } catch {
    return {
      profile: reviveProfile(null, now),
      restored: false,
      error: "Could not read saved training data.",
    };
  }
  if (raw === null) {
    return { profile: reviveProfile(null, now), restored: false, error: null };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Half a JSON document, from a tab killed mid-write. reviveProfile would
    // handle the resulting object fine, but it never gets one.
    return {
      profile: reviveProfile(null, now),
      restored: false,
      error: "Saved training data was damaged and has been reset.",
    };
  }
  const profile = reviveProfile(parsed, now);
  // reviveProfile returns a fresh profile for a version mismatch too, so
  // "restored" is judged on whether any evidence actually survived rather than
  // on whether a string was present.
  return { profile, restored: profile.totalStrikes > 0, error: null };
}

/** Writes the profile. Returns an error string on failure, or null. */
export function saveProfile(profile: TrainingProfile): string | null {
  const s = storage();
  if (!s) return "Training progress is not being saved.";
  try {
    s.setItem(KEY, JSON.stringify(profile));
    return null;
  } catch (e) {
    const quota =
      e instanceof Error &&
      (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
    return quota
      ? "Browser storage is full, so training progress is not being saved."
      : "Training progress could not be saved.";
  }
}

/** Forgets everything. Used by the "reset training" action. */
export function clearProfile(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing useful to do, and nothing depends on it having worked.
  }
}
