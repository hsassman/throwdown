// Every tunable constant in the game. Thresholds and game feel are adjusted
// here, never at a call site.

import { DEMO_PRESET, isDemoMode } from "./demoMode";

export const POSE_CONFIG = {
  /**
   * Served from public/, not a CDN: a version mismatch between the npm package
   * and a remotely-hosted runtime breaks loading. `lite` is the fastest of the
   * three bundles; `full` is the lever if landmark quality ever proves to be
   * the limit rather than frame rate.
   */
  modelAssetPath: `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`,
  wasmRoot: `${import.meta.env.BASE_URL}mediapipe/wasm`,

  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,

  /**
   * Inference in a Web Worker. Off: measured at 13.8 vs 15.1 FPS, and it cannot
   * load under the dev server (MediaPipe needs a classic worker). `?worker=1`
   * against a production build re-runs the comparison on other hardware.
   */
  get useWorker() {
    return queryFlag("worker", false);
  },

  /** Crop to the player before inference - the largest accuracy win, and a
   *  speed win too. `?roi=0` compares against the whole-frame path. */
  get useRoi() {
    return queryFlag("roi", true);
  },

  /** Biomechanical constraint solving. ?constraints=0 to compare. */
  get useConstraints() {
    return queryFlag("constraints", true);
  },

  /** Forward prediction to cancel pipeline latency. ?predict=0 to compare. */
  get usePrediction() {
    return queryFlag("predict", true);
  },

  /**
   * Re-arm the video-frame callback before running inference rather than
   * after. This is the single change that unpins the pose rate from the
   * camera's frame grid - see usePoseTracking's detect(). Flagged only so the
   * old behaviour can be measured against it; there is no reason to turn it
   * off otherwise.
   */
  get pipelineFrames() {
    return queryFlag("pipeline", true);
  },

  /**
   * Forces a specific inference backend, for measurement only: ?delegate=cpu
   * or ?delegate=gpu. Absent (the default) keeps the shipped behaviour -
   * GPU first with a CPU fallback - which docs/ARCHITECTURE.md lists as non-negotiable.
   * This does not change that default; it only makes it testable.
   */
  /**
   * First-choice backend for the worker path. Follows ?delegate= like the
   * main-thread path; absent, GPU first as the ground rule says.
   */
  get workerDelegate(): "GPU" | "CPU" {
    return this.forceDelegate ?? "GPU";
  },

  get forceDelegate(): "GPU" | "CPU" | null {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search)
      .get("delegate")
      ?.toUpperCase();
    return raw === "GPU" || raw === "CPU" ? raw : null;
  },
};

/** The deployed game and the .NET server it talks to. Public addresses. */
export const LIVE_SITE = {
  host: "throwdown-orcin.vercel.app",
  matchmakingUrl: "https://throwdown-myc3.onrender.com/hubs/matchmaking",
} as const;

/** The server for a production page on `hostname`: the deployed one on the
 *  live site, none anywhere else. */
export function liveSiteServer(hostname: string): string | null {
  return hostname === LIVE_SITE.host ? LIVE_SITE.matchmakingUrl : null;
}

export const NET_CONFIG = {
  /**
   * The MatchmakingHub this build talks to for "Find a match" and the
   * leaderboard, or null when this build has no server.
   * The live site falls back to the deployed server when VITE_MATCHMAKING_URL
   * is unset; only that host, because the server only accepts that origin.
   */
  matchmakingUrl: (import.meta.env.VITE_MATCHMAKING_URL ||
    (import.meta.env.DEV
      ? "http://localhost:5160/hubs/matchmaking"
      : liveSiteServer(typeof window === "undefined" ? "" : window.location.hostname))) as string | null,
  /**
   * Fallback only. "Find a match" asks the server's /ice-servers endpoint
   * first (see net/iceServers.ts), which is where TURN gets configured. This
   * STUN-only list is used when that fails, and is enough for most home NATs
   * but not for the symmetric/CGNAT ones STUN cannot traverse.
   */
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }] as RTCIceServer[],
  /**
   * How long a matched pair gets to open the peer link before this side gives
   * up and offers "Find a match" again. Long enough for a slow phone to gather
   * candidates and the ICE checks to run; short enough that a pairing a
   * network can never connect (no TURN, strict NAT) doesn't strand a player at
   * the front of a conference room.
   */
  connectTimeoutMs: 20000,
  /** The host holds its own punches at the guest for one round trip, within
   *  these bounds, so the guest's defence (which arrives late) is judged fairly. */
  defendWindowMinMs: 30,
  defendWindowMaxMs: 150,
  /** The guest restates its defence this often even when it has not changed, ms. */
  defenceHeartbeatMs: 250,
};

/**
 * Reads a numeric override from the query string, so measurement runs can A/B
 * capture settings without editing this file (e.g. ?camW=320&camH=240).
 * Returns the fallback when absent or malformed.
 */
function queryNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Boolean flag from the query string: ?key=0 / ?key=1.
 * Kept separate from queryNumber, which treats 0 as invalid (a zero-width
 * camera is nonsense, but a zero-valued flag is exactly how you turn something
 * off - folding the two together silently ignored ?worker=0).
 */
function queryFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw === null) return fallback;
  return raw === "1" || raw === "true";
}

export const CAMERA_CONFIG = {
  /** Requested capture resolution. */
  get width() {
    return queryNumber("camW", isDemoMode() ? DEMO_PRESET.camWidth : 640);
  },
  get height() {
    return queryNumber("camH", isDemoMode() ? DEMO_PRESET.camHeight : 480);
  },

  /**
   * Requested capture frame rate. Raised from 30 to 60 - this is the single
   * cheapest lever on the measured 15 FPS pose rate, and it is about
   * Quantization, not throughput.
   */
  get frameRate() {
    return queryNumber("camFps", 60);
  },
};

export const SMOOTHING_DEFAULTS = {
  /**
   * One-euro filter in front of the CHARACTER (not hit detection - that is
   * STRIKE_SMOOTHING below).
   */
  minCutoff: 1.5,
  beta: 10,
  dCutoff: 1.0,
};

/** The filter in front of strike resolution, separate from SMOOTHING_DEFAULTS. */
export const STRIKE_SMOOTHING = {
  minCutoff: 2.0,
  beta: 20,
  dCutoff: 1.0,
} as const;

