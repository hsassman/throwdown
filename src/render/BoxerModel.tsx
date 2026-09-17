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
  KIT,
  KIT_MESH_COLOUR,
  KIT_ROUGHNESS,
  RENDER_CONFIG,
  TARGET_CONFIG,
} from "../config/tuning";
import { findBodyMesh } from "./findBodyMesh";
import { FaceDamage } from "./damage/faceDamage";
import { createFacePainter, locateFaceFeatures } from "./damage/facePainter";
import type { StrikeEvent } from "../perception/strikeResolver";

// Track B, Milestone B2/B3: loads the MHR-exported boxer mesh and drives the
// joints covered by rigJointMap.ts from live MediaPipe landmarks. Purely
// cosmetic — see docs/ARCHITECTURE.md. No placeholder shape exists yet to
// "replace" (Track A hasn't built a render layer), so this is reached through
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
 * player — the dummy or the CPU fighter.
 *
 * A square-on rear camera puts the player EXACTLY between the lens and their
 * opponent, so the opponent is completely hidden behind them. That is not a
 * subtle framing preference; the first render of the punching dummy showed a
 * player alone in an empty room, with the dummy perfectly occluded. Every
 * fighting game with a behind-the-shoulder view solves it the same way: lift
 * the camera above the player's head and push it off to one side, so the line
 * of sight clears them.
 *
 * Both are in world units, relative to the player's chest.
 */
