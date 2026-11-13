// One AudioContext for the whole app, unlocked by a real user gesture.
//
// Browsers (iOS Safari strictly, Chrome too) start an AudioContext suspended
// unless it is created or resumed inside a tap or click. This game's menu is
// driven by the camera, so after the "Enable camera" button nothing is ever a
// real gesture: a context created when a fight starts stays silent with no
// error. Creating one context up front and resuming it on taps fixes that.

type Ctor = typeof AudioContext;

let shared: AudioContext | null = null;
let listening = false;

function defaultCtor(): Ctor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext
  );
}

/** The app's AudioContext, created on first use. Null if audio is unsupported. */
export function getSharedAudioContext(ctor: Ctor | undefined = defaultCtor()): AudioContext | null {
  if (shared) return shared;
  if (!ctor) return null;
  shared = new ctor();
  return shared;
}

function resumeIfSuspended(): void {
  if (shared && shared.state !== "running" && shared.state !== "closed") {
    void shared.resume().catch(() => {});
  }
}

/**
 * Call from a click or tap handler. Creates and resumes the shared context,
 * and from then on resumes it on every later tap or key press too (iOS
 * suspends it again after a phone call or switching apps).
 */
export function unlockAudio(ctor: Ctor | undefined = defaultCtor()): void {
  const ctx = getSharedAudioContext(ctor);
  if (!ctx) return;
  resumeIfSuspended();
  if (!listening && typeof document !== "undefined") {
    listening = true;
    for (const type of ["pointerdown", "touchend", "keydown"]) {
      document.addEventListener(type, resumeIfSuspended, { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") resumeIfSuspended();
    });
  }
}

/** Test hook: forget the shared context. */
export function resetSharedAudioContextForTests(): void {
  shared = null;
}