/** Punch detection and classification (Milestone 1, Approach A). */
export const PERCEPTION_CONFIG = {
  /** Below this landmark confidence, a frame is ignored rather than guessed at. */
  minLandmarkConfidence: 0.5,

  /** Good frames needed before calibration can be accepted. */
  calibrationMinSamples: 30,

  // --- Punch detection (the tractable half; see the gesture-classification notes) ---

  /** Detection gates. */

  /**
   * Floor for fist travel from guard, torso units. Effective threshold is the
   * larger of this and the player's measured guard jitter × guardNoiseMultiple.
   * Set below the smallest modelled punch - a fully foreshortened jab displaces
   * the fist only ~0.16 torso units, so anything near 0.2 rejects real punches.
   */
  minPunchExcursion: 0.13,
  /** Multiple of measured guard jitter treated as the noise ceiling. */
  guardNoiseMultiple: 3,
  /** Below this excursion the hand counts as back at guard, re-arming. */
  guardExcursion: 0.07,
  /**
   * Minimum mean outward speed of the fist, torso-widths per second. Mean, not
   * peak: peak is measured between frames, so a slower camera under-reports it
   * and the same punch would pass at 30 FPS and fail at 15. Mean distance-over-
   * duration is sampling-invariant, which matters across the hardware this
   * targets. Set above what the excursion floor and duration ceiling jointly
   * imply (~0.19) but well below a real punch (~1.1).
   */
  minMeanSpeed: 0.35,
  /**
   * Minimum samples between launch and peak. At 15 FPS a fast punch's outward
   * travel spans barely two frames, so requiring three discarded real punches
   * on slower hardware.
   */
  minPunchSamples: 2,
  /** Minimum gap between two punches from the same hand (ms). */
  cooldownMs: 250,
  /** A punch taking longer than this is discarded as a slow reach, not a punch. */
  maxPunchDurationMs: 700,
  /** Trajectory samples kept per hand (~1.5s at 30fps). */
  historySize: 45,

  // --- Classification (the hard half) ---

  /** Inward horizontal travel (torso units) that starts to read as a hook. */
  hookInwardTravel: 0.28,
  /** Upward travel (torso units) that starts to read as an uppercut. */
  uppercutUpwardTravel: 0.3,
  /** Dropping this far below the shoulder line supports an uppercut reading. */
  uppercutChamberDepth: 0.25,
  /** Path/straight-line ratio above which motion reads as curved rather than straight. */
  curvedPathRatio: 1.18,
  /**
   * Minimum score margin between best and runner-up for a confident call.
   * Below this the classification is reported but flagged as low-confidence.
   */
  minConfidenceMargin: 0.15,

  // --- Dodge / duck detection (Milestone 2) ---
  //
  // Dead zones absorb natural sway and breathing. Milestone 2's done-when is
  // "no noticeable false triggers from normal head movement", so these are
  // the numbers that decide whether it passes - expect to tune them against
  // real movement, including simply standing and looking around.

  /** Lateral head offset ignored entirely, torso units. */
  dodgeDeadZone: 0.08,
  /** Lateral offset treated as a full-commitment dodge. */
  dodgeFullRange: 0.34,

  /** Head-toward-shoulders drop ignored entirely, torso units. */
  duckDeadZone: 0.07,
  /** Head drop treated as a full duck. */
  duckFullRange: 0.3,

  /**
   * Whole-body crouch (shoulder line dropping) thresholds. Separate from the
   * head-drop pair because bending the knees lowers head and shoulders
   * together, leaving their relative distance unchanged. Tolerances are wider:
   * this signal is measured against an absolute calibrated height, so it
   * drifts if the player moves toward or away from the camera.
   */
  bodyDropDeadZone: 0.12,
  bodyDropFullRange: 0.45,
};

/**
 * Character rendering and retargeting (Track B). Cosmetic only - nothing here
 * influences punch classification, hit resolution or the simulation.
 */
/**
 * Ducking, as a body rather than a height. See render/retargeting/crouch.ts.
 */
export const CROUCH_CONFIG = {
  /** Knee bend at a full crouch, radians. 45 degrees on a ~0.9-unit leg drops
   *  the hips about 26cm, which is roughly what a boxer gets out of a duck. */
  kneeAngle: (45 * Math.PI) / 180,
  /** Forward fold at the waist at a full crouch, radians. This is what takes
   *  the head off the punch line - the knees only supply the height. */
  waistFold: (22 * Math.PI) / 180,
} as const;

export const RENDER_CONFIG = {
  /** Smoothing time constant for bone rotations, seconds. */
  boneSmoothingTau: 0.06,

  /**
   * Smoothing time constant used when a bone has a long way to travel -
   * i.e. real, fast motion rather than landmark jitter. The driver blends
   * between this and `boneSmoothingTau` by how far the bone is from its
   * target, so idle pose stays calm while a punch stays sharp. A single fixed
   * constant cannot do both: long enough to bridge the ~15 FPS pose stream
   * without visible stepping is also long enough to blunt a jab.
   */
  boneSmoothingTauFast: 0.022,

  /** Discrepancy, radians, treated as fully "fast motion" for the blend
   * above. ~23 degrees - well beyond jitter, well within a thrown punch. */
  fastMotionAngle: 0.4,

  /**
   * How long a bone coasts on its last good target after its landmarks drop
   * out, seconds, before fading back to rest.
   */
  landmarkHoldSeconds: 0.25,

  /** Smoothing time constant for whole-body position, seconds. Slower than
   * the limbs: body weight shifts are slower than punches, and this axis is
   * noisier because it rides on the shoulder/hip midpoints. */
  rootSmoothingTau: 0.1,

  /**
   * How fast the per-player limb-length estimate is allowed to shrink back,
   * in torso units per second. The estimate tracks the maximum projected
   * limb length seen; this slow decay lets one noisy over-long frame wash
   * out instead of permanently inflating the reference and suppressing all
   * subsequent depth recovery.
   */
  limbLengthDecayPerSec: 0.05,

  /** Sanity bounds on that estimate, torso units - rejects absurd outliers
   * from a badly-tracked frame. */
  limbLengthMin: 0.3,
  limbLengthMax: 1.1,

  /**
   * How long the "neutral" body position takes to follow the player, seconds.
   * Deliberately long: it must absorb the player repositioning in the room,
   * without erasing a held slip or crouch - which is exactly what a short
   * constant would do, by treating the dodge as the new neutral.
   */
  neutralFollowTau: 8,

  /**
   * Head turn. `measureHeadSignals` returns a ratio in roughly [-1, 1] - the
   * nose's position between the two ears - so the gain converts that ratio to
   * radians. 1.2 rad (~69 degrees) at full deflection is a deliberate
   * over-read: the raw ratio rarely reaches +-1 in practice because the far
   * ear stops being tracked well before the head is fully turned, so a gain
   * of "exactly right at the extremes" reads as barely moving in the middle.
   * The clamp is what stops the over-read becoming a broken neck.
   */
  headYawGain: 1.2,
  headYawMax: (70 * Math.PI) / 180,

  /**
   * Head nod. Input is the nose's offset from the ear line in torso units,
   * relative to a learned per-person neutral. A deep chin-tuck moves it by
   * roughly 0.1 torso units, so this gain puts that near the clamp.
   */
  headPitchGain: 4.0,
  headPitchMax: (35 * Math.PI) / 180,

  /** Whole-body travel, as a multiple of the measured offset. 1.0 is
   * one-to-one with the player. */
  rootGain: 1.0,

  /** Maximum whole-body travel from neutral, in torso units, so a tracking
   * glitch can't throw the character out of frame. */
  rootClamp: 0.6,

  /** Shoulder-to-hip length of the exported rig, in world units. Converts
   * torso-normalized offsets into scene units. Measured from the asset:
   * c_spine0 at y 0.944, shoulder line at y 1.419. */
  rigTorsoWorldLength: 0.475,

  /**
   * World height of the rig's belt line (the hip line), measured from the same
   * asset: c_spine0 sits at y 0.944 with the figure's feet on y 0.
   */
  rigHipWorldHeight: 0.944,


  /**
   * Gain on the depth channel - how much a measured step in or out moves the
   * character.
   */
  depthGain: 0.55,

  /** Gain on torso yaw. Well under 1, deliberately. */
  turnGain: 0.45,

  // --- Steady body (fights) ----------------------------------------------
  //
  // In a fight the figure ignores the small movements the camera picks up
  // between punches - weight shifts, breathing, landmark jitter - which made
  // it sway and rock. Real slips and ducks still move it. See
  // RigDriver.steadyBody.

  /** Sideways travel under this many torso units is ignored, and bigger
   *  travel is reduced by it. A slip registers at FIGHT_CONFIG.slipEnter
   *  (0.22), so a real slip still clearly moves the body. */
  steadyLateralDeadzone: 0.07,
  /** Same, for rising up (the downward half is the duck, untouched). */
  steadyVerticalDeadzone: 0.07,
  /** Torso twist under this, radians (~7 degrees), doesn't turn the body. */
  steadyTurnDeadzone: 0.12,
  /** How much of the remaining twist turns the whole figure, in place of
   *  turnGain. Every punch twists the torso, and at 0.45 the whole body
   *  swung round with each one. */
  steadyTurnGain: 0.2,
  /** Scale on the hurt wobble (KNOCKDOWN_ANIM.wobble). */
  steadyWobbleScale: 0.5,
  /**
   * Fastest any bone may turn on screen, radians per second (~900 deg/s).
   * A fast straight turns the forearm about 90 degrees in 100-150ms, so real
   * punches are under this; a landmark that teleports for one frame would
   * otherwise snap the arm across the screen and back.
   */
  steadyMaxBoneSpeed: (900 * Math.PI) / 180,
  /**
   * Elbow and wrist landmarks below this confidence are treated as missing in
   * a fight: the arm holds its last good position (then eases to the guard)
   * instead of following a blurred or off-screen guess.
   */
  steadyArmConfidence: 0.65,
};

