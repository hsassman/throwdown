import * as THREE from "three";
import { artTexture } from "./artTextures";

/** Bounded pool: long fights never accumulate unbounded geometry or textures. */
export function buildBloodDecals() {
  const group = new THREE.Group();
  group.name = "blood-decals";
  const map = artTexture("blood");
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshStandardMaterial({
    map, transparent: true, opacity: 0.72, roughness: 0.55,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const pool = Array.from({ length: 16 }, () => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });
  let cursor = 0;
  return {
    group,
    add(seed: number, centerZ: number) {
      if (!map) return;
      const mesh = pool[cursor++ % pool.length];
      mesh.visible = true;
      mesh.position.set(Math.sin(seed * 2.4) * 1.3, 0.008, centerZ + Math.cos(seed * 1.7) * 1.2);
      mesh.rotation.z = seed * 2.399;
      mesh.scale.setScalar(0.25 + (seed % 5) * 0.07);
    },
    dispose() { geometry.dispose(); material.dispose(); map?.dispose(); },
  };
}
