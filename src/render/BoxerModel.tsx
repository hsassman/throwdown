import { ResolutionGovernor } from "./resolutionGovernor";
import { SlowDetector } from "./slowDetector";
import { FPS_CAMERA, SHOULDER_CAMERA, approach, fpsCameraPose, fpsFov, fpsLean, isGlove, type CameraPose as FpsPose } from "./fpsCamera";
import { DEMO_PRESET, isDemoMode } from "../config/demoMode";
import type { RollingStats } from "../debug/perfStats";
import { ImpactLog, TimeWarp, hitStopFor, shakeFor, shakeOffset } from "../sim/impactFeedback";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PoseFrame } from "../pose/poseTypes";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RigDriver, type RigDebugState } from "./retargeting/rigDriver";
import { VIEW_MODES, type ViewMode } from "./retargeting/rigJointMap";
import type { BodyMotion } from "../perception/bodyMotion";
import { TrainingTarget, type TargetDebugState } from "./TrainingTarget";
import {
  IDLE_OPPONENT,
  OpponentAnimator,
  type OpponentVisualState,
} from "./opponentAnimator";
import { PunchingDummy } from "./PunchingDummy";
import type { DrillOutcome, LitTarget } from "../training/drill";
import { nearestZone } from "../training/hitZones";
import { buildBodyUvMap, dominantBones } from "./texturing/bodyUv";
import {
  buildBodyTexture,
  type BodyTexture,
  type BodyTextureOptions,
} from "./texturing/bodyTexture";
import {
  DIRECTOR_CONFIG,
  KIT,
  KIT_MESH_COLOUR,
  KIT_ROUGHNESS,
  RENDER_CONFIG,
  TARGET_CONFIG,
  KNOCKDOWN_ANIM,
} from "../config/tuning";
import { findBodyMesh } from "./findBodyMesh";
import { buildArenaLighting, buildOctagon } from "./arena/Octagon";
import { buildRing } from "./arena/Ring";
import { buildCrowd, type Crowd } from "./arena/crowd";
import { artTexture } from "./arena/artTextures";
import { DEFAULT_APPEARANCE, FIGHTER_OPTIONS, trimColour, type FighterAppearance } from "../menu/fighterAppearance";
import { applyHeadDetail } from "./texturing/scalp";
import { textureEyes } from "./texturing/eyes";
import { styleKitDetail, type KitTrim } from "./texturing/kitDetail";
import { buildBloodDecals } from "./arena/bloodDecals";
import { buildTrainingRoom } from "./arena/trainingRoom";
import { RING, platformHalfSpan } from "./arena/ringSpec";
import { OCTAGON } from "./arena/octagonSpec";
import type { StageId } from "./ArenaView";
import {
  FightCamera,
  type CameraPose,
  type DirectorInput,
  type ShotName,
} from "./arena/fightCamera";
import type { FightEvent, FightPhase } from "../sim/fightState";
import type { FightCondition } from "../sim/useFight";
import { FaceDamage } from "./damage/faceDamage";
import { createFacePainter, headIslandMask, locateFaceFeatures } from "./damage/facePainter";
import type { StrikeEvent } from "../perception/strikeResolver";

// Track B, Milestone B2/B3: loads the MHR-exported boxer mesh and drives the
// joints covered by rigJointMap.ts from live MediaPipe landmarks. Purely
// cosmetic - see docs/ARCHITECTURE.md. No placeholder shape exists yet to
// "replace" (Track a hasn't built a render layer), so this is reached through
// its own screen in App, reached from the menu shell.

const MODEL_URL = `${import.meta.env.BASE_URL}models/boxer_lod3.glb`;

/** Vertical slice of the figure to frame, as a fraction of its full height.
 * Was 0.45 while the legs sat frozen at rest and there was nothing below the
 * waist worth looking at. Now that hips and knees are driven, the frame runs
 * far enough down to read the player's stance without giving up most of the
 * viewport to the floor. */
const FRAME_FROM_HEIGHT = 0.62;
/** Padding around the framed region, as a multiplier on the fit distance. */
const FRAME_MARGIN = 1.15;

/**
 * Over-the-shoulder framing, used whenever something is standing opposite the
 * player - the dummy or the CPU fighter.
 */
const OVER_SHOULDER = {
  rise: 1.05,
  /**
   * How far past the player's own shoulder the sight line must clear, world
   * units. The only hand-chosen number left in this block - everything else is
   * derived from it and the measured figure.
   */
  clearance: 0.42,
  /** Bounds on the derived lateral offset, so a strange measurement cannot
   *  swing the camera out to the side of the ring or collapse it to zero. */
  minLateral: 0.4,
  maxLateral: 1.1,
  /** Fraction of the way toward the opponent that the camera aims. */
  aim: 0.5,
  /** Extra frame height, to fit two figures instead of one. */
  widen: 1.5,
};

/** How far to the side the camera must sit to see past the player. */
const FINITE_BACK = 0.85;

/** See followOpponent. A bound on the turn, radians, so a stray reading
 *  cannot swing the camera round to the side of the ring, and the ease rate,
 *  per second: slow enough that circling reads as the camera settling, not
 *  as it being tugged. */
const FOLLOW_CAM = { maxYaw: 0.7, ease: 2.5 };

/** Marks every mesh under a figure as a shadow caster. Skinned meshes need
 *  the flag on the mesh, not on the root the loader returns. */
function castShadows(figure: THREE.Object3D): void {
  figure.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
}

function overShoulderLateral(shoulderHalfWidth: number, frontZ: number): number {
  const reachable = Math.max(0.1, TARGET_CONFIG.distance - frontZ);
  const needed =
    (shoulderHalfWidth + OVER_SHOULDER.clearance) / reachable / FINITE_BACK;
  return Math.min(
    OVER_SHOULDER.maxLateral,
    Math.max(OVER_SHOULDER.minLateral, needed)
  );
}

/** Cage radius used when no venue is built, for the camera director's framing. */
const FALLBACK_ARENA_RADIUS = 3;

/** Scratch, reused every frame: the director reads two world positions per
 *  frame and allocating for them would hand the collector 120 vectors a
 *  second for numbers that are read once. */
const _dirPos = new THREE.Vector3();

/** Render resolution bounds. Kept under the device pixel ratio because this
 * competes with pose inference for the same GPU. */
const MAX_PIXEL_RATIO = isDemoMode() ? DEMO_PRESET.maxPixelRatio : 1.25;
const MIN_PIXEL_RATIO = 0.75;

export type LoadStatus = "loading" | "ready" | "error";

interface Props {
  appearance?: FighterAppearance;
  wardrobe?: boolean;
  poseRef: React.RefObject<PoseFrame | null>;
  /**
   * Optional: returns the pose to draw at the calling instant, extrapolated
   * forward by the measured pipeline latency. When supplied it replaces
   * `poseRef` for rendering only.
   */
  samplePose?: () => PoseFrame | null;
  /**
   * How the character is framed, and - inseparably - how the player's limbs
   * map onto its bones. See VIEW_MODES: the camera side and the mapping are
   * two halves of one decision, and changing either alone puts the arms on
   * the wrong side of the screen.
   */
  view?: ViewMode;
  onStatusChange?: (status: LoadStatus, detail?: string) => void;
  /** Receives live retargeting state for the diagnostics panel. Called on a
   * timer rather than per frame - a per-frame callback into React would
   * re-render the tree 60x a second for a readout nobody can read that fast. */
  onDebug?: (state: RigDebugState) => void;
  /** Bumping this recentres the character on where the player stands now. */
  recentreSignal?: number;
  /** Adds the second humanoid - a training target that reacts to hits. */
  showTarget?: boolean;
  /** First person: the camera at the player's eyes. Only takes effect in a duel. */
  fps?: boolean;
  /** True while the fight holds both fighters on one line; the first-person
   *  camera then looks straight down it instead of turning with the opponent. */
  lineLockedRef?: React.RefObject<boolean>;
  /** Strikes to play on the target. The ref is read and drained by the render
   * loop rather than passed as a prop, because hits arrive at pose rate and
   * routing each one through React would re-render the tree mid-combination. */
  strikeQueueRef?: React.RefObject<StrikeEvent[]>;
  /** Receives the target's hit tally, on the same timer as onDebug. */
  onTargetDebug?: (state: TargetDebugState) => void;
  /** Swaps the humanoid target for the punching dummy. */
  dummy?: boolean;
  /** The target zone to light on the dummy. Read every frame, never a prop
   *  value, because it changes at drill rate. */
  litRef?: React.RefObject<LitTarget | null>;
  /** Drill outcomes to play on the dummy. Drained by the render loop, for the
   *  same reason strikeQueueRef is. */
  outcomeQueueRef?: React.RefObject<DrillOutcome[]>;
  /** The CPU opponent's body state, read every frame. */
  opponentRef?: React.RefObject<OpponentVisualState | null>;
  /** CPU punches leaving the guard, to animate. Drained by the render loop. */
  opponentThrowQueueRef?: React.RefObject<StrikeEvent[]>;
  /** Opponent punches that landed on the player, for the flinch and marks. */
  opponentStrikeQueueRef?: React.RefObject<StrikeEvent[]>;
  /** Written every frame with the player's live whole-body channels. */
  bodyOutRef?: React.RefObject<BodyMotion | null>;
  /** The venue to build around the fighters. Null keeps the plain dark room. */
  stage?: StageId | null;
  /** Fight events to drain, for the camera director and the knockdown. */
  fightEventQueueRef?: React.RefObject<FightEvent[]>;
  /** The live phase, read every frame. The director's "never cut during a
   *  live exchange" rule is a question about this and nothing else. */
  phaseRef?: React.RefObject<FightPhase>;
  /** Down / hurt / count per fighter, read every frame. */
  conditionRef?: React.RefObject<FightCondition>;
  /** Recent punch outcomes, for the camera kick on a landed or taken punch. */
  impactLogRef?: React.RefObject<ImpactLog>;
  /** The remote player's live pose, when the opponent is a person. */
  remotePoseRef?: React.RefObject<PoseFrame | null>;
  /**
   * Gaps between pose samples, from usePoseTracking. When pose tracking is
   * being starved the view gives up render resolution to it, because the pose
   * rate decides how closely the character follows the player.
   */
  poseIntervalStats?: RollingStats;
  /** Pose inference times, from usePoseTracking. Used with the above to tell
   *  a GPU-starved pose stream from a camera-limited one. */
  poseInferenceStats?: RollingStats;
}