/** `v` with a dead band of `dz` around zero: smaller values become 0 and
 *  larger ones are reduced by `dz`, so there is no jump at the edge. */
export function deadzone(v: number, dz: number): number {
  const m = Math.abs(v) - dz;
  return m > 0 ? Math.sign(v) * m : 0;
}

export const DEBUG_CONFIG = {
  /** Minimum landmark confidence before a point/bone is drawn in the overlay. */
  minDrawConfidence: 0.3,
  /** Rolling window of per-frame samples used for the FPS/latency statistics. */
  perfWindowSize: 600,
};

/** Training-mode strike resolution - see perception/strikeResolver.ts. */
export const STRIKE_CONFIG = {
  /**
   * Reach a fist must achieve to land, in torso units, measured from its own
   * shoulder and including recovered out-of-plane extension. Roughly "arm
   * most of the way out" - a guard position sits near 0.45, a committed
   * straight punch well past 1.0.
   */
  reachThreshold: 0.95,

  /**
   * How far the glove's striking surface sits beyond the wrist, in torso
   * units. 0.3409 torso = 0.17561 rig units against a 0.51518 torso.
   */
  gloveNoseReach: 0.3409,
  /** The same measure for a bare fist, kept for the gloves-off case and so the
   *  two can be compared in a test rather than conflated. */
  bareFistReach: 0.2913,

  /**
   * Starting estimate of each arm segment's length, torso units - the same
   * anthropometric figures the rig's limb calibration seeds from
   * (LIMB_TORSO_LENGTH). Only ever grows from observation.
   */
  seedArmSpan: { upper: 0.54, lower: 0.57 },

  /**
   * How much the out-of-plane (foreshortening) component counts toward reach,
   * relative to on-screen distance. Below 1 on purpose: foreshortening is the
   * noisier of the two signals, since it degrades exactly when the arm points
   * down the camera axis, so it contributes real credit for a punch thrown at
   * the lens without being able to trigger one on its own.
   */
  depthReachWeight: 0.8,

  /**
   * Fist speed floor, torso-widths per second. Stops a slow reach forward -
   * adjusting your guard, scratching your nose - registering as a punch.
   */
  minStrikeSpeed: 1.4,

  /**
   * How much the fist's out-of-plane speed counts toward the speed gate,
   * relative to its on-screen speed.
   */
  depthSpeedWeight: 0.5,

  /** Span the fist's speed is measured over, ms. */
  speedWindowMs: 120,

  /**
   * Consecutive samples a longer arm-segment reading must hold before it may
   * raise that arm's learned full length.
   */
  spanConfirmFrames: 3,
  /** Ceiling on a learned segment length, as a multiple of its anthropometric
   *  seed. Generous - real arms vary - but finite, so a sustained tracking
   *  fault cannot make the reference arbitrarily long. */
  spanMaxGrowth: 1.5,

  /**
   * Pose samples a strike may wait after crossing the threshold for the fist
   * to reach its peak, before it resolves anyway. 0 resolves on the crossing.
   */
  peakLatchSamples: 1,

  /** Minimum gap between strikes from the same hand, ms. A fast double jab is
   * around 250ms, so this must stay below that or it eats real punches. */
  refractoryMs: 180,

  /** Fraction of the threshold the fist must fall back below before that hand
   * can strike again. Hysteresis - without it, noise at the boundary fires
   * repeatedly from one held extension. */
  releaseFraction: 0.82,

  /** Reach past the threshold, in torso units, that counts as full power. */
  powerRange: 0.45,
  /** Power credited to a punch that only just lands. */
  basePower: 0.35,

  // --- Wii-style rules: what counts as a punch at all ----------------------
  //
  // A punch is a quick thrust that starts from the guard. Swinging or waving
  // the arms around stretches them past the reach threshold just as a punch
  // does, and used to count; these two gates are what tell them apart.

  /**
   * Lowest fist height, in torso units above the hips (shoulders = 1.0), that
   * counts as being in the guard. A hand only arms for a punch once it has
   * been back in the guard - up at about chest height or above, and pulled in
   * (reach under `releaseFraction` of the threshold). Arms swinging at the
   * sides, or already out from the last swing, never arm.
   */
  guardMinHeight: 0.5,
  /**
   * Longest time from the fist leaving the guard to crossing the reach
   * threshold, ms. A punch gets there in roughly 150-300ms; a slow reach,
   * or an arm wandering out and around, takes longer and doesn't count.
   */
  maxThrustMs: 450,
  /**
   * How much one direction of travel has to beat the others to decide the
   * punch type (see punchKindOf): up for an uppercut, sideways for a hook,
   * otherwise a straight.
   */
  kindDominance: 1.15,

  // --- Motion punches -------------------------------------------------------
  //
  // A punch also lands as a fast push of the fist away from the shoulder,
  // whether or not the arm gets to full measured extension. A single frontal
  // camera often can't see how far an arm thrown at it has extended, so
  // waiting for the reach threshold alone missed real punches at random.

  /** Fist speed, torso-widths per second, a push has to reach. Real punches
   *  peak at ~4-8 in the synthetic runs (hitRegistration.test.ts). */
  motionPunchSpeed: 2.0,
  /**
   * How much further out than the player's own guard the fist has to get,
   * torso units. From a typical guard the fixed reach threshold needs ~0.4;
   * this is a quarter less. Measured: a guard adjustment peaks at 0.20 and
   * a still guard at 0, against 0.4-1.0 for real punches, at 19 and 30 FPS
   * in steady and poor light.
   */
  motionPushGain: 0.3,
  /** After a punch, how far the fist has to come back (torso units below
   *  the furthest it got) before that hand can punch again. One push, one
   *  punch. */
  rearmDrop: 0.12,
  /** Speed above motionPunchSpeed, torso-widths per second, that counts as
   *  full power. */
  motionPowerRange: 4,

  /** How far below the shoulder line still counts as a head shot, torso units. */
  headBandBelowShoulders: 0.08,

  /** Half-width of the centre lane, torso units. Outside it, a strike is
   * classed as arriving from the player's left or right. */
  laneHalfWidth: 0.22,

  /**
   * Fraction of a strike's travel that must be forward for it to read as a
   * straight punch rather than a hook or an uppercut. Descriptive only - this
   * drives a caption, never whether a hit lands. See strikeGeometry.ts on why
   * that separation is the point of the phase-2 rework.
   */
  straightDirectness: 0.6,

  /**
   * Damage multiplier for a rising strike to the chin or jaw specifically.
   * An upward blow rotates the head, which is the actual mechanism behind a
   * knockout; the same force driven straight in mostly pushes someone back.
   * Applied nowhere else, so this is not a blanket bonus for uppercuts.
   */
  risingChinBonus: 1.35,
} as const;

