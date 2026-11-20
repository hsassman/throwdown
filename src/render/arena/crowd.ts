import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CROWD_CONFIG as C } from "../../config/tuning";

// The crowd: rows of people in the dark around the venue, and camera flashes.
//
// A fight in an empty black hall reads as a test scene; the eye wants a room
// full of people even when it cannot make any of them out. So this is built
// for that and nothing more: silhouettes, never lit, never casting shadows,
// fading into the hall's fog - and drawn in one instanced call, because the
// renderer already shares the GPU with pose inference.
//
// Seeded, so the same venue always seats the same crowd.

export interface Crowd {
  group: THREE.Group;
  /** Advances the flashes. `dt` in seconds. */
  update(dt: number): void;
  /** Fires a burst of flashes - a big moment in the fight. */
  burst(): void;
  dispose(): void;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Seat positions, for testing and for the builder: tiered rings outside
 *  `innerRadius`, each row further out and higher than the last. */
export function seatPositions(innerRadius: number, seed = 7): { x: number; y: number; z: number; shade: number }[] {
  const rand = seeded(seed);
  const seats: { x: number; y: number; z: number; shade: number }[] = [];
  for (let row = 0; row < C.rows; row++) {
    const r = innerRadius + C.firstRowGap + row * C.rowDepth;
    const count = Math.floor((2 * Math.PI * r) / C.seatSpacing);
    const offset = rand() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      // Empty seats, so it reads as a crowd rather than a pattern.
      if (rand() < C.emptySeatChance) continue;
      const a = offset + (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.02;
      seats.push({
        x: Math.cos(a) * r,
        y: row * C.rowRise + (rand() - 0.5) * 0.08,
        z: Math.sin(a) * r,
        shade: rand(),
      });
    }
  }
  return seats;
}

/**
 * @param flashes Camera flashes on or off. Off for players who ask the
 *   system for reduced motion: rapid flashing is exactly what that setting,
 *   and photosensitivity, is about.
 */
export function buildCrowd(innerRadius: number, floorY: number, flashes = true, seed = 7): Crowd {
  const group = new THREE.Group();
  group.name = "crowd";
  const seats = seatPositions(innerRadius, seed);

  // One shape for a seated person seen from the ring: a rounded body with a
  // head on it, which at this distance and in this light is all anyone is.
  const body = new THREE.CapsuleGeometry(0.2, 0.42, 3, 8);
  body.translate(0, 0.41, 0);
  const head = new THREE.SphereGeometry(0.11, 8, 6);
  head.translate(0, 0.86, 0);
  // Normals and UVs dropped: the material is unlit, and the two primitives
  // must share attributes to merge into one instanced draw.
  for (const g of [body, head]) {
    g.deleteAttribute("normal");
    g.deleteAttribute("uv");
  }
  const geometry = mergeGeometries([body, head])!;
  body.dispose();
  head.dispose();

  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true });
  const mesh = new THREE.InstancedMesh(geometry, material, seats.length);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const colour = new THREE.Color();
  seats.forEach((s, i) => {
    // Everyone faces the ring.
    q.setFromAxisAngle(up, Math.atan2(-s.x, -s.z));
    const scale = 0.9 + s.shade * 0.25;
    m.compose(new THREE.Vector3(s.x, floorY + s.y, s.z), q, new THREE.Vector3(scale, scale, scale));
    mesh.setMatrixAt(i, m);
    // Dim, slightly varied clothing: just enough to separate one silhouette
    // from the next against the dark.
    const v = C.shadeMin + s.shade * (C.shadeMax - C.shadeMin);
    colour.setRGB(v * (0.85 + s.shade * 0.3), v, v * (1.15 - s.shade * 0.3));
    mesh.setColorAt(i, colour);
  });
  group.add(mesh);

  // Camera flashes: a pool of additive points that pop and fade.
  const flashCount = C.flashPool;
  const flashGeo = new THREE.BufferGeometry();
  const flashPos = new Float32Array(flashCount * 3);
  const flashCol = new Float32Array(flashCount * 3);
  flashGeo.setAttribute("position", new THREE.BufferAttribute(flashPos, 3));
  flashGeo.setAttribute("color", new THREE.BufferAttribute(flashCol, 3));
  const flashMat = new THREE.PointsMaterial({
    size: 0.35,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const flashPoints = new THREE.Points(flashGeo, flashMat);
  flashPoints.frustumCulled = false;
  if (flashes) group.add(flashPoints);
  const life = new Float32Array(flashCount);
  const rand = seeded(seed * 31 + 1);

  const fire = () => {
    const slot = life.findIndex((l) => l <= 0);
    if (!flashes || slot < 0 || seats.length === 0) return;
    const s = seats[Math.floor(rand() * seats.length)];
    flashPos[slot * 3] = s.x;
    flashPos[slot * 3 + 1] = floorY + s.y + 0.8;
    flashPos[slot * 3 + 2] = s.z;
    life[slot] = C.flashSeconds;
  };

  return {
    group,
    update(dt) {
      if (rand() < C.flashesPerSecond * dt) fire();
      for (let i = 0; i < flashCount; i++) {
        if (life[i] > 0) life[i] = Math.max(0, life[i] - dt);
        // Bright at once, then gone: a flash, not a glow.
        const v = life[i] > 0 ? Math.pow(life[i] / C.flashSeconds, 3) : 0;
        flashCol[i * 3] = v;
        flashCol[i * 3 + 1] = v;
        flashCol[i * 3 + 2] = v * 0.95;
      }
      flashGeo.attributes.position.needsUpdate = true;
      flashGeo.attributes.color.needsUpdate = true;
    },
    burst() {
      for (let i = 0; i < C.burstFlashes; i++) fire();
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
      flashGeo.dispose();
      flashMat.dispose();
    },
  };
}
