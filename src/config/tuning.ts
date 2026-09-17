// Every tunable constant in the game. Thresholds and game feel are adjusted
// here, never at a call site.

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
   * Inference in a Web Worker. OFF: measured at 13.8 vs 15.1 FPS, and it cannot
   * load under the dev server (MediaPipe needs a classic worker). `?worker=1`
   * against a production build re-runs the comparison on other hardware.
   */
  get useWorker() {
    return queryFlag("worker", false);
  },

  /** Crop to the player before inference — the largest accuracy win, and a
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
   * Re-arm the video-frame callback BEFORE running inference rather than
   * after. This is the single change that unpins the pose rate from the
   * camera's frame grid — see usePoseTracking's detect(). Flagged only so the
   * old behaviour can be measured against it; there is no reason to turn it
   * off otherwise.
   */
  get pipelineFrames() {
    return queryFlag("pipeline", true);
  },

  /**
   * Forces a specific inference backend, for measurement only: ?delegate=cpu
   * or ?delegate=gpu. Absent (the default) keeps the shipped behaviour —
   * GPU first with a CPU fallback — which docs/ARCHITECTURE.md lists as non-negotiable.
   * This does not change that default; it only makes it testable.
   *
   * Worth actually running: "GPU delegate confirmed engaged" is recorded in
   * the risk log, but GPU vs CPU was never measured head to head. On weak
   * integrated graphics the per-frame texture upload and shader dispatch can
   * cost more than they save for a model this small, so the assumption that
   * GPU is faster here is exactly the kind this project is supposed to check.
   */
  get forceDelegate(): "GPU" | "CPU" | null {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search)
      .get("delegate")
      ?.toUpperCase();
    return raw === "GPU" || raw === "CPU" ? raw : null;
  },
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
 * off — folding the two together silently ignored ?worker=0).
 */
function queryFlag(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw === null) return fallback;
  return raw === "1" || raw === "true";
}

export const CAMERA_CONFIG = {
  /**
   * Requested capture resolution.
   *
   * Note this does NOT meaningfully change inference cost — BlazePose rescales
   * whatever it is given to a fixed internal tensor (256x256), which is why
   * capture resolution was ruled out as a frame-rate fix in
   * the risk log. Resolution matters here for
   * a different reason: many webcams only offer their HIGHER frame-rate modes
   * at lower resolutions, so dropping to 320x240 is often what actually
   * unlocks 60 FPS capture.
   *
   * Because the model downsamples to 256x256 regardless, 320x240 costs almost
   * nothing in landmark accuracy — it is close to the model's native input.
   * What it costs is preview sharpness for the human, which in boxer mode is a
   * small corner inset anyway.
   *
   * Overridable via ?camW / ?camH.
   */
  get width() {
    return queryNumber("camW", 640);
  },
  get height() {
    return queryNumber("camH", 480);
  },

  /**
   * Requested capture frame rate. Raised from 30 to 60 — this is the single
   * cheapest lever on the measured 15 FPS pose rate, and it is about
   * QUANTIZATION, not throughput.
   *
   * Inference takes ~36ms and runs inside requestVideoFrameCallback, so the
   * next inference can only start on the next decoded frame AFTER it finishes.
   * The effective rate is therefore
   *     1 / (ceil(inference / frameInterval) x frameInterval)
   * which at 36ms inference gives:
   *     30 FPS capture (33.3ms) -> ceil(36/33.3)=2 -> 66.6ms -> 15.0 FPS
   *     60 FPS capture (16.7ms) -> ceil(36/16.7)=3 -> 50.0ms -> 20.0 FPS
   *    120 FPS capture ( 8.3ms) -> ceil(36/8.3) =5 -> 41.7ms -> 24.0 FPS
   * The 15.0 there matches the 15.1 actually measured, which is good evidence
   * the model is right. Finer frame granularity wastes less of the gap.
   *
   * The hard ceiling is 1/inference = ~27.8 FPS on this machine. Reaching 60
   * needs inference under 16.7ms, which is a hardware or model change, not a
   * capture setting — see the risk log.
   *
   * `ideal` rather than `exact`, so a camera that cannot do 60 degrades to
   * whatever it supports instead of failing to open. The debug HUD reports the
   * rate actually granted; do not assume the request was honoured.
   */
  get frameRate() {
    return queryNumber("camFps", 60);
  },
};

export const SMOOTHING_DEFAULTS = {
  /**
   * One-euro filter parameters. Carried over from Flap's wrist tracking as a
   * starting point — these were tuned for flap detection, not punches, and
   * should be re-tuned during Milestone 1 against real punch trajectories.
   */
  minCutoff: 1.2,
  beta: 0.02,
  dCutoff: 1.0,
};

/**
 * Punch detection and classification (Milestone 1, Approach A).
 *
 * All distances are **torso-normalized**: 1.0 means one shoulder-to-hip
 * length, so the same numbers hold whether the player is near or far from the
 * camera, tall or short.
 *
 * These are starting values reasoned from the geometry, NOT tuned against
 * measured data. Milestone 1's job is to produce the confusion matrix that
 * says whether they are right — expect to revise them, and record what
 * changed and why in the risk log.
 */