const OVER_SHOULDER = {
  rise: 1.05,
  /**
   * How far past the player's own shoulder the sight line must clear, world
   * units. The only hand-chosen number left in this block — everything else is
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

/**
 * How far to the side the camera must sit to see past the player.
 *
 * The previous version of this was a typed-in 0.46, and it was MARGINAL — a
 * headless screenshot of a live fight showed the opponent almost entirely
 * behind the player, with one glove visible. The number was close enough to
 * look deliberate and wrong enough to hide a whole fighter.
 *
 * So it is derived instead. Put the aim point at `aimZ`, the opponent's chest
 * at `distance`, and the camera a long way back along the chosen direction.
 * The sight line from the camera to the opponent's chest then crosses the
 * plane `z` at a lateral offset approaching `lateral * (distance - z)`. The
 * binding plane is the player's own FRONT — it is nearest the opponent, so the
 * ray has converged furthest in by the time it gets there — which gives
 *
 *     lateral > (shoulderHalfWidth + clearance) / (distance - frontZ)
 *
 * The camera is not infinitely far back, and at a finite distance the true
 * offset is smaller by k / (distance - aimZ + k). `finiteBack` is that
 * correction at a typical framing distance; it only ever pushes the camera
 * further out, so an inexact value costs a slightly wider shot rather than a
 * hidden fighter.
 *
 * Deriving it means a change to TARGET_CONFIG.distance, or a re-export at a
 * different scale, re-frames the shot instead of quietly occluding half of it.
 */
const FINITE_BACK = 0.85;

function overShoulderLateral(shoulderHalfWidth: number, frontZ: number): number {
  const reachable = Math.max(0.1, TARGET_CONFIG.distance - frontZ);
  const needed =
    (shoulderHalfWidth + OVER_SHOULDER.clearance) / reachable / FINITE_BACK;
  return Math.min(
    OVER_SHOULDER.maxLateral,
    Math.max(OVER_SHOULDER.minLateral, needed)
  );
}

/** Render resolution bounds. Kept under the device pixel ratio because this
 * competes with pose inference for the same GPU. */
const MAX_PIXEL_RATIO = 1.75;
const MIN_PIXEL_RATIO = 0.75;
/** Frame time above which the view is considered to be struggling (~45 FPS). */
const SLOW_FRAME_SEC = 0.022;
/** Frame time comfortably inside budget (~70 FPS), where quality can recover. */
const FAST_FRAME_SEC = 0.014;

export type LoadStatus = "loading" | "ready" | "error";

interface Props {
  poseRef: React.RefObject<PoseFrame | null>;
  /**
   * Optional: returns the pose to DRAW at the calling instant, extrapolated
   * forward by the measured pipeline latency. When supplied it replaces
   * `poseRef` for rendering only.
   *
   * Rendering and perception deliberately read different poses. The character
   * should be where the player IS (~110 ms of pipeline latency removed); hit
   * resolution must stay on what actually happened, or a strike could register
   * from a velocity estimate rather than from a punch. `poseRef` is still used
   * for the neutral-drift timing below, because that keys off genuine sample
   * boundaries and predicted frames do not have any.
   */
  samplePose?: () => PoseFrame | null;
  /**
   * How the character is framed, and — inseparably — how the player's limbs
   * map onto its bones. See VIEW_MODES: the camera side and the mapping are
   * two halves of one decision, and changing either alone puts the arms on
   * the wrong side of the screen.
   *
   * `behind` (default) is the standard fighting-game view: the camera sits
   * behind the boxer, the mapping is anatomical, and the player's right arm
   * drives the character's right arm on the same side of the screen they see
   * their own arm on. `facing` is the front-on reflection view.
   *
   * Note the mapping is implemented by remapping which limb drives which bone
   * and negating the measured x direction — NEVER by scaling the model
   * negatively. A negative scale makes an ancestor matrix have negative
   * determinant, which cannot decompose into a valid rotation, so every
   * getWorldQuaternion() in the retargeting path would return garbage. That
   * was a real bug here.
   */
  view?: ViewMode;
  onStatusChange?: (status: LoadStatus, detail?: string) => void;
  /** Receives live retargeting state for the diagnostics panel. Called on a
   * timer rather than per frame — a per-frame callback into React would
   * re-render the tree 60x a second for a readout nobody can read that fast. */
  onDebug?: (state: RigDebugState) => void;
  /** Bumping this recentres the character on where the player stands now. */
  recentreSignal?: number;
  /** Adds the second humanoid — a training target that reacts to hits. */
  showTarget?: boolean;
  /** Strikes to play on the target. The ref is read and DRAINED by the render
   * loop rather than passed as a prop, because hits arrive at pose rate and
   * routing each one through React would re-render the tree mid-combination. */
  strikeQueueRef?: React.RefObject<StrikeEvent[]>;
  /** Receives the target's hit tally, on the same timer as onDebug. */
  onTargetDebug?: (state: TargetDebugState) => void;
  /**
   * Swaps the humanoid target for the punching dummy.
   *
   * They are mutually exclusive on purpose. Both occupy the same spot at
   * TARGET_CONFIG.distance, and showing both would put a dummy inside a
   * fighter — so this is a choice of what stands there, not an extra prop.
   */
  dummy?: boolean;
  /** The target zone to light on the dummy. Read every frame, never a prop
   *  value, because it changes at drill rate. */
  litRef?: React.RefObject<LitTarget | null>;
  /** Drill outcomes to play on the dummy. Drained by the render loop, for the
   *  same reason strikeQueueRef is. */
  outcomeQueueRef?: React.RefObject<DrillOutcome[]>;
  /**
   * The CPU opponent's body state, read every frame.
   *
   * A ref rather than a prop because it changes at 60 Hz — the AI steps on the
   * fight loop's own clock, and routing its stance through React would
   * re-render the tree every frame to move a figure the render loop is already
   * inside. Null means there is no live opponent, and the figure simply stands
   * on guard.
   */
  opponentRef?: React.RefObject<OpponentVisualState | null>;
  /**
   * Punches thrown BY the opponent, drained by the render loop.
   *
   * Separate from `strikeQueueRef`, which carries the player's punches the
   * other way. Two directions, two queues: sharing one would mean the
   * renderer had to ask who threw each punch, and getting that wrong would
   * bruise the wrong fighter.
   */
  opponentStrikeQueueRef?: React.RefObject<StrikeEvent[]>;
  /**
   * Written every frame with the player's live whole-body channels.
   *
   * An OUTPUT ref, which is unusual and deliberate. The one BodyMotionTracker
   * lives inside the rig driver, and the fight loop needs the same numbers to
   * work out the gap between the fighters. Publishing the existing measurement
   * is right; constructing a second tracker outside would give the two a
   * separate neutral each, and they would quietly disagree about where the
   * player is standing.
   */
  bodyOutRef?: React.RefObject<BodyMotion | null>;
}

export function BoxerModel({
  poseRef,
  samplePose,
  view = "behind",
  onStatusChange,
  onDebug,
  recentreSignal = 0,
  showTarget = false,
  strikeQueueRef,
  onTargetDebug,
  dummy = false,
  litRef,
  outcomeQueueRef,
  opponentRef,
  opponentStrikeQueueRef,
  bodyOutRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
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
  const bodyOutHolder = useRef(bodyOutRef);
  bodyOutHolder.current = bodyOutRef;
  // Read inside the setup effect. Changing it rebuilds the scene, which is
  // correct — it is a different object standing there.
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
    let rafId = 0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    // Required for the punching dummy: the character figure used as its body
    // is clipped off below the belt by a per-material plane. Without this the
    // plane is simply ignored and the dummy grows a full pair of legs inside
    // its own stand.
    renderer.localClippingEnabled = true;
    // Capped below the device ratio on purpose. This scene shares an
    // integrated GPU with pose inference — the app's actual bottleneck — so
    // pixels spent here are taken from the thing that matters. It drops
    // further under load; see the adaptive block in tick().
    let pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setPixelRatio(pixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;

    scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a1d24, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1.5, 2.5, 2.0);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ab4ff, 0.8);
    rim.position.set(-2, 1.5, -1.5);
    scene.add(rim);

    // Set once the model loads; until then there is nothing to frame.
    let opponentRoot: THREE.Object3D | null = null;
    let opponentAnim: OpponentAnimator | null = null;
    let punchingDummy: PunchingDummy | null = null;
    let playerRoot: THREE.Object3D | null = null;
    let playerSkin: BodyTexture | null = null;
    let targetSkin: BodyTexture | null = null;
    // Facial damage per figure, keyed by the figure root so the target's
    // swelling can never be applied to the player's face.
    const faces = new Map<THREE.Object3D, FaceDamage>();
    let frameTarget: THREE.Vector3 | null = null;
    /** Derived once the player's figure is measured. See overShoulderLateral. */
    let overShoulder = OVER_SHOULDER.minLateral;
    let frameHeight = 1;
    let baseFrameHeight = 1;
    let frameWidth = 1;
    // Once the viewer has orbited or zoomed, stop re-framing on resize —
    // silently yanking the camera back would fight them.
    let userAdjusted = false;
    controls.addEventListener("start", () => {
      userAdjusted = true;
    });

    /**
     * Places the camera square-on to the character, on the side the current
     * view calls for, and re-frames.
     *
     * Split out from fitCamera() because of a real bug: fitCamera() derives
     * its viewing direction from `camera.position - controls.target`, and on
     * the first call after loading, controls.target was still at the origin
     * while the character's chest sits ~1.3 units up. The resulting direction
     * was (0, 0.80, 0.60) — the camera ended up looking DOWN at the boxer from
     * about 53 degrees, despite a comment claiming it started square-on. The
     * fix is to set the target before any direction is read from it.
     */
    const placeCamera = () => {
      if (!frameTarget) return;
      const side = VIEW_MODES[viewRef.current].cameraSide;
      // Something standing opposite changes the shot completely — see
      // OVER_SHOULDER. Without this the player occludes their own opponent.
      const duel = showTargetRef.current || dummyRef.current;
      controls.target.set(
        frameTarget.x,
        frameTarget.y,
        frameTarget.z + (duel ? TARGET_CONFIG.distance * OVER_SHOULDER.aim : 0)
      );
      camera.position.set(
        frameTarget.x + (duel ? overShoulder * side : 0),
        frameTarget.y + (duel ? OVER_SHOULDER.rise : 0),
        frameTarget.z + side
      );
      // Key light follows the camera, otherwise switching to the rear view
      // leaves the boxer lit entirely from behind and reading as a silhouette.
      key.position.set(1.5, 2.5, 2.0 * VIEW_MODES[viewRef.current].cameraSide);
      rim.position.set(-2, 1.5, -1.5 * VIEW_MODES[viewRef.current].cameraSide);
      userAdjusted = false;
      fitCamera();
    };

    const fitCamera = () => {
      if (!frameTarget) return;
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

    /**
     * Paints a figure and returns its damage surface.
     *
     * The material is replaced rather than edited: the player and the target
     * are clones of the same asset and would otherwise share one material, so
     * texturing either would texture both and bruises on the target would
     * appear on the player's own body too.
     */
    /**
     * Gives one figure its own kit materials, in its own corner's colour.
     *
     * The gloves, shorts and boots are baked into the GLB with a single
     * colour, and the opponent is a `SkeletonUtils.clone` of that same asset —
     * which shares materials BY REFERENCE. Without this the two fighters wear
     * identical kit, and worse, disposing one figure's material pulls it out
     * from under the other. That exact double-dispose has bitten this project
     * before, which is why the old material goes into `retired` to be disposed
     * once rather than per figure.
     *
     * Meshes are matched by NAME (KIT_MESH_COLOUR), because that is what the
     * Blender pipeline guarantees — blender/scripts/03..05 name every garment
     * it builds. Anything unrecognised is left alone, so the eyeballs keep
     * their sclera material.
     */
    const tintKit = (
      figure: THREE.Object3D,
      kit: (typeof KIT)["player"] | (typeof KIT)["target"],
      retired: Set<THREE.Material>
    ) => {
      figure.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const slot = KIT_MESH_COLOUR[obj.name];
        if (!slot) return;
        const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of old) if (m) retired.add(m);
        mesh.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(kit[slot]),
          roughness: KIT_ROUGHNESS[slot],
          metalness: 0,
        });
      });
    };

    const textureFigure = (
      figure: THREE.Object3D,
      kit: BodyTextureOptions,
      /** Materials replaced along the way. Collected rather than disposed on
       * the spot: the clone shares the original material BY REFERENCE, so
       * disposing it while texturing the first figure would pull it out from
       * under the second, which still points at it. */
      retired: Set<THREE.Material>
    ): BodyTexture | null => {
      // The BODY, not whichever skinned mesh traversal happens to end on.
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
        roughness: 0.78,
        metalness: 0.0,
      });
      const old = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of old) if (m) retired.add(m);
      mesh.material = material;

      // Facial damage, painted as an OVERLAY on the same texture.
      // Registered here rather than composited separately because the body
      // texture rebuilds from a clean base on every repaint — anything drawn
      // outside that cycle is wiped on the next bruise tick.
      //
      // Feature positions come from the bones (`l_eye`, `r_eye`, `c_jaw`),
      // never from hardcoded UVs. Hardcoded coordinates would break silently
      // on a re-export, and re-exporting through Blender is now on the table.
      // Eye bind positions, in the same geometry space the UVs live in. Needed
      // because `l_eye`/`r_eye` carry no skin weight on this rig, so there are
      // no "eye vertices" to average — the UV comes from the nearest head
      // vertex instead. See locateFaceFeatures.
      const bindPos = (name: string): THREE.Vector3 | null => {
        const i = boneNames.indexOf(name);
        if (i < 0) return null;
        return new THREE.Vector3().setFromMatrixPosition(
          mesh.skeleton.boneInverses[i].clone().invert()
        );
      };
      const eyeL = bindPos("l_eye");
      const eyeR = bindPos("r_eye");

      const features = locateFaceFeatures(
        mesh.geometry,
        boneNames,
        dominant,
        eyeL && eyeR ? { left: eyeL, right: eyeR } : null
      );
      if (features) {
        const painter = createFacePainter({
          features,
          canvas: body.canvas,
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

        // A SkinnedMesh is culled against its BIND-pose bounds. Once bones are
        // driven away from bind, the real silhouette leaves that volume and
        // the whole character can blink out of existence at certain angles.
        model.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false;
        });

        try {
          driverRef.current = new RigDriver(model);

          // The second humanoid. Same asset, cloned — a second download and a
          // second set of bind data would buy nothing while the only question
          // is whether hits register and read correctly.
          //
          // SkeletonUtils.clone, NOT Object3D.clone: a plain clone copies the
          // SkinnedMesh but leaves its skeleton pointing at the ORIGINAL
          // bones, so the copy would deform with the player's character
          // instead of its own. That is a silent, extremely confusing failure.
          const opponent = cloneSkinned(model);
          opponent.traverse((o) => {
            const mesh = o as THREE.SkinnedMesh;
            if (mesh.isSkinnedMesh) mesh.frustumCulled = false;
          });
          // Clone FIRST, then texture each figure separately — cloning after
          // texturing would copy the player's material reference and the two
          // would share one map, so bruises on the target would appear on the
          // player as well.
          const retired = new Set<THREE.Material>();
          playerSkin = textureFigure(model, KIT.player, retired);
          targetSkin = textureFigure(opponent, KIT.target, retired);
          tintKit(model, KIT.player, retired);
          tintKit(opponent, KIT.target, retired);
          for (const m of retired) m.dispose();

          // NOTE: gloves, trunks and generated eyeballs were built here and
          // REMOVED on 2026-09-16 (see blender/README.md). Three
          // attempts at procedural/imported gear all failed a visual check;
          // the kit is now authored in Blender and baked into the exported
          // mesh instead of being generated at load. Do not re-add a runtime
          // gear layer without reading that doc first.
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
            // Anchored on the PLAYER's belt line, so the dummy's targets sit at
            // the heights the strike resolver reports them at. Derived from the
            // model's own placement rather than assumed to be the origin.
            punchingDummy = new PunchingDummy({
              beltHeight: model.position.y + RENDER_CONFIG.rigHipWorldHeight,
              body: "figure",
            });
            scene.add(punchingDummy.group);

            // The character IS the dummy's body. Three things have to happen
            // to it, and all three are reversible cosmetics — nothing here
            // touches the rig or the hit map.
            //
            // 1. The kit comes off. A dummy wears no gloves, trunks or boots.
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

            // 3. It is parented INTO the spring, so it rocks with the stand
            //    rather than standing beside it. The local offset puts the
            //    figure's own origin back where it would have been in world
            //    space, since the pivot sits at the cut line.
            punchingDummy.pivot.add(opponent);
            // setHome, not position.set: `update` rewrites root.position from
            // homePosition every frame, so a figure merely POSITIONED here
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

            // Markers go onto the CHARACTER's surface, not the moulded spec's.
            // Where the character is thicker, a marker at the spec depth is
            // buried inside the chest — invisible, and silent about it.
            punchingDummy.projectMarkersOnto(opponent);
          } else {
            targetRef.current.setHome(
              new THREE.Vector3(0, model.position.y, TARGET_CONFIG.distance)
            );
            opponent.visible = showTargetRef.current;
            // Under a PIVOT, not straight into the scene. The animator moves
            // the pivot for footwork while TrainingTarget keeps rewriting
            // `opponent.position` for knockback, so the two compose instead of
            // overwriting each other every frame. See opponentAnimator.ts.
            opponentAnim = new OpponentAnimator(opponent);
            opponentAnim.pivot.add(opponent);
            scene.add(opponentAnim.pivot);
          }
          opponentRoot = opponent;
          opponent.updateMatrixWorld(true);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setErrorMsg(msg);
          setStatus("error");
          statusCbRef.current?.("error", msg);
          return;
        }

        // Frame from the model's real bounds rather than guessed numbers — the
        // previous hardcoded camera cropped the head and feet.
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        frameHeight = size.y * FRAME_FROM_HEIGHT;
        // Allow for arms thrown wide — the bind-pose bounding box is measured
        // with the arms down, so its width understates the real silhouette.
        frameWidth = size.x * 1.25;
        frameTarget = new THREE.Vector3(
          center.x,
          box.max.y - frameHeight / 2,
          center.z
        );
        baseFrameHeight = frameHeight;
        // Widen HERE as well as on the transition below. The transition only
        // fires when the duel flag CHANGES, and it is already true by the time
        // the model finishes loading — the component mounts with the mode
        // already chosen. So entering a fight directly, which is the only way
        // anyone enters one, framed the shot for a single figure and the two
        // fighters filled the screen on top of each other.
        if (showTargetRef.current || dummyRef.current) {
          // BOTH axes. `fitCamera` takes whichever of the two needs the camera
          // further back, and the width is derived from the T-pose armspan —
          // which is wide enough that it always wins. Widening only the height
          // therefore changed the number and not the shot.
          frameHeight = baseFrameHeight * OVER_SHOULDER.widen;
          frameWidth *= OVER_SHOULDER.widen;
        }

        // Measured off the RIG, not off the bounding box. The box is taken in
        // the bind pose, which is a T-pose, so `size.x` is the armspan — about
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

    let lastFrame = performance.now();
    let lastPoseTs = 0;
    let lastDebugPush = 0;
    let slowFrames = 0;
    let fastFrames = 0;
    let lastViewSeen = viewDirtyRef.current;
    let lastTargetShown = showTargetRef.current;
    const maxPixelRatio = pixelRatio;

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

      // Adaptive resolution. Only reacts to sustained pressure, so a one-off
      // hitch (a GC pause, the model finishing its load) can't permanently
      // degrade the view, and recovery is slower than degradation to avoid
      // oscillating between two levels.
      if (rawDt > SLOW_FRAME_SEC) {
        slowFrames++;
        fastFrames = 0;
      } else if (rawDt < FAST_FRAME_SEC) {
        fastFrames++;
        slowFrames = 0;
      }
      if (slowFrames > 90 && pixelRatio > MIN_PIXEL_RATIO) {
        pixelRatio = Math.max(MIN_PIXEL_RATIO, pixelRatio - 0.25);
        renderer.setPixelRatio(pixelRatio);
        resize();
        slowFrames = 0;
      } else if (fastFrames > 300 && pixelRatio < maxPixelRatio) {
        pixelRatio = Math.min(maxPixelRatio, pixelRatio + 0.25);
        renderer.setPixelRatio(pixelRatio);
        resize();
        fastFrames = 0;
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
        // using the interval between them — otherwise the render rate would
        // silently change how fast it follows.
        //
        // Read from poseRef, NOT from the predicted pose: a predicted frame
        // carries the timestamp of the sample it was extrapolated from, so
        // this comparison still counts real samples either way — but keying it
        // to the unpredicted stream keeps that true even if prediction later
        // starts restamping.
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

        // PHYSICAL reaction: every punch rocks the dummy, whether or not a
        // drill is running. In free work nothing is lit and nothing is scored,
        // and a dummy that stood still while being hit would read as the hit
        // detection having failed.
        //
        // This is also why the dummy — not the humanoid target below — drains
        // the strike queue while it is the thing standing there. Two drainers
        // on one queue would each get roughly half the punches.
        const strikes = strikeQueueHolder.current?.current;
        if (strikes && strikes.length > 0) {
          for (const st of strikes.splice(0, strikes.length)) {
            punchingDummy.impact(st.power);

            // The dummy's body is the character mesh, so it gets the SAME
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

        // SCORING reaction: colour the asked-for target by how well it was hit.
        const outcomes = outcomeHolder.current?.current;
        if (outcomes && outcomes.length > 0) {
          // Spliced to zero in one call, so an outcome arriving between a read
          // and a clear cannot be dropped — same reason as the strike queue.
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

      // The humanoid target only runs when the dummy is NOT the thing standing
      // at the target position — they are mutually exclusive, and both draining
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
            // the only spatial information the resolver can honestly report —
            // see strikeResolver.ts on why there is no geometry to hit.
            targetSkin?.addBruise(
              `${strike.zone.height}/${strike.zone.lane}`,
              strike.power
            );
            // Facial damage is keyed off the ANATOMICAL region, not the coarse
            // 2x3 zone. Driving it from `strike.region.id` means the damage
            // model and the hit model cannot drift apart — a shot the resolver
            // called a jaw is a shot the face swells at the jaw, with no
            // second mapping to keep in sync.
            if (opponentRoot) {
              faces.get(opponentRoot)?.hit(strike.region.id, strike.power);
            }
          }
        }
        if (opponentRoot?.visible) {
          target.update(dt);
          targetSkin?.update(dt);
          faces.get(opponentRoot)?.update(dt);
        }
      }
      // Publish the player's body channels for the fight loop. Before the
      // model has loaded there is no driver and therefore no measurement — the
      // ref stays null, which the fight loop reads as "the player is standing
      // at neutral" rather than as a zero step.
      const bodyOut = bodyOutHolder.current;
      if (bodyOut) bodyOut.current = driver ? driver.bodyMotion : null;

      // --- The opponent's own body -----------------------------------------
      //
      // Drained BEFORE the animator is stepped, so a punch thrown this frame
      // starts its extension on this frame rather than the next one. At the
      // AI's fastest telegraph (260ms) a frame of slack is about 6% of the
      // whole wind-up, which is small but is exactly the part the player is
      // reading.
      if (opponentAnim) {
        const thrown = opponentStrikeHolder.current?.current;
        if (thrown && thrown.length > 0) {
          for (const strike of thrown.splice(0, thrown.length)) {
            opponentAnim.throw(strike.hand, strike.impact.height);
            // The punch lands on the PLAYER, so the player's surfaces are what
            // mark. Same two calls the opponent takes in the other direction —
            // deliberately symmetric, so a fighter cannot be damaged in a way
            // the other one never can be.
            playerSkin?.addBruise(
              `${strike.zone.height}/${strike.zone.lane}`,
              strike.power
            );
            if (playerRoot) {
              faces.get(playerRoot)?.hit(strike.region.id, strike.power);
            }
          }
        }
        opponentAnim.update(dt, opponentHolder.current?.current ?? IDLE_OPPONENT);
      }

      // The player's own damage surface ages too, so marks left on them fade
      // at the same rate.
      if (playerSkin) {
        playerSkin.update(dt);
        if (playerRoot) faces.get(playerRoot)?.update(dt);
      }

      controls.update();
      renderer.render(scene, camera);
    }
    tick();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      controls.dispose();
      driverRef.current = null;
      playerSkin?.dispose();
      targetSkin?.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m) => m?.dispose());
        }
      });
      punchingDummy?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // poseRef is a stable ref; `mirrored` and `onStatusChange` are read through
    // refs so a change never tears down and reloads the 8MB model.
    // `dummy` is a dependency, unlike every other prop here, which are all
    // mirrored into refs to avoid rebuilding the scene. This one genuinely
    // changes what is IN the scene — a different object standing at the target
    // position — so it has to tear down and rebuild rather than being toggled.
  }, [poseRef, dummy]);

  return (
    <div
      ref={containerRef}
      className="boxer-model"
      role="img"
      aria-label={
        status === "ready"
          ? "3D boxer character, animated live from your tracked pose. Drag to orbit the camera."
          : status === "error"
            ? `3D boxer character failed to load${errorMsg ? `: ${errorMsg}` : ""}`
            : "3D boxer character loading"
      }
    />
  );
}