/**
 * Facial damage - swelling, cuts, bleeding, and the eyes themselves.
 * See render/damage/faceDamage.ts on why swelling is geometry and blood is not.
 */
export const FACE_CONFIG = {
  /** Swelling added per unit of absorbed power. Tuned so a clean hard shot is
   *  clearly visible but it takes a sustained beating to close an eye. */
  swellPerHit: 0.22,
  /** Absorbed power below which a punch swells but does not break skin. A
   *  jab tally should not turn a face into a horror prop. */
  bleedThreshold: 0.45,
  bleedPerHit: 0.5,
  /** Swelling a site needs before a cut can open there. Swollen skin splits;
   *  fresh skin absorbs - which is why cuts appear late in a fight. */
  cutSwellingRequired: 0.35,
  cutPerHit: 0.3,

  /** Seconds for swelling to fade completely. Long: swelling subsides over a
   *  fight, not over a round. */
  swellFadeSeconds: 90,
  /** Blood dries and gets wiped far faster than swelling goes down. */
  bleedFadeSeconds: 14,

  /** How much cheek swelling contributes to closing the eye above it. */
  cheekClosureShare: 0.45,

  /** Cheek/jaw swelling, as a bone-scale factor at full damage. */
  jawPuff: 0.14,

  /** Eye vertices are few, so their own UV spread underestimates the visible
   *  eye. Scaled up to cover the lid area a bruise should reach. */
  eyeRadiusScale: 2.4,
  /** Eye radius as a fraction of the jaw island's UV extent, used when the
   *  eye bones have no weighted vertices to measure from - which on this rig
   *  is always. An eye is roughly a sixth of the jaw footprint. */
  eyeRadiusOfJaw: 0.17,
  cutColour: "#7a1512",
  bloodColour: "#8e1410",

  bruiseAlphaGain: 0.85,
  bruiseMaxAlpha: 0.7,
  bloodAlphaGain: 1.1,
} as const;

/**
 * Region-of-interest cropping. See pose/roiCrop.ts - including the verified
 * reason the native `regionOfInterest` API cannot be used (PoseLandmarker
 * constructs its runner with roiAllowed=false and throws).
 */
export const ROI_CONFIG = {
  /** Side of the square canvas handed to the model, pixels. */
  tensorSize: 256,

  /** Confidence a landmark needs before it can widen the crop. Low-confidence
   *  landmarks are frequently hallucinated far from the body, and one of those
   *  would blow the window open and undo the entire zoom. */
  minConfidence: 0.55,
  /** Confident landmarks required before the crop is trusted at all. */
  minLandmarks: 8,

  /** Margin around the pose bounding box, as a fraction of its own size.
   *  Generous on x because a thrown punch puts a wrist well outside the body. */
  marginX: 0.42,
  marginY: 0.3,
  /** Extra headroom multiplier above the topmost landmark - the crop must
   *  contain the top of the head, which has no landmark of its own. */
  topBias: 1.7,

  /** Floor on the crop side, as a fraction of the frame's shorter edge. Stops
   *  the window collapsing onto a player who is far away or partly occluded. */
  minSideFraction: 0.35,

  /** Per-frame easing toward a bigger window. Fast: a player who has moved out
   *  of the box is producing bad data every frame until it catches up. */
  growRate: 0.55,
  /** Per-frame easing toward a smaller window. Slow, because contracting is
   *  never urgent and a visible zoom is worse than a slightly loose crop. */
  shrinkRate: 0.06,

  /** Window position/size is snapped to this many source pixels. A still
   *  player then gets a bit-identical crop each frame instead of sub-pixel
   *  resampling noise - which would be a new jitter source. */
  quantise: 8,

  /** Body-centre movement, as a fraction of the window side, past which the
   *  window's position follows at growRate instead of easing. */
  followDeadBand: 0.06,
  /** Each lost frame widens the window by this factor about its centre. */
  lostWiden: 1.45,
  /** Lost frames before the crop goes full-frame. */
  lostFramesBeforeReset: 4,

  /**
   * Longest side, px, the whole frame is scaled to before a crop has been
   * acquired, on the worker path. The detector that searches for a body runs
   * on a ~224px input, so a full 640x480 bitmap is mostly upload cost; the
   * main-thread path likewise letterboxes the frame into `tensorSize`.
   */
  searchSize: 320,
} as const;

/**
 * The crowd around the venue - see render/arena/crowd.ts. Silhouettes only:
 * unlit, no shadows, one instanced draw, fading into the hall's fog.
 */
export const CROWD_CONFIG = {
  rows: 7,
  /** Gap between the venue's edge and the first row, world units. */
  firstRowGap: 7.2,
  /** Row-to-row spacing outward, and the rise of each row. */
  rowDepth: 1.05,
  rowRise: 0.46,
  seatBase: 0.85,
  seatSpacing: 0.88,
  emptySeatChance: 0.16,
  /**
   * Brightness range of the silhouettes, linear 0-1, before fog. Linear is
   * the catch: through sRGB output and the arena's tone mapping, 0.16 came
   * out as a pale grey crowd of ghosts. These read as people in the dark.
   */
  shadeMin: 0.006,
  shadeMax: 0.024,
  flashPool: 24,
  flashSeconds: 0.18,
  /** Ambient camera flashes per second across the whole crowd. */
  flashesPerSecond: 2.6,
  /** Flashes fired at once on a knockdown. */
  burstFlashes: 5,
} as const;

/**
 * The framing coach: tells the player when the camera cannot see them well
 * enough to play, and what to do about it. See perception/framingCheck.ts.
 */
export const FRAMING_CONFIG = {
  /** Landmark confidence below which a body part counts as not seen. */
  minConfidence: 0.5,
  /**
   * Shoulder-to-hip length as a fraction of frame height. The game reads a
   * torso of ~0.3 (the synthetic fixtures, and the rendered fake player);
   * well below it every landmark is a few pixels and jitter dominates, well
   * above it a punch leaves the frame.
   */
  minTorso: 0.15,
  maxTorso: 0.48,
  /** How close to the bottom edge the hips may come, as a fraction. */
  edgeMargin: 0.03,
  /** Highest the nose may sit, as a fraction from the top. The crown is about
   *  a tenth of a frame above the nose at normal framing, so a nose higher
   *  than this means the head is already cut off. */
  minNoseY: 0.09,
  /** Shoulder midpoint outside [offCentre, 1 - offCentre] is off to one side. */
  offCentre: 0.22,
  /** Mean frame luma (0-255) below which the picture is too dark to track. */
  minLuma: 45,
  /** Outer-ring luma exceeding centre luma by this much reads as backlit -
   *  a window or lamp behind the player, which silhouettes them. */
  backlightMargin: 55,
  /** A problem must persist this long before it is shown, ms, so a passing
   *  stumble does not flash a prompt. */
  showAfterMs: 900,
  /** And the picture must be fine for this long before the prompt clears. */
  hideAfterMs: 700,
  /** How often the frame's brightness is sampled, ms. */
  lumaIntervalMs: 500,
} as const;

/**
 * The first-run walkthrough: stand where the camera can see you, put your
 * guard up, throw one with each hand. See onboarding/firstRun.ts.
 */