export const PERCEPTION_CONFIG = {
  /** Below this landmark confidence, a frame is ignored rather than guessed at. */
  minLandmarkConfidence: 0.5,

  /** Good frames needed before calibration can be accepted. */
  calibrationMinSamples: 30,

  // --- Punch detection (the tractable half; see the gesture-classification notes) ---

  /**
   * DETECTION GATES.
   *
   * Rebuilt after the first measured run detected only 19% of thrown punches
   * (risk log OQ1). The old design gated on wrist-to-shoulder distance, which a
   * punch thrown at the camera doesn't grow. Detection now keys on EXCURSION —
   * how far the fist has travelled from its calibrated guard, in any direction
   * — which has no blind axis and covers all four punch types with one gate.
   *
   * These are conservative floors, above resting jitter and below the weakest
   * modelled punch, NOT validated against real punches. The diagnostics panel
   * reports actual peaks reached; revisit from that data, not by passing a test.
   */

  /**
   * Floor for fist travel from guard, torso units. Effective threshold is the
   * larger of this and the player's measured guard jitter × guardNoiseMultiple.
   * Set below the smallest modelled punch — a fully foreshortened jab displaces
   * the fist only ~0.16 torso units, so anything near 0.2 rejects real punches.
   */
  minPunchExcursion: 0.13,
  /** Multiple of measured guard jitter treated as the noise ceiling. */
  guardNoiseMultiple: 3,
  /** Below this excursion the hand counts as back at guard, re-arming. */
  guardExcursion: 0.07,
  /**
   * Minimum MEAN outward speed of the fist, torso-widths per second. Mean, not
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
  /** Minimum gap between two punches from the SAME hand (ms). */
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
  // the numbers that decide whether it passes — expect to tune them against
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
 * Character rendering and retargeting (Track B). Cosmetic only — nothing here
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
   *  the head off the punch line — the knees only supply the height. */
  waistFold: (22 * Math.PI) / 180,
} as const;

export const RENDER_CONFIG = {
  /**
   * Smoothing time constant for bone rotations, seconds.
   *
   * Pose samples arrive at ~15 FPS while rendering runs at ~60, so without
   * interpolation the character visibly steps four times per pose update.
   * This is the single biggest contributor to whether the motion reads as
   * fluid. Kept short because punches are fast and over-smoothing would lag
   * the very motion the game is about — raise it if the character looks
   * jittery, lower it if it feels sluggish.
   */
  boneSmoothingTau: 0.06,

  /**
   * Smoothing time constant used when a bone has a long way to travel —
   * i.e. real, fast motion rather than landmark jitter. The driver blends
   * between this and `boneSmoothingTau` by how far the bone is from its
   * target, so idle pose stays calm while a punch stays sharp. A single fixed
   * constant cannot do both: long enough to bridge the ~15 FPS pose stream
   * without visible stepping is also long enough to blunt a jab.
   */
  boneSmoothingTauFast: 0.022,

  /** Discrepancy, radians, treated as fully "fast motion" for the blend
   * above. ~23 degrees — well beyond jitter, well within a thrown punch. */
  fastMotionAngle: 0.4,

  /**
   * How long a bone coasts on its last good target after its landmarks drop
   * out, seconds, before fading back to rest.
   *
   * MediaPipe loses individual landmarks constantly — an elbow crossing the
   * torso, a wrist leaving frame at the end of a hook. Snapping to rest on
   * that frame and back out on the next is a visible twitch, and it lands on
   * exactly the fast motion the game is about. Long enough to ride out a
   * dropout of a few pose samples (at ~15 FPS one sample is ~66ms), short
   * enough that a player who walks away doesn't leave a statue mid-punch.
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

  /** Sanity bounds on that estimate, torso units — rejects absurd outliers
   * from a badly-tracked frame. */
  limbLengthMin: 0.3,
  limbLengthMax: 1.1,

  /**
   * How long the "neutral" body position takes to follow the player, seconds.
   * Deliberately long: it must absorb the player repositioning in the room,
   * without erasing a held slip or crouch — which is exactly what a short
   * constant would do, by treating the dodge as the new neutral.
   */
  neutralFollowTau: 8,

  /**
   * Head turn. `measureHeadSignals` returns a ratio in roughly [-1, 1] — the
   * nose's position between the two ears — so the gain converts that ratio to
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
   * World height of the rig's BELT LINE (the hip line), measured from the same
   * asset: c_spine0 sits at y 0.944 with the figure's feet on y 0.
   *
   * This is the origin every torso-normalised height is measured from —
   * `strikeGeometry.ts` defines height 0 as the belt and 1.0 as the shoulder —
   * so anything placed in that space has to be anchored HERE, not on the
   * floor. Anchoring on the floor instead puts every target zone at the wrong
   * world height by however tall the legs are, which is exactly the fault the
   * punching dummy shipped with on its first render.
   */
  rigHipWorldHeight: 0.944,


  /**
   * Gain on the depth channel — how much a measured step in or out moves the
   * character.
   *
   * Kept separate from `rootGain` because depth is the one channel that
   * carries an assumption: `BODY_CONFIG.cameraDistance`. If stepping in reads
   * as too much or too little travel, this is the dial, and turning it here
   * leaves the lateral and vertical channels untouched.
   *
   * Below 1 on purpose. The character stands at a fixed distance from its
   * target, and a player who drifts a foot toward their desk should not walk
   * their fighter into the opponent.
   */
  depthGain: 0.55,

  /**
   * Gain on torso yaw. Well under 1, deliberately.
   *
   * The measured angle is the whole body's rotation, but the rendered root
   * rotation sits UNDER the arm retargeting, which already places the arms in
   * world space. Applying the full turn would rotate the arms twice — once by
   * the root and once by their own aim — and the punches would swing wide.
   */
  turnGain: 0.45,
};

