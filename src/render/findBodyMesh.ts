import * as THREE from "three";

/**
 * Finds the character's own skin among the skinned meshes under `root`.
 * Why this exists rather than an inline `traverse`
 *
 * Every caller used to do this:
 *
 *     let mesh = null;
 *     root.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
 *
 * which takes the last skinned mesh in traversal order. That was correct for
 * exactly as long as the asset contained one skinned mesh, and it broke
 * silently the moment the Blender pipeline added eyeballs: the figure now
 * carries three skinned meshes (`body`, `eye_L`, `eye_R`), and "the last one"
 * is a 423-vertex eyeball.
 *
 * The failure is worth describing because it is not a crash. The texture
 * builder would have painted the body atlas onto an eyeball and left the body
 * itself untextured grey, and the UV map would have looked for a jaw in a
 * sphere. The test suite caught it as ten failing assertions about UVs, which
 * is a long way from the actual cause.
 *
 * Largest, not first. Traversal order is an accident of how the exporter wrote
 * the file, so "first" is no more principled than "last" - a re-export that
 * reorders nodes would flip it. Vertex count is a property of the geometry,
 * and the body outweighs any single piece of kit by a wide margin (5429
 * against 423 for an eye). Kit added later - gloves, shorts, boots - is also
 * skinned, so this only gets more important, not less.
 */
export function findBodyMesh(root: THREE.Object3D): THREE.SkinnedMesh | null {
  // By name first -- the Blender pipeline (blender/scripts/01_import.py)
  // names the body node "body" on the way in, and glTF export preserves it.
  //
  // This used to be "largest skinned mesh, no other signal", which broke the
  // moment a real-world shorts asset landed: 37679 verts after weight
  // transfer, dwarfing the body's 5429. The Python side of this pipeline hit
  // the identical bug (06_eyes.py generated every damage shape key against
  // the shorts instead of the body -- 0 vertices affected on all six) and was
  // fixed the same way; this mirrors that fix so the two sides of the
  // pipeline agree on which mesh is the body.
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