export const FIRST_RUN_CONFIG = {
  /** Well framed, head to hips and both hands in view, for this long, ms. */
  frameHoldMs: 800,
  /** A high guard (FIGHT_CONFIG.guardHighEnter) held this long, ms. */
  guardHoldMs: 600,
  /** localStorage key recording that the walkthrough was finished or skipped. */
  storageKey: "shadowbox.firstRun.v1",
} as const;

/**
 * Skeleton solver - the biomechanical constraints applied to raw landmarks.
 * See pose/skeletonSolver.ts for why a temporal filter cannot do this job.
 */
export const SKELETON_CONFIG = {
  /**
   * Physical speed ceiling for any landmark, in torso-spans per second.
   * A professional punch peaks near 9 m/s and a torso is about half a metre,
   * so 18 is already generous. Anything faster is the tracker jumping to a
   * different object, not a person moving.
   */
  maxSpeedTorsoPerSec: 18,

  /** Confidence a clamped landmark is demoted to, so downstream gates know
   *  the reading was not trusted rather than seeing a clean value. */
  rejectedConfidence: 0.35,

  /** Minimum confidence on both endpoints before a bone length is learned
   *  from a frame. Learning from guesses poisons the estimate permanently. */
  learnConfidence: 0.72,

  /** Observations kept per bone group for the running median. ~4 seconds at
   *  15 FPS: long enough to be robust, short enough to re-learn if the player
   *  changes distance or a different person steps in. */
  lengthWindow: 60,
  /** Samples needed before a learned length is trusted at all. */
  minSamples: 12,

  /**
   * A foreshortening limb only contributes to its learned length when it is
   * at least this fraction of the current estimate. A limb pointing at the
   * camera reads short, so feeding every sample to a median would learn a
   * length somewhere between "arm out" and "arm at the lens" - a length the
   * arm never actually has.
   */
  growThreshold: 0.97,

  /**
   * Time constant for a limb's slow-moving "current projected length",
   * seconds. This is the knob that separates foreshortening from noise.
   */
  currentLengthTau: 0.08,

  /**
   * Shortfall below full length that is treated as pure noise and corrected
   * away completely, as a fraction. Landmark noise shortens a limb by a few
   * percent; a punch at the camera shortens it by 30-75%. The magnitude of
   * the shortfall is therefore strong evidence about which is happening.
   */
  noiseBand: 0.1,

  /**
   * Width of the blend from "treat as noise" to "treat as real
   * foreshortening". A hard switch would pop visibly for a limb hovering at
   * the boundary, which is exactly what a jab at half extension does.
   */
  relaxBand: 0.18,

  /** Projection passes per frame. Same role as the cloth solver's iteration
   *  count: this is the stiffness, and it cannot diverge. */
  iterations: 3,
  /** Fraction of each length error corrected per pass. Below 1 so the solver
   *  eases toward the constraint instead of snapping, which would reintroduce
   *  exactly the per-frame discontinuity it exists to remove. */
  stiffness: 0.55,
} as const;

/**
 * Latency compensation. See pose/predictor.ts - this is the difference between
 * the character being where you were ~110 ms ago and being where you are.
 */
export const PREDICT_CONFIG = {
  /** How much of the measured pipeline latency to compensate for, 0-1. */
  strength: 0.75,

  /** Hard ceiling on how far ahead to extrapolate, seconds. Protects against
   *  a latency spike turning into a huge, visibly wrong lunge. */
  maxLeadSeconds: 0.12,

  /**
   * Velocity smoothing time constant, seconds. Velocity estimated from two
   * consecutive ~15 FPS samples is extremely noisy, and prediction multiplies
   * that noise directly, so the derivative is filtered harder than the
   * position ever is.
   */
  velocityTau: 0.09,

  /**
   * Speed below which no prediction happens at all, torso-spans per second.
   * A still hand has no velocity worth extrapolating, and predicting noise on
   * a stationary limb is precisely the jitter everything else is trying to
   * remove.
   */
  deadband: 0.35,

  /** Confidence below which a landmark is not predicted. Extrapolating a
   *  guess just produces a more confident guess. */
  minConfidence: 0.5,
} as const;

/** The fight itself: health, guard, knockdowns, rounds, scoring. */
export const FIGHT_CONFIG = {
  /** Stamina drained by starting an evasion. A fight rule, not a CPU one - it
   *  applies to whoever is evading, and the player's own tracked dodges will
   *  be charged the same. Small, but it means a fighter who slips everything
   *  gasses out, which is why blocking and slipping are different choices
   *  rather than one strictly better one. */
  evadeStaminaCost: 1.6,

  /** When the player's own body movement counts as a committed evasion. */
  duckEnter: 0.45,
  duckExit: 0.3,
  /** Lateral travel, torso units, that counts as a slip. */
  slipEnter: 0.22,
  slipExit: 0.14,

  /**
   * Where the player's hands have to be for a guard, as mean wrist height
   * above the belt in torso units - 1.0 is the shoulder line.
   */
  guardHighEnter: 0.95,
  guardHighExit: 0.82,
  guardLowEnter: 0.5,
  guardLowExit: 0.38,

  /**
   * Fraction of damage that gets through a correct guard. Not zero: a blocked
   * heavy shot still moves you, still stings the arms, and a guard that
   * nullified everything would make the correct strategy "never lower it".
   */
  blockedDamage: 0.18,

  /** Stamina the blocker spends per point of damage absorbed. The other half
   *  of why a permanent high guard is not a winning strategy. */
  blockStaminaCost: 0.9,

  /**
   * Furthest back, ms, a player's strike is judged against the opponent's
   * defence as it was when the punch was thrown, rather than as it is when
   * the strike reaches the fight loop.
   */
  maxRewindMs: 150,

  /** Seconds of stun per point of unblocked damage. */
  stunSecondsPerDamage: 0.03,

  /** Seconds a fighter is out of it after being dropped. */
  knockdownSeconds: 2.4,

  /** Health a fighter rises with after their first knockdown. */
  riseHealth: 46,
  /** Multiplier applied per subsequent knockdown, so a fighter dropped twice
   *  comes back visibly worse than one dropped once. */
  riseDecay: 0.62,

  /** Knockdowns in one round that end it. The standard three-knockdown rule. */
  threeKnockdownRule: 3,

  /** Points lost for a low blow. */
  foulDeduction: 1,

  /** Rest between rounds, seconds. */
  betweenRoundSeconds: 60,
  /** Multiplier on stamina recovery while resting in the corner. */
  cornerRecoveryRate: 2.6,
  /** Health recovered per second of rest. */
  cornerHealthPerSecond: 0.35,

  /**
   * Damage-share difference below which a round with no knockdowns is scored
   * even, 10-10. Real judges avoid even rounds, but a simulation that invents
   * a winner from a fraction of a percent is producing noise and calling it a
   * decision.
   */
  evenRoundMargin: 0.08,

  /** Floor on a single round's score. */
  minRoundScore: 6,
} as const;

/**
 * The camera director. Named DIRECTOR_CONFIG rather than CAMERA_CONFIG because
 * that name is already taken above by the webcam's capture settings, and two
 * different "cameras" in one config file is how a wrong-constant bug starts.
 */