export const DEBUG_CONFIG = {
  /** Minimum landmark confidence before a point/bone is drawn in the overlay. */
  minDrawConfidence: 0.3,
  /** Rolling window of per-frame samples used for the FPS/latency statistics. */
  perfWindowSize: 600,
};

/**
 * Training-mode strike resolution — see perception/strikeResolver.ts.
 *
 * These numbers describe a GAME DESIGN decision, not a measurement, and that
 * distinction is deliberate: risk log 13 records that there is no shared
 * physical space between players, so how far a punch "reaches" is chosen, not
 * observed. Tuning them changes how demanding the training target is to hit.
 */
export const STRIKE_CONFIG = {
  /**
   * Reach a fist must achieve to land, in torso units, measured from its own
   * shoulder and including recovered out-of-plane extension. Roughly "arm
   * most of the way out" — a guard position sits near 0.45, a committed
   * straight punch well past 1.0.
   */
  reachThreshold: 0.95,

  /**
   * How far the GLOVE'S striking surface sits beyond the wrist, in TORSO
   * units. 0.3409 torso = 0.17561 rig units against a 0.51518 torso.
   *
   * Measured once, offline, from the fitted asset (blender/out/boxer.blend):
   * the glove is 0.2728 long with 0.0972 of cuff behind the wrist, so its nose
   * leads the wrist by 0.17561. A bare fist leads it by 0.15009 (0.2913
   * torso), so the glove adds 0.02552 -- 0.0495 torso -- of reach.
   *
   * IT IS A CONSTANT, AND THAT IS THE POINT. Perception must never read the
   * character mesh (docs/ARCHITECTURE.md, and the header of strikeResolver.ts):
   * what you hit must not depend on how you are drawn. So the glove's
   * contribution enters as a number measured offline and written down, exactly
   * like the anthropometric limb constants, rather than by inspecting geometry
   * at match time. If the glove is re-fitted at a different size, re-measure
   * and update this -- gloveReachCheck in strikeResolver.test.ts asserts it
   * stays consistent with TARGET_CONFIG.distance.
   */
  gloveNoseReach: 0.3409,
  /** The same measure for a bare fist, kept for the gloves-off case and so the
   *  two can be compared in a test rather than conflated. */
  bareFistReach: 0.2913,

  /**
   * Starting estimate of each arm segment's length, torso units — the same
   * anthropometric figures the rig's limb calibration seeds from
   * (LIMB_TORSO_LENGTH). Only ever grows from observation.
   *
   * Seeding matters: starting from the first observed length would make the
   * threshold depend on whatever the player happened to be doing when
   * training mode opened, and if they never fully extend sideways the
   * reference would stay too short and every punch would read as landed.
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

  /** Fist speed floor, torso-widths per second. Stops a slow reach forward —
   * adjusting your guard, scratching your nose — registering as a punch. */
  minStrikeSpeed: 1.2,

  /** Minimum gap between strikes from the SAME hand, ms. A fast double jab is
   * around 250ms, so this must stay below that or it eats real punches. */
  refractoryMs: 180,

  /** Fraction of the threshold the fist must fall back below before that hand
   * can strike again. Hysteresis — without it, noise at the boundary fires
   * repeatedly from one held extension. */
  releaseFraction: 0.82,

  /** Reach past the threshold, in torso units, that counts as full power. */
  powerRange: 0.45,
  /** Power credited to a punch that only just lands. */
  basePower: 0.35,

  /** How far below the shoulder line still counts as a head shot, torso units. */
  headBandBelowShoulders: 0.08,

  /** Half-width of the centre lane, torso units. Outside it, a strike is
   * classed as arriving from the player's left or right. */
  laneHalfWidth: 0.22,

  /**
   * Fraction of a strike's travel that must be FORWARD for it to read as a
   * straight punch rather than a hook or an uppercut. Descriptive only — this
   * drives a caption, never whether a hit lands. See strikeGeometry.ts on why
   * that separation is the point of the phase-2 rework.
   *
   * 0.6 rather than 0.5 because a slightly-angled straight punch is still a
   * straight punch to anyone watching, and the hooking/rising buckets should
   * be reserved for travel that is visibly across or up.
   */
  straightDirectness: 0.6,

  /**
   * Damage multiplier for a RISING strike to the chin or jaw specifically.
   * An upward blow rotates the head, which is the actual mechanism behind a
   * knockout; the same force driven straight in mostly pushes someone back.
   * Applied nowhere else, so this is not a blanket bonus for uppercuts.
   */
  risingChinBonus: 1.35,
} as const;

