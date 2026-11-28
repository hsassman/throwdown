import * as THREE from "three";

/**
 * Finds the character's own skin among the skinned meshes under `root`.
 * Why this exists rather than an inline `traverse`
 */
export function findBodyMesh(root: THREE.Object3D): THREE.SkinnedMesh | null {
  // By name first -- the Blender pipeline (blender/scripts/01_import.py)
  // names the body node "body" on the way in, and glTF export preserves it.
  let named: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (o.name === "body" && (o as THREE.SkinnedMesh).isSkinnedMesh) {
      named = o as THREE.SkinnedMesh;
    }
  });
  if (named) return named;

  // Fallback for assets that predate the pipeline naming (or were not built
  // by it): largest skinned mesh.
  let best: THREE.SkinnedMesh | null = null;
  let bestCount = -1;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const n = m.geometry.getAttribute("position")?.count ?? 0;
    if (n > bestCount) {
      best = m;
      bestCount = n;
    }
  });
  return best;
}
