// Renders the game's own boxer, front-on, as a webcam would see a player.
//
// Driven by tools/fake-player.mjs, which steps it frame by frame and encodes
// the result into a video Chrome can use as a fake camera. That puts a body in
// front of MediaPipe in headless runs, so the pose pipeline can be timed on its
// tracking path instead of the whole-image detector path an empty frame takes.
//
// Exposes window.__fakePlayer = { ready, setFrame(i, fps) }.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const W = 640;
const H = 480;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// A plain room wall rather than black: a webcam never sees a void, and a
// silhouette on pure black is an easier detection problem than a real one.
scene.background = new THREE.Color(0x8a8f96);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1, 2, 3);
scene.add(key);

const camera = new THREE.PerspectiveCamera(55, W / H, 0.05, 50);

interface Arm {
  up: THREE.Object3D;
  low: THREE.Object3D;
  hand: THREE.Object3D;
  upRest: THREE.Quaternion;
  lowRest: THREE.Quaternion;
}

let arms: { l: Arm; r: Arm } | null = null;
let figure: THREE.Object3D | null = null;
/** Metres per torso unit on this rig, for the ?move script below. */
let torsoMetres = 0.475;
let ready = false;
/** Which way along z the figure faces; the camera sits on that side. */
const facing = 1;

new GLTFLoader().load("/models/boxer_lod3.glb", (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);

  // Face the camera: the rig's forward is unknown up front, so frame from the
  // side the face is on. The nose is in front of the neck along forward.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());

  const bone = (name: string) => {
    const b = model.getObjectByName(name);
    if (!b) throw new Error(`missing bone ${name}`);
    return b;
  };
  const arm = (side: "l" | "r"): Arm => {
    const up = bone(`${side}_uparm`);
    const low = bone(`${side}_lowarm`);
    return { up, low, hand: low.children.find((c) => c.type === "Bone") ?? low.children[0], upRest: up.quaternion.clone(), lowRest: low.quaternion.clone() };
  };
  arms = { l: arm("l"), r: arm("r") };
  figure = model;
  {
    const sh = new THREE.Vector3().setFromMatrixPosition(bone("l_uparm").matrixWorld);
    const hip = new THREE.Vector3().setFromMatrixPosition(bone("c_spine0").matrixWorld);
    torsoMetres = Math.abs(sh.y - hip.y) || torsoMetres;
  }


  // Webcam framing: hips to head with headroom, as the game asks a player to
  // stand. Upper ~60% of the body fills the frame height.
  const top = box.max.y;
  const frameTop = top + size.y * 0.04;
  const frameBottom = top - size.y * 0.72;
  const midY = (frameTop + frameBottom) / 2;
  const span = frameTop - frameBottom;
  const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.set(centre.x, midY, centre.z + facing * dist);
  camera.lookAt(centre.x, midY, centre.z);

  ready = true;
});

/** Points `bone` along `dir` (world space), keeping its bind twist. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, rest: THREE.Quaternion, dir: THREE.Vector3) {
  bone.quaternion.copy(rest);
  bone.updateMatrixWorld(true);
  const from = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
  const to = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
  const current = to.sub(from).normalize();
  const swing = new THREE.Quaternion().setFromUnitVectors(current, dir.clone().normalize());
  const worldQ = bone.getWorldQuaternion(new THREE.Quaternion());
  const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentQ.invert().multiply(swing.multiply(worldQ)));
  bone.updateMatrixWorld(true);
}

/**
 * Poses the arms for time `t` seconds: a guard, with a jab then a cross every
 * 1.2s. Each segment is aimed at a world-space direction, so the result does
 * not depend on how the rig's local axes happen to be oriented.
 */
// ?guard=high: gloves at the chin, a high guard by the fight's rule
// (FIGHT_CONFIG.guardHighEnter). The default is a chest-height guard, which
// the fight reads as low - kept, because every earlier measurement used it.
const highGuard = new URLSearchParams(location.search).get("guard") === "high";

// ?move: guard up, no punches, and the body moves on an 8 s script - so the
// movement channels (step, slip, duck) can be measured against known motion.
// Render with seconds = 8 so the loop is seamless. Times are in MOVE_SCRIPT.
const move = new URLSearchParams(location.search).has("move");

/** [start, end, lateral, depth, drop] in seconds and torso units: lateral to
 *  the figure's own right, depth toward the camera, drop downward. Eased in
 *  and out over 0.3 s at each end. */
export const MOVE_SCRIPT: [number, number, number, number, number][] = [
  [2.0, 3.8, 0, 0.5, 0], // step in, hold, step back
  [4.4, 5.0, -0.35, 0, 0], // slip to the figure's left
  [5.4, 6.0, 0.35, 0, 0], // slip to its right
  [6.5, 7.3, 0, 0, 0.3], // duck
];

function body(t: number): { lateral: number; depth: number; drop: number } {
  const c = t % 8;
  const out = { lateral: 0, depth: 0, drop: 0 };
  for (const [a, b, lat, dep, drop] of MOVE_SCRIPT) {
    const ramp = 0.3;
    const w =
      c < a || c > b ? 0 : c < a + ramp ? (c - a) / ramp : c > b - ramp ? (b - c) / ramp : 1;
    const e = w * w * (3 - 2 * w);
    out.lateral += lat * e;
    out.depth += dep * e;
    out.drop += drop * e;
  }
  return out;
}

function pose(t: number) {
  if (!arms) return;
  if (move && figure) {
    const b = body(t);
    // The figure's own right is image left, which is -x seen from the camera.
    figure.position.set(-b.lateral * torsoMetres * facing, -b.drop * torsoMetres, b.depth * torsoMetres * facing);
  }
  const cycle = t % 1.2;
  // Punch extension 0..1: out over 0.12s, back over 0.14s.
  const ext = (start: number) => {
    const u = cycle - start;
    if (u < 0 || u > 0.26) return 0;
    return u < 0.12 ? Math.sin((u / 0.12) * (Math.PI / 2)) : Math.cos(((u - 0.12) / 0.14) * (Math.PI / 2));
  };
  const amount = move ? { l: 0, r: 0 } : { l: ext(0.2), r: ext(0.6) };
  const f = facing; // toward the camera
  for (const side of ["l", "r"] as const) {
    const a = arms[side];
    // The figure's own left is image right, which is +x seen from the camera.
    const out = side === "l" ? f : -f;
    const e = amount[side];
    const mix = (g: THREE.Vector3, pch: THREE.Vector3) => g.clone().lerp(pch, e).normalize();
    // Guard: elbow down and slightly out, forearm up to the chin.
    const guardUpper = highGuard
      ? new THREE.Vector3(out * 0.25, -0.55, f * 0.8)
      : new THREE.Vector3(out * 0.3, -0.85, f * 0.45);
    const guardFore = highGuard
      ? new THREE.Vector3(-out * 0.3, 0.95, f * 0.15)
      : new THREE.Vector3(-out * 0.35, 0.85, f * 0.4);
    const upper = mix(guardUpper, new THREE.Vector3(-out * 0.15, 0.05, f));
    const fore = mix(guardFore, new THREE.Vector3(-out * 0.1, 0.05, f));
    aim(a.up, a.low, a.upRest, upper);
    aim(a.low, a.hand, a.lowRest, fore);
  }
}

(window as unknown as Record<string, unknown>).__fakePlayer = {
  get ready() {
    return ready;
  },
  setFrame(i: number, fps: number) {
    pose(i / fps);
    renderer.render(scene, camera);
  },
};