/** Going down, and being hurt. */
export const KNOCKDOWN_ANIM = {
  /** How far the body pitches over, radians. Short of flat: the sim stands the
   *  fighter back up after `knockdownSeconds`, so this is a fighter going down
   *  on one hip and getting up, not a fighter laid out. */
  fallAngle: (74 * Math.PI) / 180,
  /** Seconds to go over. */
  fallSeconds: 0.48,
  /**
   * The knockdown plays in slow motion for this long, seconds, at this
   * playback rate, while the director cuts to it. Long enough to see the
   * punch land and the legs go; short enough to be back at full speed before
   * the count matters. Render time only - see TimeWarp.
   */
  slowMotionSeconds: 1.1,
  slowMotionRate: 0.3,
  /** Seconds to get back up. Much slower than going down, which is the whole
   *  difference between being knocked down and lying down. */
  riseSeconds: 0.95,
  /** Extra knee fold while down, on top of the standing bend. A fighter going
   *  over with straight legs reads as a falling plank. */
  hipFold: 0.6,

  /** Sway amplitude at full hurt, radians, and its rate. A stunned fighter
   *  that stood perfectly still was indistinguishable from a fresh one - the
   *  `stunned` timer drove the rules and nothing else. */
  wobble: (5.5 * Math.PI) / 180,
  wobbleHz: 1.35,
  /** How far the guard sags at full hurt, 0-1 toward hands-down. This is the
   *  visible half of a rule that already exists: the sim refuses a guard from
   *  a stunned fighter, so the hands should already be down. */
  guardSag: 0.8,
} as const;

export const DIRECTOR_CONFIG = {
  /** Distance from the fighters as a multiple of the cage radius. */
  broadcastDistance: 1.25,
  tightDistance: 0.55,
  /** Camera height for the default shot, metres above the canvas. */
  broadcastHeight: 2.35,
  /** How far up the fighters the camera aims. Chest height reads better than
   *  the head - aiming at heads puts the floor in half the frame. */
  aimHeight: 1.15,
  /** Knee height, which is what makes a downed fighter read as downed. */
  lowAngleHeight: 0.55,
  /** How far back the knockdown shot sits, world units. */
  lowAngleDistance: 3.1,
  /** How far above the canvas the knockdown shot aims. Low, because a fighter
   *  on the canvas is a metre below where they were standing and an aim at
   *  chest height looks straight over the top of them. */
  lowAngleAim: 0.62,

  /** Hold times, seconds, before returning to the broadcast shot. */
  knockdownHold: 3.4,
  tightHold: 2.2,
  cornerHold: 4,
  overheadHold: 2.6,

  /** Easing rates, per second. Higher is snappier. The fast one is for cuts
   *  that should feel like cuts; the slow one for drift that should not be
   *  noticed at all. */
  fastEase: 7,
  slowEase: 1.8,

  /**
   * How close to the house shot the eased pose must get before the renderer
   * takes its own camera back, world units.
   */
  handBack: 0.04,
} as const;

/**
 * The CPU opponent. Per-difficulty numbers live in cpuOpponent.ts's profile
 * table, because they only make sense as a set; these are the shared ones.
 */
/**
 * How the CPU opponent's body is drawn. Purely cosmetic - the CPU's decisions
 * and the fight's rules are both upstream of everything here, and nothing in
 * this block can change whether a punch lands.
 */
export const OPPONENT_ANIM = {
  /** Seconds from release to the arm being back on guard. */
  punchSeconds: 0.34,
  /** Share of that spent going out. Out fast, back slow: the recovery is the
   *  half that leaves you open, and a symmetric animation reads as a piston. */
  punchOutShare: 0.35,
  /** Time constant the arms chase their target pose with. Short - an arm that
   *  lags its own telegraph is a telegraph the player cannot trust. */
  armTau: 0.045,
  /** Maximum change in arm extension per second. Bounds how fast a glove can
   *  cross the space between the fighters, whatever the state machine or the
   *  frame rate does. 9/s puts a full guard-to-extended swing at no less than
   *  ~110ms, which is about as fast as a human arm actually is. */
  maxExtendRate: 9,

  /** How far a punch's line tilts between a body shot and a head shot. Applied
   *  to the extended arm's vertical component, so the CPU's chosen target
   *  height is visible in the punch instead of only in the damage feed. */
  aimRise: 0.45,

  /** Torso-to-world scale used only if the rig is missing the bones it is
   *  measured from - a figure in that state is already broken, and this just
   *  keeps it on the stage while that is diagnosed. */
  fallbackTorsoWorld: 0.475,

  /** How far a punch swings across the body toward its target's lateral
   *  offset. The CPU already aims at a named point - liver, temple, ribs - and
   *  the arm used to leave along the centre line whatever it picked, so a dig
   *  to the liver and a shot at the chin were the same animation. */
  aimCross: 0.5,

  /** The lateral offset, in torso units, that counts as a full swing across.
   *  The CPU's widest named target (the temple) sits at 0.28, so this is set
   *  just above it: the extremes of its aim reach most of the way across and
   *  nothing clips. */
  aimFullLateral: 0.3,
} as const;

/** Footwork: how the feet hold the canvas and how they step off it. */
export const FOOTWORK_CONFIG = {
  /** Half the lateral gap between the feet. A boxer stands about shoulder
   *  width, and the shoulders are roughly one torso unit across. */
  stanceWidth: 0.34,
  /** How far the lead foot sits forward of centre, and the rear foot behind.
   *  This is the stagger that makes a stance a stance rather than a standing
   *  position. */
  stanceStagger: 0.3,
  /** The lead foot sits slightly narrower than the rear, as a fraction of
   *  `stanceWidth` - the rear foot carries the weight and takes the wider base. */
  leadWidthShare: 0.78,

  /** How far a foot may be dragged from where it ought to be before it picks
   *  itself up. Too small and the feet patter constantly; too large and the
   *  fighter does the splits before stepping. */
  stepTrigger: 0.26,
  /** The lower bar applied to the trailing foot once the other one has moved. */
  settleTrigger: 0.07,
  /** The furthest a planted foot may be dragged from where it wants to be. */
  maxStretch: 0.3,
  /** Seconds a single step takes, lift to land. Boxing steps are fast. */
  stepSeconds: 0.17,
  /** Peak height of a step, torso units. Deliberately tiny: a boxer shuffles
   *  and skims the canvas, and a foot that lifts like a walk reads as marching
   *  around the ring. */
  stepHeight: 0.045,

  /** Knee bend held at all times, as a fraction of a full crouch. */
  standingBend: 0.4,
} as const;

export const CPU_CONFIG = {
  /** Fraction of the normal tempo used to press a stunned opponent. Below 1 =
   *  faster. The window after a knockdown is where fights are finished. */
  stunnedUrgency: 0.35,

  /** Stamina fraction below which the CPU stops throwing and covers up. This is
   *  what makes draining the opponent a real strategy rather than a stat that
   *  ticks down cosmetically. */
  exhaustedFraction: 0.18,

  /** Multiplier on the pause after being hurt, before resuming. */
  resetAfterHurt: 1.4,

  /** Power multiplier applied per punch deeper into a combination. The last
   *  punch of a five-piece is an arm punch, not a knockout blow. */
  comboPowerDecay: 0.88,

  /** Random spread added to the CPU's aim, torso units. Stops repeated punches
   *  stacking on one pixel, and spreads bruising the way a real face bruises. */
  aimJitter: 0.09,

  // Footwork

  // Ranges live in FIGHT_GEOMETRY, not here. They are derived from where the
  // fighters actually stand, and a copy in this block would be free to drift
  // away from the scene - which it did: the CPU was told the gap was 1.0 torso
  // units while the figures stood 1.66 apart, so it believed itself in range
  // from across the ring.

  /** Torso units per second of footwork travel, before the difficulty's own
   *  `footSpeed` multiplier. */
  stepSpeed: 1.15,

  /** How far the CPU will circle off the centre line before turning around. */
  lateralLimit: 0.85,

  /** How far in and out of the pocket the CPU will travel, torso units. Bounds
   *  the depth channel for the same reason `lateralLimit` bounds the lateral
   *  one: an unbounded integrator walks off the stage. */
  depthLimit: 1.4,

  /** Share of head movements that are a duck rather than a slip. Ducking is
   *  the stronger answer and the slower recovery, so it is the minority
   *  choice. */
  duckShare: 0.3,

  /** Seconds a footwork choice is held before it is reconsidered. Without a
   *  minimum the CPU reverses direction every tick and vibrates on the spot. */
  footworkMin: 0.45,
  footworkMax: 1.6,

  /** Seconds a slip or duck is committed for. Long enough to be visible and to
   *  be a real decision; short enough that it cannot be held as a permanent
   *  invulnerability. */
  evadeSeconds: 0.42,

  /** Seconds after an evasion before another can start. Without this the CPU
   *  re-slips the instant the window closes and is never hittable. */
  evadeCooldown: 0.5,

  /** Torso units a slip moves the head off the centre line, and radians of
   *  lean that goes with it. Rendered, not simulated: whether a slip works is
   *  decided by the rule in fightState, not by these numbers. */
  slipTravel: 0.42,
  slipLean: 0.3,

  /** Crouch fraction of a duck. */
  duckDepth: 0.72,

  /** Time constant the shown stance chases the commanded one with. Footwork is
   *  a body moving, not a value jumping. */
  stanceTau: 0.11,
} as const;

