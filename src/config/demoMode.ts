// `?demo`: a preset for the on-stage match. Trades picture quality for pose
// rate, because pose rate is what decides how closely each fighter's figure
// follows them (modelled: ~77 ms behind at 25 poses/s, ~160 ms at 8-12/s).
//
//   https://<site>/?demo
//
// Everything it changes is about speed; nothing changes how hits are judged.
// Explicit settings in the link (e.g. ?camW=640&camH=480) still win.

export const DEMO_PRESET = {
  /**
   * Capture size. Many webcams only offer their 60 FPS mode at low
   * resolutions, and with ~36 ms inference 60 FPS capture lifts the pose rate
   * from ~15 to ~20/s (see CAMERA_CONFIG.frameRate). BlazePose resizes to
   * 256x256 anyway, so accuracy barely moves.
   */
  camWidth: 320,
  camHeight: 240,
  /** Render resolution ceiling. The scene shares the GPU with pose inference. */
  maxPixelRatio: 1.0,
  /** No multisample anti-aliasing: a full-screen cost every frame. */
  antialias: false,
  /** No soft shadows: an extra render pass of the fighters every frame. */
  shadows: false,
  /** No animated crowd around the ring. */
  crowd: false,
  /** Straight to the menu: the walkthrough is for first-time players. */
  skipFirstRun: true,
} as const;

/** True when the page was opened with ?demo (any value except 0/false). */
export function isDemoMode(search: string = typeof window === "undefined" ? "" : window.location.search): boolean {
  const v = new URLSearchParams(search).get("demo");
  return v !== null && v !== "0" && v.toLowerCase() !== "false";
}