/**
 * Facial damage — swelling, cuts, bleeding, and the eyes themselves.
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
   *  fresh skin absorbs — which is why cuts appear late in a fight. */
  cutSwellingRequired: 0.35,
  cutPerHit: 0.3,

  /** Seconds for swelling to fade completely. Long: swelling subsides over a
   *  fight, not over a round. */
  swellFadeSeconds: 90,
  /** Blood dries and gets wiped far faster than swelling goes down. */
  bleedFadeSeconds: 14,

  /** How much cheek swelling contributes to closing the eye above it. */
  cheekClosureShare: 0.45,

  /**
   * Cheek/jaw swelling, as a bone-scale factor at full damage.
   *
   * Only the JAW is here, and only the jaw ever can be: the skin weights were
   * counted and l_eye/r_eye carry NONE, so scaling them deforms nothing. Eye
   * closure is tracked as a damage metric but has nothing to drive until the
   * Blender-authored head ships real lids — see blender/README.md.
   */
  jawPuff: 0.14,

  /** Eye vertices are few, so their own UV spread underestimates the visible
   *  eye. Scaled up to cover the lid area a bruise should reach. */
  eyeRadiusScale: 2.4,
  /** Eye radius as a fraction of the jaw island's UV extent, used when the
   *  eye bones have no weighted vertices to measure from — which on this rig
   *  is always. An eye is roughly a sixth of the jaw footprint. */
  eyeRadiusOfJaw: 0.17,
  cutColour: "#7a1512",
  bloodColour: "#8e1410",

  bruiseAlphaGain: 0.85,
  bruiseMaxAlpha: 0.7,
  bloodAlphaGain: 1.1,
} as const;

/**
 * Region-of-interest cropping. See pose/roiCrop.ts — including the verified
 * reason the native `regionOfInterest` API cannot be used (PoseLandmarker
 * constructs its runner with roiAllowed=false and throws).
 */
export const ROI_CONFIG = {
  /**
   * Side of the square canvas handed to the model, pixels.
   *
   * 256 because that is the order of the tensor the lite model resizes to, so
   * anything larger is uploaded only to be thrown away. Kept as a constant
   * rather than inlined because it is the first thing to try changing if a
   * heavier model is ever swapped in.
   */
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
  /** Extra headroom multiplier above the topmost landmark — the crop must
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
   *  resampling noise — which would be a new jitter source. */
  quantise: 8,

  /** Frames of lost tracking before the crop gives up and goes full-frame.
   *  Staying zoomed on an empty box is self-sealing: the player cannot be
   *  re-acquired from outside the only region being examined. */
  lostFramesBeforeReset: 12,
} as const;

/**
 * Skeleton solver — the biomechanical constraints applied to raw landmarks.
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

  /** Minimum confidence on BOTH endpoints before a bone length is learned
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
   * camera reads SHORT, so feeding every sample to a median would learn a
   * length somewhere between "arm out" and "arm at the lens" — a length the
   * arm never actually has.
   */
  growThreshold: 0.97,

  /**
   * Time constant for a limb's slow-moving "current projected length",
   * seconds. This is the knob that separates foreshortening from noise.
   *
   * Too short and it tracks the noise, doing nothing. Too long and it resists
   * a genuine punch toward the camera, which would blunt the depth signal the
   * strike resolver depends on. 0.08 s is roughly one to two pose samples:
   * long enough that single-frame noise cannot move it, short enough that a
   * punch — which develops over three or four samples — is followed.
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
   *  count: this IS the stiffness, and it cannot diverge. */
  iterations: 3,
  /** Fraction of each length error corrected per pass. Below 1 so the solver
   *  eases toward the constraint instead of snapping, which would reintroduce
   *  exactly the per-frame discontinuity it exists to remove. */
  stiffness: 0.55,
} as const;

/**
 * Latency compensation. See pose/predictor.ts — this is the difference between
 * the character being where you were ~110 ms ago and being where you are.
 */