/**
 * Training target (the second mesh) - how it reacts to being hit.
 * Purely cosmetic: damage state lives in the resolver above, the appearance of
 * it lives in the render layer. See risk log 13's layering rule.
 */
export const TARGET_CONFIG = {
  /**
   * Where the target stands relative to the player's boxer, world units. The
   * player's character faces +Z, so the target sits in front of it.
   */
  distance: 0.788,

  /** Peak head rotation from a full-power head shot, radians. */
  headSnap: (28 * Math.PI) / 180,
  /** Peak torso rotation from a full-power body shot, radians. */
  bodyFold: (14 * Math.PI) / 180,
  /** Jaw drop at full power, radians - bone-driven, no blendshapes needed. */
  jawDrop: (12 * Math.PI) / 180,
  /** How far the whole body is knocked back at full power, world units. */
  knockback: 0.1,

  /** Time constant for the reaction decaying back to neutral, seconds. */
  recoverTau: 0.22,
  /** Time constant for the reaction building up, seconds. Much shorter than
   * recovery: an impact is sudden, the recovery from it is not. */
  impactTau: 0.035,

  /**
   * How much of that reaction the player's own figure takes when the opponent
   * lands on them.
   */
  playerReactionShare: 0.55,
} as const;

/** Where the two fighters stand, in the units the simulation thinks in. */
const NEUTRAL_RANGE = TARGET_CONFIG.distance / RENDER_CONFIG.rigTorsoWorldLength;

export const FIGHT_GEOMETRY = {
  /** The gap when neither fighter has moved, torso units. The zero point both
   *  depth channels are subtracted from. */
  neutralRange: NEUTRAL_RANGE,

  /** The gap at which a committed punch reaches, torso units. */
  strikingRange: NEUTRAL_RANGE,

  /** The gap a fighter tries to hold while not attacking. */
  preferredRange: NEUTRAL_RANGE * 1.22,

  /**
   * Inside this the fighters are on top of each other. Nobody fights from
   * inside their own guard, so the CPU backs out - and the CPU's body may not
   * come closer than this at all (see the ceiling in cpuOpponent.ts).
   */
  clinchRange: NEUTRAL_RANGE * 0.9,

  /** The closest the CPU's body may stand, whatever either fighter does. */
  contactRange: NEUTRAL_RANGE * 0.96,
} as const;

/** Fist clench - see render/retargeting/handRig.ts. */
export const HAND_CONFIG = {
  /** Clench held at all times. A boxer's hands are never open, and the mesh's
   * relaxed bind pose reads as wrong the moment it is seen in context. */
  guardClench: 0.82,
  /** Clench at full extension - the fist tightens as the punch lands. */
  strikeClench: 1.0,
  /** Extension, as a fraction of the strike threshold, at which tightening
   * begins. Below this the hand sits at its guard clench. */
  tightenFrom: 0.55,
  /** Smoothing time constant for clench, seconds. Fast - a fist closing
   * visibly slowly looks like hesitation, not a punch. */
  tau: 0.05,

  /** How much a forearm pointing at the camera counts toward extension. A
   * straight punch down the lens barely moves the wrist on screen, so without
   * this the fist would never tighten on the most committed punch there is. */
  depthWeight: 0.45,
} as const;

/** Character texturing and visible damage - see render/texturing/. */
export const TEXTURE_CONFIG = {
  /**
   * Texture resolution. 1024 is the sweet spot here: the head occupies a clean
   * quarter of the square (u 0-0.5, v 0-0.45), so a facial bruise still gets
   * ~200px across, while the whole sheet costs ~4MB of VRAM per character on a
   * GPU that is already running pose inference.
   */
  size: 1024,

  /** One grain speck per this many pixels, and how strongly it shows. Keeps
   * skin from reading as flat plastic under a single directional light. */
  grainDensity: 900,
  grainAlpha: 0.05,

  // --- Damage ---

  /** Bruise radius as a fraction of the texture's width, at half strength. */
  bruiseRadius: 0.05,
  /** Peak opacity of a full-power bruise. Below 1 so repeated hits build up
   * rather than saturating on the first one. */
  bruiseAlpha: 0.72,
  /** Random offset applied to each mark, in UV units, so a combination to one
   * zone reads as several impacts instead of one darkening dot. */
  bruiseJitter: 0.022,
  /** Seconds for a bruise to go from fresh red to set purple. */
  bruiseSetSeconds: 2.5,
  /** Seconds before a bruise has faded away entirely. */
  bruiseLifeSeconds: 22,
  /** Colour progression. Real bruising darkens and cools as it sets, which
   * doubles as a readable signal of which hits are recent. */
  bruiseFresh: "#b8332b",
  bruiseSet: "#5b2a52",
  /** Hard cap on simultaneous marks, so a long session cannot grow the repaint
   * cost without bound. */
  maxBruises: 26,
  /** Seconds between damage repaints. Bruises fade over many seconds, so
   * repainting per frame would cost a canvas blit 60 times a second to show a
   * change nobody can perceive. */
  repaintInterval: 0.2,
} as const;

/** Skin tones. The two differ slightly so the figures read apart at a glance. */
export const KIT = {
  /** Per-fighter kit colour. */
  player: {
    skin: "#b98a6a",
    hair: "#30211e",
    glove: "#9d1f24",
    trunks: "#8c1520",
    boots: "#6f1119",
  },
  target: {
    skin: "#a97a5c",
    hair: "#211c1b",
    glove: "#1e3a6b",
    trunks: "#172b52",
    boots: "#121c3f",
  },
} as const;

/** Which kit colour each generated mesh takes, by its name in the GLB. */
export const KIT_MESH_COLOUR: Record<string, "glove" | "trunks" | "boots"> = {
  glove_L: "glove",
  glove_R: "glove",
  shorts: "trunks",
  shoe_L: "boots",
  shoe_R: "boots",
};

/** Surface roughness per kit type. Leather is far glossier than cloth, and
 *  that difference is most of what separates them visually at distance. */
export const KIT_ROUGHNESS: Record<"glove" | "trunks" | "boots", number> = {
  glove: 0.42,
  trunks: 0.78,
  boots: 0.45,
};