export function BoxerModel({
  appearance = DEFAULT_APPEARANCE,
  wardrobe = false,
  poseRef,
  samplePose,
  view = "behind",
  onStatusChange,
  onDebug,
  recentreSignal = 0,
  showTarget = false,
  fps = false,
  lineLockedRef,
  strikeQueueRef,
  onTargetDebug,
  dummy = false,
  litRef,
  outcomeQueueRef,
  opponentRef,
  opponentThrowQueueRef,
  opponentStrikeQueueRef,
  bodyOutRef,
  stage = null,
  fightEventQueueRef,
  phaseRef,
  conditionRef,
  impactLogRef,
  poseIntervalStats,
  poseInferenceStats,
  remotePoseRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wardrobeCamera = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Read inside the render loop without re-running the effect.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Bumped when the view changes, so the render loop can re-place the camera
  // on the other side without tearing down and reloading the model.
  const viewDirtyRef = useRef(0);
  useEffect(() => {
    viewDirtyRef.current++;
  }, [view]);
  // Mirrored into a ref like every other prop the render loop reads, so
  // supplying it never tears down and reloads the model.
  const sampleRef = useRef(samplePose);
  sampleRef.current = samplePose;
  const statusCbRef = useRef(onStatusChange);
  statusCbRef.current = onStatusChange;
  const debugCbRef = useRef(onDebug);
  debugCbRef.current = onDebug;
  const targetDebugCbRef = useRef(onTargetDebug);
  targetDebugCbRef.current = onTargetDebug;
  const showTargetRef = useRef(showTarget);
  showTargetRef.current = showTarget;
  const lineLockedHolder = useRef(lineLockedRef);
  lineLockedHolder.current = lineLockedRef;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  // Mirrored into a ref like every other prop this effect reads, so changing
  // it never tears down and reloads the model.
  const strikeQueueHolder = useRef(strikeQueueRef);
  strikeQueueHolder.current = strikeQueueRef;
  const litHolder = useRef(litRef);
  litHolder.current = litRef;
  const outcomeHolder = useRef(outcomeQueueRef);
  outcomeHolder.current = outcomeQueueRef;
  const opponentHolder = useRef(opponentRef);
  opponentHolder.current = opponentRef;
  const opponentStrikeHolder = useRef(opponentStrikeQueueRef);
  opponentStrikeHolder.current = opponentStrikeQueueRef;
  const opponentThrowHolder = useRef(opponentThrowQueueRef);
  opponentThrowHolder.current = opponentThrowQueueRef;
  const bodyOutHolder = useRef(bodyOutRef);
  bodyOutHolder.current = bodyOutRef;
  const fightEventHolder = useRef(fightEventQueueRef);
  fightEventHolder.current = fightEventQueueRef;
  const phaseHolder = useRef(phaseRef);
  phaseHolder.current = phaseRef;
  const conditionHolder = useRef(conditionRef);
  conditionHolder.current = conditionRef;
  const impactHolder = useRef(impactLogRef);
  impactHolder.current = impactLogRef;
  const poseIntervalHolder = useRef(poseIntervalStats);
  poseIntervalHolder.current = poseIntervalStats;
  const inferenceHolder = useRef(poseInferenceStats);
  inferenceHolder.current = poseInferenceStats;
  const remotePoseHolder = useRef(remotePoseRef);
  remotePoseHolder.current = remotePoseRef;
  // Read inside the setup effect, like `dummy`: it decides what drives the
  // second figure, which is not something that can be swapped mid-scene.
  const versusRef = useRef(!!remotePoseRef);
  versusRef.current = !!remotePoseRef;
  // Read inside the setup effect. Changing it rebuilds the scene, which is
  // correct - it is a different object standing there.
  const dummyRef = useRef(dummy);
  dummyRef.current = dummy;
  const driverRef = useRef<RigDriver | null>(null);
  const targetRef = useRef<TrainingTarget | null>(null);

  useEffect(() => {
    if (recentreSignal > 0) {
      driverRef.current?.recentre();
      targetRef.current?.resetScore();
    }
  }, [recentreSignal]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    // Camera kick state (see the hit-feedback block in tick()).
    let lastImpactSeq = impactHolder.current?.current?.since(0).at(-1)?.seq ?? 0;
    let shake: { amplitude: number; duration: number; start: number; seed: number } | null = null;
    /** Hit-stop and the slow-motion knockdown. See TimeWarp: render time
     *  only, and never applied to the player's own figure. */
    const warp = new TimeWarp();
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    let rafId = 0;

    const scene = new THREE.Scene();
    if (!wardrobe) scene.background = new THREE.Color(stage ? 0x05070a : 0x0b0f14);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    const demo = isDemoMode();
    const renderer = new THREE.WebGLRenderer({
      // Off everywhere: multisample anti-aliasing is a full-screen cost every
      // frame, paid on the same GPU as pose tracking, and gameplay feeling
      // responsive matters far more than smooth edges. (?demo already did this.)
      antialias: demo ? DEMO_PRESET.antialias : false,
      alpha: wardrobe,
    });
    // Required for the punching dummy: the character figure used as its body
    // is clipped off below the belt by a per-material plane. Without this the
    // plane is simply ignored and the dummy grows a full pair of legs inside
    // its own stand.
    renderer.localClippingEnabled = true;
    if (stage) {
      // A fight arena is a high-dynamic-range subject: blown-out truss spots
      // over near-black surroundings. Without tone mapping the canvas clips to
      // flat white under the key light and the cage crushes to solid black
      // everywhere else. Same settings ArenaView uses, so the venue looks the
      // same in a fight as it does in the picker that sold it.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      // One shadow-casting light, and the two fighters are the only casters -
      // see buildArenaLighting. A fighter with no contact shadow reads as
      // hovering above the canvas no matter how well their feet are planted,
      // which would have quietly undone the whole footwork pass.
      // ?demo turns shadows off: an extra pass of the fighters every frame,
      // on the GPU pose inference needs (see config/demoMode.ts).
      renderer.shadowMap.enabled = !demo || DEMO_PRESET.shadows;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    // Capped below the device ratio on purpose. This scene shares an
    // integrated GPU with pose inference - the app's actual bottleneck - so
    // pixels spent here are taken from the thing that matters. It drops
    // further under load; see the adaptive block in tick().
    let pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setPixelRatio(pixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;

    // --- The venue --------------------------------------------------------
    //
    // Centred on the midpoint of the two fighters, not on the player. The
    // player stands at the origin and the opponent at TARGET_CONFIG.distance,
    // so a cage built at the origin would put the player dead centre and the
    // opponent halfway to the fence.
    const venue =
      stage === "ring"
        ? buildRing()
        : stage === "octagon"
          ? buildOctagon({ fencing: true })
          : null;
    let arenaRadius = FALLBACK_ARENA_RADIUS;
    let arenaLighting: { group: THREE.Group; dispose(): void } | null = null;
    let hallFloor: THREE.Mesh | null = null;
    let crowd: Crowd | null = null;
    if (venue) {
      arenaRadius = "radius" in venue ? venue.radius : platformHalfSpan();
      venue.group.position.z = TARGET_CONFIG.distance / 2;
      venue.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.receiveShadow = true;
      });
      scene.add(venue.group);

      arenaLighting = buildArenaLighting(arenaRadius);
      arenaLighting.group.position.z = TARGET_CONFIG.distance / 2;
      scene.add(arenaLighting.group);

      // The hall floor the platform stands on, so the platform legs end in
      // something rather than in nothing.
      const floorGeo = new THREE.PlaneGeometry(120, 120);
      const floorMat = new THREE.MeshStandardMaterial({
        map: artTexture("concrete", 30),
        color: 0x555963,
        roughness: 0.82,
        metalness: 0.15,
      });
      hallFloor = new THREE.Mesh(floorGeo, floorMat);
      hallFloor.rotation.x = -Math.PI / 2;
      hallFloor.position.set(0, -(stage === "ring" ? RING.platformHeight : OCTAGON.platformHeight), TARGET_CONFIG.distance / 2);
      hallFloor.receiveShadow = true;
      scene.add(hallFloor);

      // The people in the dark around it. Left out under ?demo.
      if (!demo || DEMO_PRESET.crowd) {
        crowd = buildCrowd(arenaRadius, hallFloor.position.y, !reduceMotion);
        crowd.group.position.z = TARGET_CONFIG.distance / 2;
        scene.add(crowd.group);
      }

      // Everything past the far fence falls away into black, so the cage reads
      // as standing in a dark hall rather than floating.
      const span = stage === "ring" ? platformHalfSpan() * 2 : OCTAGON.acrossFlats;
      scene.fog = new THREE.Fog(0x05070a, span * 1.05, span * 4.8);
    }

    const bloodDecals = venue ? buildBloodDecals() : null;
    if (bloodDecals) scene.add(bloodDecals.group);
    const trainingRoom = !venue && dummy ? buildTrainingRoom(TARGET_CONFIG.distance / 2) : null;
    if (trainingRoom) scene.add(trainingRoom.group);

    // The figure lighting. Dimmed hard under a venue, because the arena brings
    // its own truss and doubling the two gives a flat, evenly lit fighter with
    // none of the shape a fight camera sees. Kept rather than removed: `key`
    // and `rim` follow the camera in placeCamera(), and without something
    // doing that a fighter in the rear view is a silhouette.
    const figureLight = venue ? 0.22 : wardrobe ? 1.26 : 1;
    scene.add(
      new THREE.HemisphereLight(0xcfe3ff, 0x1a1d24, 2.0 * figureLight)
    );
    const key = new THREE.DirectionalLight(wardrobe ? 0xffe8cf : 0xffffff, 2.2 * figureLight);
    key.position.set(1.5, 2.5, 2.0);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ab4ff, 0.8 * figureLight);
    rim.position.set(-2, 1.5, -1.5);
    scene.add(rim);

    // Set once the model loads; until then there is nothing to frame.
    let opponentRoot: THREE.Object3D | null = null;
    let opponentAnim: OpponentAnimator | null = null;
    /** Set instead of `opponentAnim` when the opponent is a networked person.
     *  See the versus branch below. */
    let remoteDriver: RigDriver | null = null;
    let punchingDummy: PunchingDummy | null = null;
    let playerRoot: THREE.Object3D | null = null;
    let playerSkin: BodyTexture | null = null;
    let targetSkin: BodyTexture | null = null;
    // Facial damage per figure, keyed by the figure root so the target's
    // swelling can never be applied to the player's face.
    const faces = new Map<THREE.Object3D, FaceDamage>();
    let frameTarget: THREE.Vector3 | null = null;
    // --- The camera director -------------------------------------------------
    //
    // It does not run the gameplay camera. Shadow Box is played by standing in
    // front of a webcam, and the shot that makes that work is the
    // over-the-shoulder one derived from the measured figure just below - the
    // one where the player's own right hand is on the right of the screen. A
    // swing to a side-on broadcast angle mid-round would leave someone
    // throwing real punches unable to find their opponent.
    let director: FightCamera | null = null;
    let directorOwns = false;
    let lastPhase: FightPhase | undefined;
    /** Which fighter the current cut is about, if either. See subjectOf. */
    let dirSubject: "player" | "opponent" | null = null;
    const houseShot: CameraPose = {
      position: { x: 0, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      fov: 35,
    };
    // Annotated, not inferred: TARGET_CONFIG is `as const`, so an inferred
    // shape would pin `opponent.z` to the literal 0.788 and refuse every
    // subsequent write from the live scene.
    const dirInput: DirectorInput = {
      player: { x: 0, y: 0, z: 0 },
      opponent: { x: 0, y: 0, z: TARGET_CONFIG.distance },
      radius: arenaRadius,
    };
    /** Derived once the player's figure is measured. See overShoulderLateral. */
    let overShoulder = OVER_SHOULDER.minLateral;
    let frameHeight = 1;
    let baseFrameHeight = 1;
    let frameWidth = 1;
    // Once the viewer has orbited or zoomed, stop re-framing on resize -
    // silently yanking the camera back would fight them.
    let userAdjusted = false;
    controls.addEventListener("start", () => {
      userAdjusted = true;
      dragging = true;
    });
    controls.addEventListener("end", () => {
      dragging = false;
    });
    /** Yaw the camera rig has been turned by to follow the opponent. See
     *  followOpponent. Zeroed whenever placeCamera re-places from scratch. */
    let followYaw = 0;
    let dragging = false;

    /**
     * Places the camera square-on to the character, on the side the current
     * view calls for, and re-frames.
     */
    const placeCamera = () => {
      if (!frameTarget) return;
      const side = VIEW_MODES[viewRef.current].cameraSide;
      // Something standing opposite changes the shot completely - see
      // OVER_SHOULDER. Without this the player occludes their own opponent.
      const duel = showTargetRef.current || dummyRef.current;
      controls.target.set(
        frameTarget.x,
        frameTarget.y,
        frameTarget.z + (duel ? TARGET_CONFIG.distance * OVER_SHOULDER.aim : 0)
      );
      camera.position.set(
        frameTarget.x + (duel ? overShoulder * side : wardrobe ? 0.42 : 0),
        frameTarget.y + (duel ? OVER_SHOULDER.rise : 0),
        frameTarget.z + side
      );
      // Key light follows the camera, otherwise switching to the rear view
      // leaves the boxer lit entirely from behind and reading as a silhouette.
      key.position.set(1.5, 2.5, 2.0 * VIEW_MODES[viewRef.current].cameraSide);
      rim.position.set(-2, 1.5, -1.5 * VIEW_MODES[viewRef.current].cameraSide);
      userAdjusted = false;
      followYaw = 0;
      fitCamera();
    };

    const fitCamera = () => {
      // Refused while the director holds the camera. A resize or a view change
      // during a knockdown replay would otherwise yank the camera back to the
      // gameplay framing halfway through the shot, which looks exactly like
      // the renderer crashing and recovering.
      if (!frameTarget || directorOwns) return;
      const vFov = (camera.fov * Math.PI) / 180;
      const distForHeight = frameHeight / 2 / Math.tan(vFov / 2);
      // Horizontal fit matters on narrow/portrait viewports: framing on height
      // alone crops the arms off the sides exactly when they extend, which is
      // the motion worth seeing.
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const distForWidth = frameWidth / 2 / Math.tan(hFov / 2);
      const dist = Math.max(distForHeight, distForWidth) * FRAME_MARGIN;

      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
      dir.normalize();
      controls.target.copy(frameTarget);
      camera.position.copy(frameTarget).addScaledVector(dir, dist);
      controls.update();
    };

    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userAdjusted) fitCamera();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    /** Paints a figure and returns its damage surface. */
    /** Gives one figure its own kit materials, in its own corner's colour. */
    const gloveGrain = artTexture("glove-grain", 3);
    const trunksGrain = artTexture("shorts-weave", 4);
    const skinGrain = artTexture("skin-grain", 2);
    const hairGrain = artTexture("hair-grain");
    const matteGlove = appearance.finish === "matte" ? artTexture("kit-matte", 3) : null;
    const ribbedTrunks = appearance.finish === "matte" ? artTexture("kit-ribbed", 4) : null;
    const croppedHair = appearance.hair === "crop" ? artTexture("hair-crop") : null;
    for (const grain of [gloveGrain, trunksGrain, skinGrain, matteGlove, ribbedTrunks]) {
      if (grain) {
        grain.colorSpace = THREE.NoColorSpace;
        grain.flipY = false;
      }
    }
    const selectedColour = FIGHTER_OPTIONS.colour.find(option => option.id === appearance.colour)?.colour ?? KIT.player.glove;
    const playerKit = {
      skin: FIGHTER_OPTIONS.skin.find(option => option.id === appearance.skin)?.colour ?? KIT.player.skin,
      hair: KIT.player.hair,
      glove: selectedColour,
      trunks: appearance.colour === "red" ? KIT.player.trunks : `#${new THREE.Color(selectedColour).multiplyScalar(0.67).getHexString()}`,
      boots: appearance.colour === "red" ? KIT.player.boots : `#${new THREE.Color(selectedColour).multiplyScalar(0.42).getHexString()}`,
    };
    const opponentKit = appearance.colour === "blue"
      ? { ...KIT.target, glove: KIT.player.glove, trunks: KIT.player.trunks, boots: KIT.player.boots }
      : KIT.target;
    const tintKit = (
      figure: THREE.Object3D,
      kit: Record<"glove" | "trunks" | "boots", string>,
      retired: Set<THREE.Material>,
      matte = false,
      trim: KitTrim = { laces: "#ded9e6", soles: "#171d2a", wraps: "#343a5d" },
    ) => {
      figure.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const slot = KIT_MESH_COLOUR[obj.name];
        if (!slot) return;
        const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of old) if (m) retired.add(m);
        const detail = slot === "trunks" ? (matte ? ribbedTrunks : trunksGrain) : (matte ? matteGlove : gloveGrain);
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(kit[slot]),
          bumpMap: mesh.geometry.hasAttribute("uv") ? detail : null,
          bumpScale: slot === "trunks" ? 0.005 : 0.006,
          roughness: matte ? Math.min(0.95, KIT_ROUGHNESS[slot] + 0.22) : KIT_ROUGHNESS[slot],
          metalness: 0,
        });
        styleKitDetail(material, mesh.geometry, slot, trim, obj.name.endsWith("_R"));
        mesh.material = material;
      });
    };

    const textureFigure = (
      figure: THREE.Object3D,
      kit: BodyTextureOptions,
      /** Materials replaced along the way. Collected rather than disposed on
       * the spot: the clone shares the original material by reference, so
       * disposing it while texturing the first figure would pull it out from
       * under the second, which still points at it. */
      retired: Set<THREE.Material>,
      hair = hairGrain,
      hairStyle: FighterAppearance["hair"] = "buzz",
      iris = "#654430",
    ): BodyTexture | null => {
      // The body, not whichever skinned mesh traversal happens to end on.
      // The figure now carries eyeballs too, and texturing one of those would
      // paint the body atlas onto an eye and leave the body grey.
      const mesh = findBodyMesh(figure);
      if (!mesh) return null;

      const boneNames = mesh.skeleton.bones.map((b) => b.name);
      const dominant = dominantBones(mesh.geometry);
      const uvMap = buildBodyUvMap(mesh.geometry, boneNames, dominant);
      const body = buildBodyTexture(mesh.geometry, uvMap, kit);
      if (!body) return null;

      // No `skinning` flag: it was removed from materials in three r151 and is
      // now inferred from the mesh being a SkinnedMesh. Setting it does
      // nothing but suggest to a reader that it is doing something.
      const material = new THREE.MeshStandardMaterial({
        map: body.map,
        bumpMap: skinGrain,
        bumpScale: 0.002,
        roughness: 0.78,
        metalness: 0.0,
      });
      const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of old) if (m) retired.add(m);
      mesh.material = material;

      // Facial damage, painted as an overlay on the same texture.
      // Registered here rather than composited separately because the body
      // texture rebuilds from a clean base on every repaint - anything drawn
      // outside that cycle is wiped on the next bruise tick.
      const bindPos = (name: string): THREE.Vector3 | null => {
        const i = boneNames.indexOf(name);
        if (i < 0) return null;
        return new THREE.Vector3().setFromMatrixPosition(
          mesh.skeleton.boneInverses[i].clone().invert()
        );
      };
      const eyeL = bindPos("l_eye");
      const eyeR = bindPos("r_eye");
      const eyes = eyeL && eyeR ? { left: eyeL, right: eyeR } : null;
      if (hair && kit.hair) {
        const openEyes = eyes !== null && textureEyes(figure, iris, retired);
        applyHeadDetail(material, mesh.geometry, dominant, boneNames, hair, kit.hair, hairStyle, eyes, openEyes);
      }

      const features = locateFaceFeatures(
        mesh.geometry,
        boneNames,
        dominant,
        eyes
      );
      if (features) {
        const painter = createFacePainter({
          features,
          canvas: body.canvas,
          mask: headIslandMask(mesh.geometry, boneNames, dominant, body.canvas.width),
        });
        if (painter) {
          const damage = new FaceDamage({
            root: figure,
            onChanged: () => body.markDirty(),
          });
          body.setOverlay(() => painter.render(damage.damage));
          faces.set(figure, damage);
        }
      }
      return body;
    };

    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      (gltf) => {
        if (cancelled) return;
        const model = gltf.scene;
        playerRoot = model;
        scene.add(model);
        // The fighters are the only shadow casters in the scene - see the
        // shadowMap block above. A skinned mesh needs this on the mesh itself,
        // not on the root, so it is set by traversal.
        if (venue) castShadows(model);

        // A SkinnedMesh is culled against its bind-pose bounds. Once bones are
        // driven away from bind, the real silhouette leaves that volume and
        // the whole character can blink out of existence at certain angles.
        model.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
        });

        try {
          driverRef.current = new RigDriver(model);

          // The second humanoid. Same asset, cloned - a second download and a
          // second set of bind data would buy nothing while the only question
          // is whether hits register and read correctly.
          const opponent = cloneSkinned(model);
          opponent.traverse((o) => {
            const mesh = o as THREE.SkinnedMesh;
            if (mesh.isSkinnedMesh) mesh.frustumCulled = false;
          });
          // Clone first, then texture each figure separately - cloning after
          // texturing would copy the player's material reference and the two
          // would share one map, so bruises on the target would appear on the
          // player as well.
          const retired = new Set<THREE.Material>();
          playerSkin = textureFigure(model, playerKit, retired, croppedHair ?? hairGrain, appearance.hair);
          targetSkin = textureFigure(opponent, opponentKit, retired, hairGrain, "buzz", "#513629");
          tintKit(model, playerKit, retired, appearance.finish === "matte", {
            laces: trimColour(appearance.laces),
            soles: trimColour(appearance.soles),
            wraps: trimColour(appearance.wraps),
          });
          tintKit(opponent, opponentKit, retired);
          for (const m of retired) m.dispose();

          // No guard on the dummy: a dummy standing in a boxer's guard reads
          // as an opponent about to throw, and the player waits for a punch
          // that never comes. The reaction machinery is kept either way.
          targetRef.current = new TrainingTarget(opponent, {
            guard: !dummyRef.current,
            // The stand's spring is the dummy's whole-body reaction; a second
            // one would double it, and would push the wrong way besides.
            knockback: dummyRef.current ? 0 : 1,
          });
          // Turned to face the player's boxer, which faces +Z.
          opponent.rotation.y = Math.PI;

          if (dummyRef.current) {
            // Anchored on the player's belt line, so the dummy's targets sit at
            // the heights the strike resolver reports them at. Derived from the
            // model's own placement rather than assumed to be the origin.
            punchingDummy = new PunchingDummy({
              beltHeight: model.position.y + RENDER_CONFIG.rigHipWorldHeight,
              body: "figure",
            });
            scene.add(punchingDummy.group);

            // The character is the dummy's body. Three things have to happen
            // to it, and all three are reversible cosmetics - nothing here
            // touches the rig or the hit map.
            for (const mesh of opponent.children.concat(
              ...opponent.children.map((c) => c.children)
            )) {
              if (KIT_MESH_COLOUR[mesh.name]) mesh.visible = false;
            }
            opponent.traverse((o) => {
              if (KIT_MESH_COLOUR[o.name]) o.visible = false;
            });

            // 2. Everything below the belt is clipped away and hidden inside
            //    the stand's collar. Clipping rather than deleting geometry,
            //    because the legs are part of one skinned mesh and cutting
            //    them out of the buffer would break the skin weights.
            opponent.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh || !mesh.material) return;
              const mats = Array.isArray(mesh.material)
                ? mesh.material
                : [mesh.material];
              for (const mat of mats) {
                mat.clippingPlanes = [punchingDummy!.clipPlane];
                mat.clipShadows = true;
                mat.needsUpdate = true;
              }
            });

            // 3. It is parented into the spring, so it rocks with the stand
            //    rather than standing beside it. The local offset puts the
            //    figure's own origin back where it would have been in world
            //    space, since the pivot sits at the cut line.
            punchingDummy.pivot.add(opponent);
            // setHome, not position.set: `update` rewrites root.position from
            // homePosition every frame, so a figure merely positioned here
            // would snap to the pivot origin on the very next frame.
            targetRef.current.setHome(
              new THREE.Vector3(0, model.position.y - punchingDummy.cutHeight, 0)
            );
            // Already turned to face the player; the dummy group is turned as
            // well, so that rotation has to come back off or the two compose
            // and the figure faces away.
            opponent.rotation.y = 0;
            opponent.visible = true;
            opponent.updateMatrixWorld(true);

            // Markers go onto the character's surface, not the moulded spec's.
            // Where the character is thicker, a marker at the spec depth is
            // buried inside the chest - invisible, and silent about it.
            punchingDummy.projectMarkersOnto(opponent);
          } else if (versusRef.current) {
            // A person is standing there.
            targetRef.current = null;
            opponent.position.set(0, model.position.y, TARGET_CONFIG.distance);
            opponent.visible = true;
            scene.add(opponent);
            // Constructed after the placement above, because RigDriver
            // captures the figure's position and yaw as its home - a driver
            // built at the origin would spend the fight trying to return there.
            remoteDriver = new RigDriver(opponent);
          } else {
            targetRef.current.setHome(
              new THREE.Vector3(0, model.position.y, TARGET_CONFIG.distance)
            );
            opponent.visible = showTargetRef.current;
            // Under a pivot, not straight into the scene. The animator moves
            // the pivot for footwork while TrainingTarget keeps rewriting
            // `opponent.position` for knockback, so the two compose instead of
            // overwriting each other every frame. See opponentAnimator.ts.
            opponentAnim = new OpponentAnimator(opponent);
            opponentAnim.pivot.add(opponent);
            scene.add(opponentAnim.pivot);
          }
          opponentRoot = opponent;
          if (venue) castShadows(opponent);
          opponent.updateMatrixWorld(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMsg(msg);
          setStatus("error");
          statusCbRef.current?.("error", msg);
          return;
        }

        // Frame from the model's real bounds rather than guessed numbers - the
        // previous hardcoded camera cropped the head and feet.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        if (wardrobe) {
          const stand = new THREE.Mesh(
            new THREE.CylinderGeometry(size.y * 0.29, size.y * 0.31, 0.06, 48),
            new THREE.MeshStandardMaterial({ color: 0x242c36, roughness: 0.88 })
          );
          stand.position.set(center.x, box.min.y - 0.037, center.z);
          scene.add(stand);
        }

        frameHeight = size.y * (wardrobe ? 1.1 : FRAME_FROM_HEIGHT);
        // Allow for arms thrown wide - the bind-pose bounding box is measured
        // with the arms down, so its width understates the real silhouette.
        frameWidth = size.x * (wardrobe ? 1.05 : 1.25);
        frameTarget = new THREE.Vector3(
          center.x,
          box.max.y - frameHeight / 2,
          center.z
        );
        baseFrameHeight = frameHeight;
        // Widen here as well as on the transition below. The transition only
        // fires when the duel flag changes, and it is already true by the time
        // the model finishes loading - the component mounts with the mode
        // already chosen. So entering a fight directly, which is the only way
        // anyone enters one, framed the shot for a single figure and the two
        // fighters filled the screen on top of each other.
        if (showTargetRef.current || dummyRef.current) {
          // Both axes. `fitCamera` takes whichever of the two needs the camera
          // further back, and the width is derived from the T-pose armspan -
          // which is wide enough that it always wins. Widening only the height
          // therefore changed the number and not the shot.
          frameHeight = baseFrameHeight * OVER_SHOULDER.widen;
          frameWidth *= OVER_SHOULDER.widen;
        }

        // Measured off the rig, not off the bounding box. The box is taken in
        // the bind pose, which is a T-pose, so `size.x` is the armspan - about
        // three times the width that actually occludes anything. Using it
        // would have swung the camera out to the side of the ring.
        const lShoulder = model.getObjectByName("l_uparm");
        const rShoulder = model.getObjectByName("r_uparm");
        let shoulderHalf = size.z / 2;
        if (lShoulder && rShoulder) {
          const a = lShoulder.getWorldPosition(new THREE.Vector3());
          const b = rShoulder.getWorldPosition(new THREE.Vector3());
          shoulderHalf = Math.abs(a.x - b.x) / 2;
        }
        overShoulder = overShoulderLateral(shoulderHalf, box.max.z - center.z);

        // Start square-on to the character; the viewer can orbit from there.
        placeCamera();
        if (wardrobe && wardrobeCamera.current) {
          camera.position.copy(wardrobeCamera.current.position);
          controls.target.copy(wardrobeCamera.current.target);
          userAdjusted = true;
          controls.update();
        }

        setStatus("ready");
        statusCbRef.current?.("ready");
      },
      undefined,
      (err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setStatus("error");
        statusCbRef.current?.("error", msg);
      }
    );

    /** Where the fighters actually are, read off the scene rather than assumed. */
    const readDirectorInput = () => {
      if (playerRoot) {
        playerRoot.getWorldPosition(_dirPos);
        dirInput.player.x = _dirPos.x;
        dirInput.player.y = _dirPos.y;
        dirInput.player.z = _dirPos.z;
      }
      if (opponentRoot) {
        opponentRoot.getWorldPosition(_dirPos);
        dirInput.opponent.x = _dirPos.x;
        dirInput.opponent.y = _dirPos.y;
        dirInput.opponent.z = _dirPos.z;
      }
      dirInput.radius = arenaRadius;
      dirInput.subject =
        dirSubject === "player"
          ? dirInput.player
          : dirSubject === "opponent"
            ? dirInput.opponent
            : undefined;
      return dirInput;
    };

    /** Which shot a given moment of the fight deserves. */
    const shotFor = (e: FightEvent): ShotName | null => {
      switch (e.type) {
        // Low and close, looking up: the angle that makes a downed fighter
        // read as downed rather than just short.
        case "knockdown":
          return "lowAngle";
        case "roundEnd":
          return "corner";
        case "stoppage":
          return "lowAngle";
        case "decision":
          return "decision";
        default:
          return null;
      }
    };

    /** Who a cut is about, in the director's own terms. */
    const subjectOf = (e: FightEvent): "player" | "opponent" | null => {
      if (e.type === "knockdown") return e.target === "player" ? "player" : "opponent";
      // A stoppage is about whoever lost it.
      if (e.type === "stoppage") return e.winner === "player" ? "opponent" : "player";
      return null;
    };

    const stepDirector = (dt: number) => {
      const events = fightEventHolder.current?.current;
      const phase = phaseHolder.current?.current;
      // No fight running means no director. The dummy and the tracking screens
      // get the plain gameplay camera and nothing borrows it.
      if (!playerRoot || (!events && phase === undefined)) return;

      const input = readDirectorInput();
      if (!director) director = new FightCamera(input);
      director.setLive(phase === "fighting");

      if (events && events.length > 0) {
        for (const e of events.splice(0, events.length)) {
          // A knockdown plays out in slow motion while the director cuts to
          // it - the moment the fight turns, given time to land.
          if (e.type === "knockdown") crowd?.burst();
          if (e.type === "knockdown" && !reduceMotion) {
            warp.slowMotion(performance.now(), KNOCKDOWN_ANIM.slowMotionSeconds, KNOCKDOWN_ANIM.slowMotionRate);
          }
          const shot = shotFor(e);
          if (!shot) continue;
          director.cut(shot, true);
          // Held for the life of the shot, so one that outlives the event it
          // was cut for stays pointed at what it was cut for.
          dirSubject = subjectOf(e);
        }
      }
      // Cleared once the director is back on the house shot, or the next cut
      // would inherit a subject from the last one.
      if (!director.cinematic) dirSubject = null;
      if (phase !== lastPhase) {
        // The bell for a new round ends whatever the break was showing, on the
        // frame it rings rather than whenever the corner shot's hold expires.
        if (phase === "fighting") director.cut("broadcast", true);
        lastPhase = phase;
      }

      if (!directorOwns) {
        // Track the live gameplay camera. Doing this every frame rather than
        // snapshotting at the moment of a cut is what makes an orbit the
        // player performed mid-round survive the knockdown that follows.
        houseShot.position.x = camera.position.x;
        houseShot.position.y = camera.position.y;
        houseShot.position.z = camera.position.z;
        houseShot.target.x = controls.target.x;
        houseShot.target.y = controls.target.y;
        houseShot.target.z = controls.target.z;
        houseShot.fov = camera.fov;
        // Parked on the house shot while it is not in charge, so a cut starts
        // from where the camera actually is instead of from wherever it was
        // left standing at the end of the last one.
        director.snap(input);
      }
      director.setHouseShot(houseShot);
      director.update(dt, input);

      if (!directorOwns && director.cinematic) {
        directorOwns = true;
        // Orbiting during a cinematic shot would be two things driving one
        // camera. Control comes back the moment the shot has eased home.
        controls.enabled = false;
      }
      if (!directorOwns) return;

      const p = director.pose;
      camera.position.set(p.position.x, p.position.y, p.position.z);
      controls.target.set(p.target.x, p.target.y, p.target.z);
      if (Math.abs(camera.fov - p.fov) > 1e-3) {
        camera.fov = p.fov;
        camera.updateProjectionMatrix();
      }
      if (!director.cinematic && director.settleError(input) < DIRECTOR_CONFIG.handBack) {
        directorOwns = false;
        controls.enabled = true;
      }
    };

    /**
     * Turns the camera rig about the player so it stays behind them on the
     * line to the opponent.
     */
    const followOpponent = (dt: number) => {
      const duel = showTargetRef.current || dummyRef.current;
      if (!duel || directorOwns || dragging || !playerRoot || !opponentRoot?.visible) return;
      playerRoot.getWorldPosition(_dirPos);
      const px = _dirPos.x;
      const pz = _dirPos.z;
      opponentRoot.getWorldPosition(_dirPos);
      const dz = _dirPos.z - pz;
      if (dz < 0.05) return;
      const want = THREE.MathUtils.clamp(
        Math.atan2(_dirPos.x - px, dz),
        -FOLLOW_CAM.maxYaw,
        FOLLOW_CAM.maxYaw
      );
      const next = followYaw + (want - followYaw) * (1 - Math.exp(-FOLLOW_CAM.ease * dt));
      const d = next - followYaw;
      followYaw = next;
      if (Math.abs(d) < 1e-6) return;
      const c = Math.cos(d);
      const s = Math.sin(d);
      for (const v of [camera.position, controls.target]) {
        const x = v.x - px;
        const z = v.z - pz;
        v.x = px + x * c + z * s;
        v.z = pz - x * s + z * c;
      }
    };

    // --- Fight cameras -----------------------------------------------------
    //
    // First person rides at the player's eyes. The head bone is collapsed while
    // it does, because from inside the head the mouth and eye sockets face the
    // camera. It is restored whenever anything else holds the camera. Third
    // person rides just behind the head with the player's fighter see-through.
    const BASE_FOV = camera.fov;
    let fpsActive = false;
    let fpsScanAt = -Infinity;
    let fpsCam: FpsPose | null = null;
    let fpsFirst: boolean | null = null;
    let playerEyes: [THREE.Object3D, THREE.Object3D] | null = null;
    let playerHead: THREE.Object3D | null = null;
    let opponentHead: THREE.Object3D | null = null;
    const _head = new THREE.Vector3();
    const _eyeR = new THREE.Vector3();
    const _oppHead = new THREE.Vector3();
    let fpsRoll = 0;
    // The opponent's glove materials, swapped for clones that can glow during
    // a wind-up without lighting the player's gloves (the figures share materials).
    const glowOriginals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const glowing = new WeakSet<THREE.Material>();
    const glowMats = new Set<THREE.MeshStandardMaterial>();
    const glowColor = new THREE.Color(FPS_CAMERA.windupGlow);

    /** Lights the opponent's gloves with their wind-up, 0-1. `null` restores them.
     *  Rescanned because the kit tint swaps glove materials after load. */
    const syncGlow = (windup: number | null, rescan = true) => {
      if (windup === null) {
        for (const [mesh, orig] of glowOriginals) mesh.material = orig;
        glowOriginals.clear();
        glowMats.forEach((m) => m.dispose());
        glowMats.clear();
        return;
      }
      if (!opponentRoot) return;
      if (rescan) opponentRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !isGlove([mesh.name, mesh.parent?.name ?? ""])) return;
        const mat = mesh.material;
        const mats = Array.isArray(mat) ? mat : [mat];
        if (mats.every((x) => glowing.has(x))) return;
        const clone = (m: THREE.Material) => {
          if (glowing.has(m)) return m;
          const c = m.clone();
          c.onBeforeCompile = m.onBeforeCompile;
          c.customProgramCacheKey = m.customProgramCacheKey;
          glowing.add(c);
          if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            glowMats.add(c as THREE.MeshStandardMaterial);
          }
          return c;
        };
        glowOriginals.set(mesh, mat);
        mesh.material = Array.isArray(mat) ? mat.map(clone) : clone(mat);
      });
      // Eased in, brightest just before the punch leaves.
      const k = Math.max(0, Math.min(1, windup)) ** 1.5 * 1.4;
      for (const m of glowMats) m.emissive.copy(glowColor).multiplyScalar(k);
    };

    // The player's materials are cloned before fading: the opponent is a clone
    // of the same asset and shares material objects with it.
    const ghostOriginals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    const ghosted = new WeakSet<THREE.Material>();
    const ghostMaterial = (m: THREE.Material): THREE.Material => {
      if (ghosted.has(m)) return m;
      // Lambert: the faded body covers much of the screen over the opponent,
      // and at this opacity a standard material's specular detail is invisible.
      // Same texture and colour, so bruises still show.
      const src = m as THREE.MeshStandardMaterial;
      const g = new THREE.MeshLambertMaterial({
        map: src.map ?? null,
        color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
        side: m.side,
        transparent: true,
        opacity: SHOULDER_CAMERA.playerOpacity,
        // Otherwise the body hides its own far half in patches.
        depthWrite: false,
      });
      ghosted.add(g);
      return g;
    };

    /** Fades the player's fighter, gloves excepted, or restores it. Rescanned
     *  because skins and appearance changes swap materials after load. */
    const syncGhost = (on: boolean, rescan = true) => {
      if (!playerRoot) return;
      if (!on) {
        for (const [mesh, orig] of ghostOriginals) {
          const now = mesh.material;
          (Array.isArray(now) ? now : [now]).forEach((x) => ghosted.has(x) && x.dispose());
          mesh.material = orig;
        }
        ghostOriginals.clear();
        return;
      }
      if (!rescan) return;
      playerRoot.traverse((o) => {
        const mesh = o as THREE.Mesh;
        // Where your fists are is the one thing you must always see.
        if (!mesh.isMesh || isGlove([mesh.name, mesh.parent?.name ?? ""])) return;
        const mat = mesh.material;
        if (Array.isArray(mat) ? mat.every((x) => ghosted.has(x)) : ghosted.has(mat)) return;
        ghostOriginals.set(mesh, mat);
        mesh.material = Array.isArray(mat) ? mat.map(ghostMaterial) : ghostMaterial(mat);
      });
    };

    // The next getWorldPosition or render picks the new scale up.
    const setOwnHead = (shown: boolean) => playerHead?.scale.setScalar(shown ? 1 : 1e-4);

    /** Places the fight camera, at the eyes or behind the head. False when it
     *  can't (no opponent yet, the director holds the camera, no model). */
    const placeFpsCamera = (dt: number, first: boolean): boolean => {
      const duel = showTargetRef.current || dummyRef.current;
      if (!duel || directorOwns || !playerRoot || !opponentRoot?.visible) {
        setOwnHead(true);
        return false;
      }
      if (!playerEyes) {
        const l = playerRoot.getObjectByName("l_eye");
        const r = playerRoot.getObjectByName("r_eye");
        if (l && r) playerEyes = [l, r];
      }
      playerHead ??= playerRoot.getObjectByName("c_head") ?? null;
      opponentHead ??= opponentRoot.getObjectByName("c_head") ?? null;
      if (!playerEyes || !playerHead || !opponentHead) return false;
      // A view switch starts fresh rather than sweeping through the head.
      if (fpsFirst !== first) fpsCam = null;
      fpsFirst = first;
      const cfg = first ? FPS_CAMERA : SHOULDER_CAMERA;
      // Read with the head at full size; first person then collapses it for the render.
      setOwnHead(true);
      if (first) {
        playerEyes[0].getWorldPosition(_head);
        playerEyes[1].getWorldPosition(_eyeR);
        _head.add(_eyeR).multiplyScalar(0.5);
        setOwnHead(false);
      } else {
        playerHead.getWorldPosition(_head);
      }
      opponentHead.getWorldPosition(_oppHead);
      const motion = driverRef.current?.bodyMotion;
      const lean = fpsLean(motion?.tracked ? motion.lateral : 0, cfg);
      // The fighters face each other down one fixed line, so the camera looks
      // straight down it: their slips move them across the frame, the
      // player's own slips move the camera.
      if (lineLockedHolder.current?.current ?? true) _oppHead.x = _head.x;
      const goal = fpsCameraPose(_head, _oppHead, cfg, lean.side);
      fpsCam = fpsCam
        ? {
            position: approach(fpsCam.position, goal.position, dt, cfg.tau),
            target: approach(fpsCam.target, goal.target, dt, cfg.tau),
          }
        : goal;
      camera.position.set(fpsCam.position.x, fpsCam.position.y, fpsCam.position.z);
      controls.target.set(fpsCam.target.x, fpsCam.target.y, fpsCam.target.z);
      camera.lookAt(controls.target);
      fpsRoll += (lean.roll - fpsRoll) * (1 - Math.exp(-dt / cfg.tau));
      camera.rotateZ(-fpsRoll);
      const fov = fpsFov(camera.aspect, cfg);
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      return true;
    };

    const leaveFps = () => {
      fpsActive = false;
      fpsCam = null;
      fpsRoll = 0;
      fpsScanAt = -Infinity;
      fpsFirst = null;
      setOwnHead(true);
      syncGlow(null);
      syncGhost(false);
      controls.enabled = true;
      if (camera.fov !== BASE_FOV) {
        camera.fov = BASE_FOV;
        camera.updateProjectionMatrix();
      }
      placeCamera();
    };

    let lastFrame = performance.now();
    let lastPoseTs = 0;
    let lastDebugPush = 0;
    let lastPoseCheck = 0;
    let lastViewSeen = viewDirtyRef.current;
    let lastTargetShown = showTargetRef.current;
    const governor = new ResolutionGovernor(MIN_PIXEL_RATIO, pixelRatio);

    // Lite: the ?demo speed settings that can change while running -
    // resolution capped at 1x, no shadow pass, no crowd.
    let liteOn = false;
    // Any machine, any fight mode: if the scene is visibly starving pose
    // tracking, the same extras come off for the rest of the session. See
    // slowDetector.ts.
    const slowness = new SlowDetector();
    const shadowsOff: THREE.Mesh[] = [];
    const setLite = (on: boolean) => {
      liteOn = on;
      const r = governor.setCeiling(on ? FPS_CAMERA.phoneMaxPixelRatio : Infinity);
      if (r !== null) {
        pixelRatio = r;
        renderer.setPixelRatio(pixelRatio);
        resize();
      }
      if (crowd) crowd.group.visible = !on;
      if (on) {
        for (const root of [playerRoot, opponentRoot]) {
          root?.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh && m.castShadow) {
              m.castShadow = false;
              shadowsOff.push(m);
            }
          });
        }
      } else {
        shadowsOff.forEach((m) => (m.castShadow = true));
        shadowsOff.length = 0;
      }
      // No casters left, so render the shadow map once (empty) and then stop
      // re-rendering it every frame. Back on when leaving.
      renderer.shadowMap.autoUpdate = !on;
      renderer.shadowMap.needsUpdate = true;
    };

    function tick() {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);

      const now = performance.now();
      // Clamp: a backgrounded tab returns with a huge delta, which would snap
      // the character across the screen in a single frame.
      const rawDt = (now - lastFrame) / 1000;
      const dt = Math.min(rawDt, 0.1);
      lastFrame = now;

      // Nothing to show while hidden, and every frame skipped here is GPU time
      // handed back to inference.
      if (document.hidden) return;

      // Hit feedback is read first, before anything moves, so a hit-stop
      // freezes the very frame the blow lands on rather than one frame after
      // the recoil has already started.
      const log = impactHolder.current?.current;
      if (log) {
        for (const imp of log.since(lastImpactSeq)) {
          lastImpactSeq = imp.seq;
          if ((imp.kind === "landed" || imp.kind === "taken") && imp.power > 0.65) {
            // The impact log carries no world coordinates; keep small marks
            // in the central fighting area, within both venue boundaries.
            bloodDecals?.add(imp.seq, TARGET_CONFIG.distance / 2);
          }
          const s = shakeFor(imp);
          if (s.amplitude > 0 && !reduceMotion) {
            shake = { ...s, start: imp.at, seed: imp.seq };
          }
          warp.hitStop(imp.at, hitStopFor(imp));
        }
      }
      /** Time step for the opponent and the hit reaction: frozen during a
       *  hit-stop, slowed through a knockdown, real time otherwise. */
      const figureDt = dt * warp.rate(now);
      if (crowd?.group.visible) crowd.update(dt);

      // Adaptive resolution. Only reacts to sustained pressure, so a one-off
      // hitch (a GC pause, the model finishing its load) can't permanently
      // degrade the view, and recovery is slower than degradation to avoid
      // oscillating between two levels. Also gives resolution up when pose
      // tracking is starved - see resolutionGovernor.ts.
      let nextRatio = governor.frame(rawDt);
      slowness.frame(rawDt);
      if (now - lastPoseCheck > 500) {
        lastPoseCheck = now;
        const gaps = poseIntervalHolder.current;
        const infer = inferenceHolder.current;
        const mean = gaps && gaps.size >= 10 ? gaps.compute().mean : null;
        const inferMean = infer && infer.size >= 10 ? infer.compute().mean : null;
        nextRatio = governor.poseInterval(mean, inferMean) ?? nextRatio;
        slowness.poseInterval(mean, inferMean);
      }
      if (nextRatio !== null && nextRatio !== pixelRatio) {
        pixelRatio = nextRatio;
        renderer.setPixelRatio(pixelRatio);
        resize();
      }

      if (viewDirtyRef.current !== lastViewSeen) {
        lastViewSeen = viewDirtyRef.current;
        placeCamera();
      }

      // The dummy counts as an opponent for framing purposes: it is the same
      // problem, and keying this off showTarget alone was why the dummy
      // rendered fully hidden behind the player.
      const duelNow = showTargetRef.current || dummyRef.current;
      if (duelNow !== lastTargetShown) {
        lastTargetShown = duelNow;
        if (opponentRoot) opponentRoot.visible = showTargetRef.current && !dummyRef.current;
        // Two figures need a wider frame than one, or the opponent sits off
        // screen and the whole point of showing it is lost.
        frameHeight = baseFrameHeight * (duelNow ? OVER_SHOULDER.widen : 1);
        placeCamera();
      }

      const driver = driverRef.current;
      if (driver) {
        // Drawn from the predicted pose when one is available.
        const pose = sampleRef.current?.() ?? poseRef.current;
        const mirrored = VIEW_MODES[viewRef.current].mirrored;
        driver.update(pose, dt, mirrored);

        // Let the neutral reference drift only on genuinely new pose samples,
        // using the interval between them - otherwise the render rate would
        // silently change how fast it follows.
        const sampled = poseRef.current;
        if (sampled && sampled.timestamp !== lastPoseTs) {
          if (lastPoseTs > 0) {
            driver.followNeutral(
              sampled,
              (sampled.timestamp - lastPoseTs) / 1000,
              mirrored
            );
          }
          lastPoseTs = sampled.timestamp;
        }

        if (debugCbRef.current && now - lastDebugPush > 250) {
          lastDebugPush = now;
          debugCbRef.current(driver.debug);
          if (targetRef.current) targetDebugCbRef.current?.(targetRef.current.debug);
        }
      }

      if (punchingDummy) {
        // Light whatever the drill is asking for. Set every frame rather than
        // on change: it is a map lookup and a couple of assignments, and
        // edge-detecting it here would mean holding a second copy of the
        // drill's state in the render layer just to notice when it moved.
        punchingDummy.setLit(litHolder.current?.current?.zone.id ?? null);

        // Physical reaction: every punch rocks the dummy, whether or not a
        // drill is running. In free work nothing is lit and nothing is scored,
        // and a dummy that stood still while being hit would read as the hit
        // detection having failed.
        const strikes = strikeQueueHolder.current?.current;
        if (strikes && strikes.length > 0) {
          for (const st of strikes.splice(0, strikes.length)) {
            punchingDummy.impact(st.power);

            // The dummy's body is the character mesh, so it gets the same
            // treatment an opponent does: a bone-driven reaction, a bruise on
            // the skin, and facial damage keyed off the anatomical region.
            // Routing it through the same calls means the dummy and the
            // opponent cannot drift apart in how they respond to a punch.
            targetRef.current?.hit(st);
            targetSkin?.addBruise(`${st.zone.height}/${st.zone.lane}`, st.power);
            if (opponentRoot) {
              faces.get(opponentRoot)?.hit(st.region.id, st.power);
            }

            // Mark where it landed even with no target lit, so free work still
            // shows the player where their punches are going.
            const near = nearestZone(st.impact);
            if (near && !litHolder.current?.current) {
              punchingDummy.score(near.id, 0.5);
            }
          }
        }

        // Scoring reaction: colour the asked-for target by how well it was hit.
        const outcomes = outcomeHolder.current?.current;
        if (outcomes && outcomes.length > 0) {
          // Spliced to zero in one call, so an outcome arriving between a read
          // and a clear cannot be dropped - same reason as the strike queue.
          for (const o of outcomes.splice(0, outcomes.length)) {
            if (o.kind !== "hit") continue;
            punchingDummy.score(o.zone.id, o.accuracy);
          }
        }
        punchingDummy.update(dt);
        // The figure's own reaction and its damage surfaces age here, since
        // the branch below is skipped whenever the dummy is what is standing
        // at the target position.
        targetRef.current?.update(dt);
        targetSkin?.update(dt);
        if (opponentRoot) faces.get(opponentRoot)?.update(dt);
      }

      // The humanoid target only runs when the dummy is not the thing standing
      // at the target position - they are mutually exclusive, and both draining
      // the strike queue would split the punches between them.
      const target = punchingDummy ? null : targetRef.current;
      if (target) {
        // Drain the strike queue. Splicing to zero rather than reading and
        // clearing separately, so a strike arriving between the two can't be
        // dropped.
        const queue = strikeQueueHolder.current?.current;
        if (queue && queue.length > 0) {
          for (const strike of queue.splice(0, queue.length)) {
            target.hit(strike);
            // The bruise goes on the zone the strike was resolved to, which is
            // the only spatial information the resolver can honestly report -
            // see strikeResolver.ts on why there is no geometry to hit.
            targetSkin?.addBruise(
              `${strike.zone.height}/${strike.zone.lane}`,
              strike.power
            );
            // Facial damage is keyed off the anatomical region, not the coarse
            // 2x3 zone. Driving it from `strike.region.id` means the damage
            // model and the hit model cannot drift apart - a shot the resolver
            // called a jaw is a shot the face swells at the jaw, with no
            // second mapping to keep in sync.
            if (opponentRoot) {
              faces.get(opponentRoot)?.hit(strike.region.id, strike.power);
            }
          }
        }
        if (opponentRoot?.visible) {
          target.update(figureDt);
          targetSkin?.update(dt);
          faces.get(opponentRoot)?.update(dt);
        }
      }
      // --- A networked opponent -------------------------------------------
      //
      // The same RigDriver that draws the local player, fed the pose frames
      // arriving over the link. `mirrored` is false here for the same reason
      // it is false for the player in the behind view: the mapping is
      // Anatomical, so the person's right arm drives their figure's right arm.
      // The figure is turned to face the local player, which is what puts that
      // arm on the correct side of the screen - a second mirror here would
      // undo it and have them boxing left-handed.
      if (remoteDriver) {
        remoteDriver.update(remotePoseHolder.current?.current ?? null, dt, false);

        // The local player's punches, played on them. This is the branch that
        // drains the strike queue in a versus fight - the humanoid-target
        // branch above is skipped, because there is no TrainingTarget when a
        // person is standing there.
        const queue = strikeQueueHolder.current?.current;
        if (queue && queue.length > 0) {
          for (const strike of queue.splice(0, queue.length)) {
            remoteDriver.flinch(strike);
            targetSkin?.addBruise(
              `${strike.zone.height}/${strike.zone.lane}`,
              strike.power
            );
            if (opponentRoot) {
              faces.get(opponentRoot)?.hit(strike.region.id, strike.power);
            }
          }
        }
        const them = conditionHolder.current?.current?.opponent;
        remoteDriver.setCondition(them?.down ?? 0, them?.hurt ?? 0);
        targetSkin?.update(dt);
        if (opponentRoot) faces.get(opponentRoot)?.update(dt);
      }

      // Publish the player's body channels for the fight loop. Before the
      // model has loaded there is no driver and therefore no measurement - the
      // ref stays null, which the fight loop reads as "the player is standing
      // at neutral" rather than as a zero step.
      const bodyOut = bodyOutHolder.current;
      if (bodyOut) bodyOut.current = driver ? driver.bodyMotion : null;

      // --- The opponent's own body -----------------------------------------
      //
      // Drained before the animator is stepped, so a punch thrown this frame
      // starts its extension on this frame rather than the next one. At the
      // CPU's fastest telegraph (260ms) a frame of slack is about 6% of the
      // whole wind-up, which is small but is exactly the part the player is
      // reading.
      const thrown = opponentThrowHolder.current?.current;
      if (thrown && thrown.length > 0) {
        for (const strike of thrown.splice(0, thrown.length)) {
          opponentAnim?.throw(strike.hand, strike.impact.height, strike.impact.lateral);
        }
      }
      // Punches that landed on the player, at contact: the same marks and
      // reaction the opponent takes in the other direction.
      const landed = opponentStrikeHolder.current?.current;
      if (landed && landed.length > 0) {
        for (const strike of landed.splice(0, landed.length)) {
          playerSkin?.addBruise(`${strike.zone.height}/${strike.zone.lane}`, strike.power);
          if (playerRoot) faces.get(playerRoot)?.hit(strike.region.id, strike.power);
          driverRef.current?.flinch(strike);
        }
      }
      if (opponentAnim) opponentAnim.update(figureDt, opponentHolder.current?.current ?? IDLE_OPPONENT);

      // The player's own condition. Until this line a clean right hand put the
      // player on the canvas, the simulation started a count and resumed the
      // round, and the character on screen boxed on throughout - mirroring a
      // player who was, quite correctly, still standing in their room.
      if (driver) {
        const me = conditionHolder.current?.current?.player;
        driver.setCondition(me?.down ?? 0, me?.hurt ?? 0);
      }

      // The player's own damage surface ages too, so marks left on them fade
      // at the same rate.
      if (playerSkin) {
        playerSkin.update(dt);
        if (playerRoot) faces.get(playerRoot)?.update(dt);
      }

      stepDirector(dt);
      if (driver) {
        // A line-locked fight ignores the player's steps, so the figure does too.
        driver.lockDepth = fpsRef.current || (lineLockedHolder.current?.current ?? false);
        // In a fight (or on the punching dummy) the legs stand planted rather
        // than copying the camera's guesses at the player's legs.
        driver.plantLegs = !!(showTargetRef.current || dummyRef.current);
        driver.steadyBody = driver.plantLegs;
      }
      const inBout = !!(showTargetRef.current || dummyRef.current);
      const first = fpsRef.current;
      // Every fight runs light: no shadow pass, no crowd, resolution capped at
      // 1x, so the GPU goes to pose tracking and your fighter keeps up with
      // you. The slowness detector still covers any other view.
      const wantLite = inBout || slowness.slow;
      if (wantLite !== liteOn) setLite(wantLite);
      if (inBout) {
        fpsActive = true;
        // The camera is driven every frame; dragging it would fight that.
        // Re-asserted each frame because the knockdown director re-enables
        // the controls when it hands the camera back.
        if (!directorOwns) controls.enabled = false;
        // Materials only change at load or on an appearance change, so the scan
        // runs four times a second by the clock; the glow updates every frame.
        const nowMs = performance.now();
        const rescan = nowMs - fpsScanAt >= 250;
        if (rescan) fpsScanAt = nowMs;
        syncGlow(opponentHolder.current?.current?.windup ?? 0, rescan);
        // Solid again while the director shows the player from outside.
        syncGhost(!first && !directorOwns, rescan);
        if (!placeFpsCamera(dt, first) && !directorOwns) {
          followOpponent(dt);
          controls.update();
        }
      } else {
        if (fpsActive) leaveFps();
        followOpponent(dt);
        controls.update();
      }

      // Hit feedback: a short camera kick when a punch lands either way. The
      // offset is added just for this frame's render and taken off again, so
      // it never accumulates into the camera's real placement or fights the
      // orbit controls and the director.
      let kick: { x: number; y: number } | null = null;
      if (shake) {
        kick = shakeOffset(
          (performance.now() - shake.start) / 1000,
          shake.amplitude,
          shake.duration,
          shake.seed
        );
        if (kick.x === 0 && kick.y === 0) shake = null;
        else {
          camera.position.x += kick.x;
          camera.position.y += kick.y;
        }
      }
      renderer.render(scene, camera);
      if (kick) {
        camera.position.x -= kick.x;
        camera.position.y -= kick.y;
      }
    }
    tick();

    return () => {
      cancelled = true;
      if (wardrobe && frameTarget) {
        wardrobeCamera.current = { position: camera.position.clone(), target: controls.target.clone() };
      }
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      controls.dispose();
      driverRef.current = null;
      playerSkin?.dispose();
      targetSkin?.dispose();
      gloveGrain?.dispose();
      trunksGrain?.dispose();
      skinGrain?.dispose();
      hairGrain?.dispose();
      matteGlove?.dispose();
      ribbedTrunks?.dispose();
      croppedHair?.dispose();
      const builderOwned = new Set<THREE.Object3D | undefined | null>([
        venue?.group, crowd?.group, bloodDecals?.group, trainingRoom?.group,
        hallFloor,
      ]);
      scene.traverse((obj) => {
        // Builders share materials among meshes and release them once below.
        for (let ancestor: THREE.Object3D | null = obj; ancestor; ancestor = ancestor.parent) {
          if (builderOwned.has(ancestor)) return;
        }
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose());
        }
      });
      punchingDummy?.dispose();
      // Disposed through the builders' own dispose(), not by the scene
      // traversal above: the arena shares materials and textures between many
      // meshes, so the traversal would dispose the same canvas texture a dozen
      // times over. The builders track each resource once.
      venue?.dispose();
      arenaLighting?.dispose();
      crowd?.dispose();
      bloodDecals?.dispose();
      trainingRoom?.dispose();
      if (hallFloor) {
        hallFloor.geometry.dispose();
        (hallFloor.material as THREE.MeshStandardMaterial).map?.dispose();
        (hallFloor.material as THREE.Material).dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
    // poseRef is a stable ref; `mirrored` and `onStatusChange` are read through
    // refs so a change never tears down and reloads the 8MB model.
    // `dummy` is a dependency, unlike every other prop here, which are all
    // mirrored into refs to avoid rebuilding the scene. This one genuinely
    // changes what is in the scene - a different object standing at the target
    // position - so it has to tear down and rebuild rather than being toggled.
  }, [poseRef, dummy, stage, appearance, wardrobe]);

  return (
    <div
      ref={containerRef}
      className="boxer-model"
      role="img"
      aria-label={
        status === "ready"
          ? wardrobe ? "3D fighter preview. Drag to orbit the camera." : "3D boxer character, animated live from your tracked pose. Drag to orbit the camera."
          : status === "error"
            ? `3D boxer character failed to load${errorMsg ? `: ${errorMsg}` : ""}`
            : "3D boxer character loading"
      }
    />
  );
}