export const PREDICT_CONFIG = {
  /**
   * How much of the measured pipeline latency to compensate for, 0-1.
   *
   * Not 1. Prediction amplifies noise in proportion to how far ahead it
   * reaches, and the last few milliseconds cost the most confidence for the
   * least visible gain. 0.75 removes most of the perceived lag while keeping
   * the overshoot on a direction change small enough not to read as wobble.
   */
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

/**
 * The fight itself: health, guard, knockdowns, rounds, scoring.
 *
 * Every number here is a GAME DESIGN decision. Unlike the perception constants
 * above, none of it is measured or derived from anthropometry — it is chosen,
 * and it should be tuned by playing rather than by arguing.
 */
export const FIGHT_CONFIG = {
  /** Stamina drained by starting an evasion. A FIGHT rule, not an AI one — it
   *  applies to whoever is evading, and the player's own tracked dodges will
   *  be charged the same. Small, but it means a fighter who slips everything
   *  gasses out, which is why blocking and slipping are different choices
   *  rather than one strictly better one. */
  evadeStaminaCost: 1.6,

  /**
   * Fraction of damage that gets through a correct guard. Not zero: a blocked
   * heavy shot still moves you, still stings the arms, and a guard that
   * nullified everything would make the correct strategy "never lower it".
   */
  blockedDamage: 0.18,

  /** Stamina the blocker spends per point of damage absorbed. The other half
   *  of why a permanent high guard is not a winning strategy. */
  blockStaminaCost: 0.9,

  /** Seconds of stun per point of unblocked damage. */
  stunSecondsPerDamage: 0.03,

  /** Seconds a fighter is out of it after being dropped. */
  knockdownSeconds: 2.4,

  /** Health a fighter rises with after their FIRST knockdown. */
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
 * The camera director. See fightCamera.ts on why cuts are forbidden during
 * live action — it matters more here than in a gamepad game, because the
 * player is also the controller and a mid-exchange cut disorients someone who
 * is physically throwing punches.
 */
// Named DIRECTOR_CONFIG, not CAMERA_CONFIG: that name is already taken above
// by the WEBCAM's capture settings, and two different "cameras" in one config
// file is exactly the kind of collision that produces a subtle wrong-constant
// bug later.
export const DIRECTOR_CONFIG = {
  /** Distance from the fighters as a multiple of the cage radius. */
  broadcastDistance: 1.25,
  tightDistance: 0.55,
  /** Camera height for the default shot, metres above the canvas. */
  broadcastHeight: 2.35,
  /** How far up the fighters the camera aims. Chest height reads better than
   *  the head — aiming at heads puts the floor in half the frame. */
  aimHeight: 1.15,
  /** Knee height, which is what makes a downed fighter read as downed. */
  lowAngleHeight: 0.55,

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
} as const;

/**
 * The AI opponent. Per-difficulty numbers live in aiOpponent.ts's profile
 * table, because they only make sense as a set; these are the shared ones.
 */
/**
 * How the CPU opponent's body is DRAWN. Purely cosmetic — the AI's decisions
 * and the fight's rules are both upstream of everything here, and nothing in
 * this block can change whether a punch lands.
 */
export const OPPONENT_ANIM = {
  /** Seconds from release to the arm being back on guard. */
  punchSeconds: 0.34,
  /** Share of that spent going OUT. Out fast, back slow: the recovery is the
   *  half that leaves you open, and a symmetric animation reads as a piston. */
  punchOutShare: 0.35,
  /** Time constant the arms chase their target pose with. Short — an arm that
   *  lags its own telegraph is a telegraph the player cannot trust. */
  armTau: 0.045,
  /** Maximum change in arm extension per second. Bounds how fast a glove can
   *  cross the space between the fighters, whatever the state machine or the
   *  frame rate does. 9/s puts a full guard-to-extended swing at no less than
   *  ~110ms, which is about as fast as a human arm actually is. */
  maxExtendRate: 9,

  /** How far a punch's line tilts between a body shot and a head shot. Applied
   *  to the extended arm's vertical component, so the AI's chosen target
   *  height is visible in the punch instead of only in the damage feed. */
  aimRise: 0.45,

  /** Torso-to-world scale used only if the rig is missing the bones it is
   *  measured from — a figure in that state is already broken, and this just
   *  keeps it on the stage while that is diagnosed. */
  fallbackTorsoWorld: 0.475,
} as const;

export const AI_CONFIG = {
  /** Fraction of the normal tempo used to press a stunned opponent. Below 1 =
   *  faster. The window after a knockdown is where fights are finished. */
  stunnedUrgency: 0.35,

  /** Stamina fraction below which the AI stops throwing and covers up. This is
   *  what makes draining the opponent a real strategy rather than a stat that
   *  ticks down cosmetically. */
  exhaustedFraction: 0.18,

  /** Multiplier on the pause after being hurt, before resuming. */
  resetAfterHurt: 1.4,

  /** Power multiplier applied per punch deeper into a combination. The last
   *  punch of a five-piece is an arm punch, not a knockout blow. */
  comboPowerDecay: 0.88,

  /** Random spread added to the AI's aim, torso units. Stops repeated punches
   *  stacking on one pixel, and spreads bruising the way a real face bruises. */
  aimJitter: 0.09,

  // FOOTWORK
  //
  // The opponent's position is expressed in the SAME channels the camera
  // produces for the player (`perception/bodyMotion.ts`): lateral and depth in
  // torso units, crouch 0-1, lean in radians. That is deliberate — it means
  // there is one movement vocabulary in the game rather than two, and the
  // animator that renders the opponent stepping is the same shape as the one
  // that renders the player stepping.

  // Ranges live in FIGHT_GEOMETRY, not here. They are derived from where the
  // fighters actually stand, and a copy in this block would be free to drift
  // away from the scene — which it did: the AI was told the gap was 1.0 torso
  // units while the figures stood 1.66 apart, so it believed itself in range
  // from across the ring.

  /** Torso units per second of footwork travel, before the difficulty's own
   *  `footSpeed` multiplier. */
  stepSpeed: 1.15,

  /** How far the AI will circle off the centre line before turning around. */
  lateralLimit: 0.85,

  /** How far in and out of the pocket the AI will travel, torso units. Bounds
   *  the depth channel for the same reason `lateralLimit` bounds the lateral
   *  one: an unbounded integrator walks off the stage. */
  depthLimit: 1.4,

  /** Share of head movements that are a DUCK rather than a slip. Ducking is
   *  the stronger answer and the slower recovery, so it is the minority
   *  choice. */
  duckShare: 0.3,

  /** Seconds a footwork choice is held before it is reconsidered. Without a
   *  minimum the AI reverses direction every tick and vibrates on the spot. */
  footworkMin: 0.45,
  footworkMax: 1.6,

  /** Seconds a slip or duck is committed for. Long enough to be visible and to
   *  be a real decision; short enough that it cannot be held as a permanent
   *  invulnerability. */
  evadeSeconds: 0.42,

  /** Seconds after an evasion before another can start. Without this the AI
   *  re-slips the instant the window closes and is never hittable. */
  evadeCooldown: 0.5,

  /** Torso units a slip moves the head off the centre line, and radians of
   *  lean that goes with it. Rendered, not simulated: whether a slip WORKS is
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
 * Training target (the second mesh) — how it reacts to being hit.
 * Purely cosmetic: damage STATE lives in the resolver above, the APPEARANCE of
 * it lives in the render layer. See risk log 13's layering rule.
 */
export const TARGET_CONFIG = {
  /**
   * Where the target stands relative to the player's boxer, world units. The
   * player's character faces +Z, so the target sits in front of it.
   *
   * DERIVED so the GLOVE lands on the target, rather than the fist landing
   * somewhere and the glove going through the head. Every term measured off
   * the fitted rig:
   *
   *   player shoulder            z = -0.0322
   *   shoulder -> wrist              0.52680   (1.0225 torso)
   *   glove nose beyond wrist        0.17561   (0.3409 torso)
   *   target head front surface      0.1551 forward of the figure's centre
   *
   * A strike registers at STRIKE_CONFIG.reachThreshold = 0.95 torso of wrist
   * extension, which is 0.95 / 1.0225 = 92.9% of the arm. At that instant:
   *
   *   wrist      = 0.52680 * 0.929            = 0.48945 from the shoulder
   *   glove nose = 0.48945 + 0.17561          = 0.66506
   *   nose z     = -0.0322 + 0.66506          = 0.63286
   *   distance   = 0.63286 + 0.1551           = 0.788
   *
   * So the glove's striking surface arrives at the target's face exactly as
   * the hit registers.
   *
   * WAS 0.72, AND IT CLIPPED. That figure was derived for a BARE FIST, before
   * the gloves existed. With a glove on, full extension put the nose at
   * z = 0.67021 while the head's front sat at 0.5649 -- the glove passed
   * 0.105 THROUGH the head on every straight punch.
   *
   * At full extension this distance still leaves 0.037 of overlap, which is
   * deliberate: a padded glove compresses on impact, and a glove that stops
   * dead on the skin reads as a mime. 3.7cm is about right for 16oz.
   */
  distance: 0.788,

  /** Peak head rotation from a full-power head shot, radians. */
  headSnap: (28 * Math.PI) / 180,
  /** Peak torso rotation from a full-power body shot, radians. */
  bodyFold: (14 * Math.PI) / 180,
  /** Jaw drop at full power, radians — bone-driven, no blendshapes needed. */
  jawDrop: (12 * Math.PI) / 180,
  /** How far the whole body is knocked back at full power, world units. */
  knockback: 0.1,

  /** Time constant for the reaction decaying back to neutral, seconds. */
  recoverTau: 0.22,
  /** Time constant for the reaction building up, seconds. Much shorter than
   * recovery: an impact is sudden, the recovery from it is not. */
  impactTau: 0.035,
} as const;

/**
 * Where the two fighters stand, in the units the SIMULATION thinks in.
 *
 * Derived, not typed. The figures are placed `TARGET_CONFIG.distance` apart in
 * WORLD units, and the AI reasons about range in TORSO units — and the two
 * were silently inconsistent: the AI was told the gap was 1.0 torso units when
 * the figures really stood about 1.66 apart. It therefore believed it was
 * already at its preferred range while visibly across the ring, and would
 * throw punches that landed on a fighter it had not walked up to. That is
 * exactly the failure the striking-range gate was added to prevent, defeated
 * by a unit mismatch rather than by a missing rule.
 *
 * Deriving it means moving the fighters re-teaches the AI where they are.
 */
const NEUTRAL_RANGE = TARGET_CONFIG.distance / RENDER_CONFIG.rigTorsoWorldLength;

export const FIGHT_GEOMETRY = {
  /** The gap when neither fighter has moved, torso units. The zero point both
   *  depth channels are subtracted from. */
  neutralRange: NEUTRAL_RANGE,

  /**
   * The gap at which a committed punch reaches, torso units.
   *
   * Equal to the neutral gap, and that is not a coincidence or a coasting
   * default — `TARGET_CONFIG.distance` was itself DERIVED as the distance at
   * which a fully extended arm just reaches the other fighter's head. The two
   * statements are the same measurement in different units, so writing a
   * separate number here would have been a second opinion about a thing that
   * has already been settled, free to drift away from it.
   */
  strikingRange: NEUTRAL_RANGE,

  /**
   * The gap a fighter tries to HOLD while not attacking.
   *
   * Just outside reach, which is where a boxer actually stands: close enough
   * to step in, far enough not to be hit on the way. It is what makes the AI
   * step in to throw and step out again rather than standing in the pocket
   * trading, and it is why the player sees footwork at all.
   */
  preferredRange: NEUTRAL_RANGE * 1.22,

  /** Inside this the fighters are on top of each other. Nobody fights from
   *  inside their own guard, so the AI backs out. */
  clinchRange: NEUTRAL_RANGE * 0.55,
} as const;

/**
 * Fist clench — see render/retargeting/handRig.ts.
 *
 * Finger articulation is not tracked (MediaPipe Pose gives three points per
 * hand and no curl), so clench is inferred from what the arm is doing.
 */
export const HAND_CONFIG = {
  /** Clench held at all times. A boxer's hands are never open, and the mesh's
   * relaxed bind pose reads as wrong the moment it is seen in context. */
  guardClench: 0.82,
  /** Clench at full extension — the fist tightens as the punch lands. */
  strikeClench: 1.0,
  /** Extension, as a fraction of the strike threshold, at which tightening
   * begins. Below this the hand sits at its guard clench. */
  tightenFrom: 0.55,
  /** Smoothing time constant for clench, seconds. Fast — a fist closing
   * visibly slowly looks like hesitation, not a punch. */
  tau: 0.05,

  /** How much a forearm pointing at the camera counts toward extension. A
   * straight punch down the lens barely moves the wrist on screen, so without
   * this the fist would never tighten on the most committed punch there is. */
  depthWeight: 0.45,
} as const;

/**
 * Character texturing and visible damage — see render/texturing/.
 *
 * The exported mesh has no textures at all; these build one procedurally at
 * load time from the UV layout measured by tools/uv-regions.mjs.
 */
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

/**
 * Skin tones. The two differ slightly so the figures read apart at a glance.
 *
 * Clothing was tried twice and removed both times at the project owner's
 * request — first as flat painted colour bands, then as fitted third-party
 * meshes. See the 2026-09-15 entries in docs/ARCHITECTURE.md for what was learned; the
 * character is bare skin plus damage until a garment approach is chosen again.
 */
export const KIT = {
  /**
   * Per-fighter kit colour.
   *
   * The GLB ships ONE colour set baked into the glove/shorts/boot materials,
   * and the opponent is a `SkeletonUtils.clone` of the same asset — which
   * shares materials BY REFERENCE. So the two fighters cannot be told apart
   * until each is given its own material, and disposing one figure's material
   * while the other still points at it is a real bug this project has already
   * hit once.
   *
   * Red corner / blue corner, because at speed the kit is the most visible
   * thing on either figure and is therefore the right thing to key on.
   */
  player: {
    skin: "#b98a6a",
    glove: "#9d1f24",
    trunks: "#8c1520",
    boots: "#6f1119",
  },
  target: {
    skin: "#a97a5c",
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

/**
 * Tracking watchdog (pose/trackingMonitor.ts).
 *
 * Thresholds are the conditions this project has actually measured, not
 * aspirations. The pose rate in particular: risk log 12 explains the ~15 Hz
 * quantisation and the ~27.8 Hz hard ceiling from inference time on this
 * machine, so "good" is set where it is reachable rather than where it would
 * be nice.
 */
export const MONITOR_CONFIG = {
  /** Landmark confidence below which a reading counts as a dropout. */
  minConfidence: 0.5,
  /** Rolling window length, frames. At ~15 Hz this is about 6 seconds --
   *  long enough to average out a stumble, short enough to notice the light
   *  changing. */
  windowFrames: 90,
  /** Below this many frames the window is not worth reporting on. */
  minSamples: 12,
  /** Metric score below which the report speaks up. Advice keys off the SCORE
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
  maxSmoothingScale: 2.5,
  minPredictScale: 0.25,
  maxPredictScale: 1.0,
} as const;

// DUMMY TRAINING
//
// The training mode is a punching dummy with lit target zones. These numbers
// govern how a target is presented and how the response is scored.
//
// A note on the reaction-time figures, because they look generous: this
// project's pose stream runs at ~15 Hz (risk log 12), so a sample arrives
// every ~67ms and the measured latency of ANY response carries up to that much
// quantisation error on top of the player's real reaction. `perfectMs` is set
// well above a human's floor (~200ms visual reaction) for that reason — a
// tighter figure would be measuring the frame rate, not the player.
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
   * Below it, the punch scores proportionally — a flicked arm that technically
   * crosses the reach threshold should not score like a thrown punch.
   */
  fullPowerAt: 0.55,

  /** Rounds a zone must be trained before its statistics are trusted. */
  minZoneSamples: 6,
} as const;

// ADAPTATION
//
// The training system gets better the more it is used. What it is ALLOWED to
// change is deliberately narrow — see `training/adaptation.ts` for the full
// argument. In short: it may correct a COMMON-MODE coordinate bias (which is a
// setup error, like camera height) and it may choose WHICH targets to show. It
// may never touch a threshold that decides whether a punch landed.
export const ADAPT_CONFIG = {
  /** Total scored strikes before any correction is applied at all. */
  minSamples: 24,
  /**
   * Distinct zones that must have contributed. This is the guard that stops a
   * player from teaching the system an offset by hammering one target: a bias
   * seen on ONE zone is that player's technique on that shot, and a bias seen
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

// CAMERA POINTER — driving the menu with your hands.
//
// See ui/shell/pointerModel.ts for the four independent defences these serve.
// The timings are deliberately toward the SLOW end: the project owner asked to
// avoid accidental presses entirely, and in this game specifically the
// player's hands are up and moving constantly, so a fast confirm would fire on
// ordinary guard movement.
export const POINTER_CONFIG = {
  /** Landmark confidence a wrist needs before it may drive the cursor. */
  minConfidence: 0.5,

  /**
   * Half-width of the hand's reach box, in TORSO UNITS, mapped to half the
   * screen. 0.9 means a hand one torso-length out from the shoulder midline
   * reaches the edge — about the span of a relaxed arm, so the far corners are
   * reachable without leaning.
   */
  reachX: 0.9,
  reachY: 0.72,
  /**
   * Vertical offset of the cursor's rest position, torso units below the
   * shoulder line. A hand at a natural guard height sits ABOVE the shoulder
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
   * before the dwell restarts. Roughly a third of a menu row — tight enough to
   * reject a hand travelling through, loose enough to tolerate the jitter of a
   * 15 Hz pose stream.
   */
  steadyRadius: 0.035,
} as const;

// WHOLE-BODY MOTION — see perception/bodyMotion.ts.
//
// The channels that let the character step in, crouch and blade rather than
// only sway. All distances are torso-normalized; all angles are radians.
export const BODY_CONFIG = {
  /**
   * Assumed camera distance, in TORSO UNITS. The one honest assumption in the
   * depth channel.
   *
   * 4.0 torso units is about 2m for a 0.5m torso, which is roughly where
   * someone stands to box in front of a laptop. A single uncalibrated webcam
   * cannot measure this — it needs the field of view, which browsers do not
   * report reliably — so it is stated rather than derived.
   *
   * It acts purely as the GAIN on depth: wrong by a factor of two and stepping
   * in moves the character half or twice as far, but never the wrong way and
   * never non-monotonically. Revisit if depth feels over- or under-driven;
   * this is the number to turn.
   */
  cameraDistance: 4.0,

  /**
   * The camera's principal point, in normalised image coordinates — the point
   * the image magnifies about as the subject moves nearer or further.
   *
   * The image centre for any ordinary webcam. It matters because lateral and
   * vertical are measured RELATIVE to it: stepping toward the camera magnifies
   * everything about this point, so anyone not standing dead centre appears to
   * rise as they step in. Measuring from here and dividing by the torso scale
   * cancels that exactly.
   */
  principalX: 0.5,
  principalY: 0.5,

  /** Maximum lateral/vertical travel from neutral, torso units. */
  travelClamp: 0.7,
  /** Maximum step in or out, torso units. */
  depthClamp: 0.8,

  /**
   * Torso yaw below this is treated as zero, radians (~7 degrees).
   *
   * Shoulder width is noisy at this project's ~15 Hz pose rate, and the acos
   * that recovers the angle is STEEPEST exactly where the signal is smallest.
   * Without a dead zone, resting noise near square-on turns into a visibly
   * twitching torso — the worst place to put jitter, because it is the part of
   * the body a player is not moving.
   */
  turnDeadZone: 0.12,
  /** Maximum torso yaw, radians (~50 degrees). A bladed stance, not a pirouette. */
  turnClamp: 0.88,

  /**
   * Vertical drop that counts as a full crouch, torso units.
   *
   * A boxer's duck drops the shoulders by roughly a third of their
   * shoulder-to-hip length; anything much more is sitting down.
   */
  fullCrouch: 0.34,

  /** Neutral drift time constant, seconds. Long: a held crouch must stay one. */
  neutralTau: 9,
} as const;