/** Tracking watchdog (pose/trackingMonitor.ts). */
export const MONITOR_CONFIG = {
  /** Landmark confidence below which a reading counts as a dropout. */
  minConfidence: 0.5,
  /** Rolling window length, frames. At ~15 Hz this is about 6 seconds --
   *  long enough to average out a stumble, short enough to notice the light
   *  changing. */
  windowFrames: 90,
  /** Below this many frames the window is not worth reporting on. */
  minSamples: 12,
  /** Metric score below which the report speaks up. Advice keys off the score
   *  rather than off each metric's "bad" line, so a metric sitting at 0.36
   *  cannot score poorly while reporting nothing -- which is exactly what a
   *  15 Hz pose rate did: mediocre, above the bad threshold, and silent. */
  warnScore: 0.5,

  /** Pose rate, Hz. The ceiling here is 1/inference, not the camera. */
  goodHz: 24,
  badHz: 10,

  /** Fraction of landmark readings unusable. */
  goodDropout: 0.02,
  badDropout: 0.2,

  /** Per-frame positional noise, torso units, as a second difference. */
  goodJitter: 0.004,
  badJitter: 0.03,

  /** Limb-length spread as a fraction of the limb. The skeleton solver got
   *  this to 0.280 from 0.549 by constraining bone lengths; anything much
   *  above that means the constraint is not holding. */
  goodLimbVariance: 0.05,
  badLimbVariance: 0.3,

  /** Bounds on what the auto-tuner may do. Narrow on purpose: it runs
   *  unattended, so its worst case must be "slightly soft" or "slightly
   *  laggy", never "broken". */
  minSmoothingScale: 0.7,
  /** Was 2.5. At 2.5 a noisy home webcam pushed the character filter to the
   *  point where a punch reached 90% on screen ~0.8 s late. 1.3 still lets a
   *  noisy signal be calmed, but can't make the arm lag behind the player. */
  maxSmoothingScale: 1.3,
  minPredictScale: 0.25,
  maxPredictScale: 1.0,
} as const;

/**
 * The system monitor aggregates tracking, frame timing, strike resolution and
 * drill health into one report - see diag/systemMonitor.ts.
 */
export const SYSTEM_CONFIG = {
  /** Window over which strike activity is measured, ms. Kept short: training
   *  pace can change in a few seconds, and a window measured in minutes would
   *  still be reporting a rest break as normal throughput. */
  strikeWindowMs: 10_000,

  /** Reach counts as a "near miss" above this - close enough to a landed
   *  strike that repeated near-misses without a landed strike are a
   *  calibration question, not a player who simply isn't punching. */
  nearMissReach: 0.85,
  /** How many near-misses inside the window, with nothing landed, before the
   *  report says so. One or two near misses is normal circling; a stack of
   *  them with zero landed strikes is the pattern worth naming. */
  nearMissAdviceCount: 6,

  /** Frame delivery rate, Hz, good/bad - same shape as MONITOR_CONFIG's pose
   *  thresholds, applied to the render loop's own delivered-pose interval
   *  rather than the tracker's internal one, so a render-side stall shows up
   *  even when pose sampling itself is healthy. */
  goodFrameHz: 24,
  badFrameHz: 10,
} as const;

// Dummy training
export const TRAINING_CONFIG = {
  /** How long a lit target stays live before it counts as missed. */
  windowMs: 1800,
  /** Gap between one target clearing and the next lighting. */
  restMs: 420,
  /** Reaction at or under this scores full marks for timing. */
  perfectMs: 420,
  /** Reaction at or over this scores zero for timing. */
  slowMs: 1500,
  /** Targets in a standard round. */
  targetsPerRound: 12,

  /** Weights of the three components in the combined score. Must sum to 1. */
  weight: { accuracy: 0.5, timing: 0.25, power: 0.25 },

  /**
   * A strike whose `power` is at or above this counts as fully committed.
   * Below it, the punch scores proportionally - a flicked arm that technically
   * crosses the reach threshold should not score like a thrown punch.
   */
  fullPowerAt: 0.55,

  /** Rounds a zone must be trained before its statistics are trusted. */
  minZoneSamples: 6,
} as const;

// Adaptation
export const ADAPT_CONFIG = {
  /** Total scored strikes before any correction is applied at all. */
  minSamples: 24,
  /**
   * Distinct zones that must have contributed. This is the guard that stops a
   * player from teaching the system an offset by hammering one target: a bias
   * seen on one zone is that player's technique on that shot, and a bias seen
   * across the whole dummy is the camera.
   */
  minDistinctZones: 4,
  /** Largest correction that may ever be applied, torso units, per axis. */
  maxCorrection: 0.22,
  /** Fraction of the observed bias actually applied. Under-correcting on
   *  purpose: the estimate is noisy and an overshoot oscillates. */
  gain: 0.6,
  /** How much a zone's weakness raises its odds of being drilled again. */
  weaknessBias: 2.5,
} as const;

// Camera pointer - driving the menu with your hands.
export const POINTER_CONFIG = {
  /** Landmark confidence a wrist needs before it may drive the cursor. */
  minConfidence: 0.5,

  /**
   * Half-width of the hand's reach box, in torso units, mapped to half the
   * screen. 0.9 means a hand one torso-length out from the shoulder midline
   * reaches the edge - about the span of a relaxed arm, so the far corners are
   * reachable without leaning.
   */
  reachX: 0.9,
  reachY: 0.72,
  /**
   * Vertical offset of the cursor's rest position, torso units below the
   * shoulder line. A hand at a natural guard height sits above the shoulder
   * midpoint in image terms, and without this offset the cursor's neutral
   * would be off the top of the screen.
   */
  restY: 0.1,

  /** Cursor smoothing, 0..1 per frame. Hand landmarks are the noisiest set. */
  smoothing: 0.35,

  /** How long the hand must dwell on a target to confirm it. */
  dwellMs: 900,
  /** Grace period on arrival before dwell begins accumulating at all. */
  settleMs: 180,
  /**
   * How far the cursor may drift during a dwell, in normalised screen units,
   * before the dwell restarts. Roughly a third of a menu row - tight enough to
   * reject a hand travelling through, loose enough to tolerate the jitter of a
   * 15 Hz pose stream.
   */
  steadyRadius: 0.035,
} as const;

// Whole-body motion - see perception/bodyMotion.ts.
export const BODY_CONFIG = {
  /**
   * Assumed camera distance, in torso units. The one honest assumption in the
   * depth channel.
   */
  cameraDistance: 4.0,

  /**
   * The camera's principal point, in normalised image coordinates - the point
   * the image magnifies about as the subject moves nearer or further.
   */
  principalX: 0.5,
  principalY: 0.5,

  /** Maximum lateral/vertical travel from neutral, torso units. */
  travelClamp: 0.7,
  /** Maximum step in or out, torso units. */
  depthClamp: 0.8,

  /** Torso yaw below this is treated as zero, radians (~7 degrees). */
  turnDeadZone: 0.12,
  /** Maximum torso yaw, radians (~50 degrees). A bladed stance, not a pirouette. */
  turnClamp: 0.88,

  /** Vertical drop that counts as a full crouch, torso units. */
  fullCrouch: 0.34,

  /** Neutral drift time constant, seconds. Long: a held crouch must stay one. */
  neutralTau: 9,

  /**
   * The neutral holds still while the body is clearly away from it - stepped
   * in, slipped, ducked - for up to `seconds`, then drifts as normal.
   */
  driftHold: { depth: 0.2, lateral: 0.15, crouch: 0.25, seconds: 2.5 },
} as const;
