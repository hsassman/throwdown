import * as THREE from "three";
import { artTexture } from "./artTextures";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CROWD_CONFIG as C } from "../../config/tuning";

// Seated silhouette rows and a rear balcony occupy different
// world radii. Camera motion creates parallax through ordinary perspective.

export interface Crowd {
  group: THREE.Group;
  /** Advances the flashes. `dt` in seconds. */
  update(dt: number, active?: boolean): void;
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
  const galleryMap = artTexture("silhouette-gallery");
  const galleryDistance = innerRadius + 16;
  const galleryGeometry = new THREE.CylinderGeometry(galleryDistance, galleryDistance, 5.2, 72, 1, true);
  const galleryMaterial = new THREE.MeshBasicMaterial({
    map: galleryMap, color: 0x8892a4, side: THREE.BackSide,
  });
  if (galleryMap) {
    galleryMap.repeat.x = Math.round(2 * Math.PI * galleryDistance / 15.6);
    const gallery = new THREE.Mesh(galleryGeometry, galleryMaterial);
    gallery.position.y = floorY + 4.8;
    group.add(gallery);
  }
  const seats = seatPositions(innerRadius, seed);
  const bannerMap = artTexture("fight-banner");
  const bannerGeometry = new THREE.PlaneGeometry(4.5, 1.5);
  const bannerMaterial = new THREE.MeshBasicMaterial({ map: bannerMap, color: 0xb0a090 });
  if (bannerMap) {
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      const banner = new THREE.Mesh(bannerGeometry, bannerMaterial);
      banner.position.set(Math.sin(angle) * (innerRadius + 14.4), floorY + 4.7, Math.cos(angle) * (innerRadius + 14.4));
      banner.rotation.y = angle + Math.PI;
      group.add(banner);
    }
  }

  // Only the atlas alpha is rendered. Clothing and faces drop out entirely,
  // while the outlines keep different hair, shoulder and arm shapes.
  const silhouetteMap = artTexture("crowd-ringside");
  const geometry = silhouetteMap
    ? new THREE.PlaneGeometry(0.59, 0.78).translate(0, 0.39, 0)
    : silhouette();
  const material = new THREE.MeshBasicMaterial({ map: silhouetteMap, alphaTest: silhouetteMap ? 0.5 : 0, fog: true });
  if (silhouetteMap) {
    const variants = Float32Array.from(seats, seat => Math.floor(seat.shade * 16));
    geometry.setAttribute("spectatorVariant", new THREE.InstancedBufferAttribute(variants, 1));
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float spectatorVariant;")
        .replace("#include <uv_vertex>", `#include <uv_vertex>
          float cell = mod(spectatorVariant, 8.0);
          float horizontal = mix(vMapUv.x, 1.0 - vMapUv.x, step(8.0, spectatorVariant));
          vMapUv.x = (mix(0.015, 0.985, horizontal) + mod(cell, 4.0)) * 0.25;
          vMapUv.y = (mix(0.009, 0.991, vMapUv.y) + 1.0 - floor(cell / 4.0)) * 0.5;`);
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb = vec3(1.0);",
      );
    };
  }
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
    const scale = 0.68 + s.shade * 0.16;
    m.compose(new THREE.Vector3(s.x, floorY + C.seatBase + s.y, s.z), q, new THREE.Vector3(scale, scale, scale));
    mesh.setMatrixAt(i, m);
    // Dim, slightly varied clothing: just enough to separate one silhouette
    // from the next against the dark.
    const v = C.shadeMin + s.shade * (C.shadeMax - C.shadeMin);
    colour.setRGB(v * (0.85 + s.shade * 0.3), v, v * (1.15 - s.shade * 0.3));
    mesh.setColorAt(i, colour);
  });
  group.add(mesh);
  const terraceParts: THREE.BufferGeometry[] = [];
  for (let row = 0; row < C.rows; row++) {
    const radius = innerRadius + C.firstRowGap + row * C.rowDepth;
    terraceParts.push(new THREE.RingGeometry(radius - C.rowDepth / 2, radius + C.rowDepth / 2, 64)
      .rotateX(-Math.PI / 2).translate(0, floorY + C.seatBase + row * C.rowRise - 0.03, 0));
  }
  const terraceGeometry = mergeGeometries(terraceParts)!;
  terraceParts.forEach(part => part.dispose());
  const terraceMaterial = new THREE.MeshBasicMaterial({ color: 0x14151b });
  group.add(new THREE.Mesh(terraceGeometry, terraceMaterial));

  // Camera flashes: a pool of additive points that pop and fade.
  const flashCount = C.flashPool;
  const flashGeo = new THREE.BufferGeometry();
  const flashPos = new Float32Array(flashCount * 3);
  const flashCol = new Float32Array(flashCount * 3);
  flashGeo.setAttribute("position", new THREE.BufferAttribute(flashPos, 3));
  flashGeo.setAttribute("color", new THREE.BufferAttribute(flashCol, 3));
  const flashMap = flashes ? flashTexture() : null;
  const flashMat = new THREE.PointsMaterial({
    size: 0.48,
    map: flashMap,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
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
    flashPos[slot * 3] = s.x * 0.982;
    flashPos[slot * 3 + 1] = floorY + C.seatBase + s.y + 0.66;
    flashPos[slot * 3 + 2] = s.z * 0.982;
    life[slot] = C.flashSeconds;
  };

  return {
    group,
    update(dt, active = true) {
      flashPoints.visible = active;
      if (!flashes || !active) return;

      if (rand() < C.flashesPerSecond * dt) fire();
      for (let i = 0; i < flashCount; i++) {
        if (life[i] > 0) life[i] = Math.max(0, life[i] - dt);
        // Bright at once, then gone: a flash, not a glow.
        const v = life[i] > 0 ? Math.pow(life[i] / C.flashSeconds, 2) : 0;
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
      galleryMap?.dispose();
      galleryGeometry.dispose();
      galleryMaterial.dispose();
      silhouetteMap?.dispose();
      flashMap?.dispose();
      terraceGeometry.dispose();
      terraceMaterial.dispose();
      bannerMap?.dispose();
      bannerGeometry.dispose();
      bannerMaterial.dispose();
      geometry.dispose();
      material.dispose();
      mesh.dispose();
      flashGeo.dispose();
      flashMat.dispose();
    },
  };
}

function silhouette() {
  const body = new THREE.CapsuleGeometry(0.2, 0.42, 3, 8).translate(0, 0.41, 0);
  const head = new THREE.SphereGeometry(0.11, 8, 6).translate(0, 0.86, 0);
  const geometry = mergeGeometries([body, head])!;
  body.dispose();
  head.dispose();
  return geometry;
}

function flashTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(255,255,255,1)");
  glow.addColorStop(0.17, "rgba(255,255,255,0.94)");
  glow.addColorStop(0.42, "rgba(207,226,255,0.26)");
  glow.addColorStop(1, "rgba(174,200,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
