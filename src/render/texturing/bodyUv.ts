import * as THREE from "three";

// Maps the character's body onto its texture, so bruises can be painted where
// punches actually landed.
// WHY THIS IS DERIVED RATHER THAN AUTHORED
//
// The exported material carries NO textures at all, so until now nothing had
// to know the UV layout. TEXCOORD_0 survives in the shipped mesh only because
// strip-morphs.mjs passes `keepAttributes: true` — the default prune removed
// it, correctly by its own logic, since no material referenced it. Keeping
// ~43KB of UVs on the chance they would be needed later is what makes this
// module possible at all without re-exporting.
//
// The layout was measured with tools/uv-regions.mjs, not guessed:
//
//     head    u 0.003-0.499   v 0.003-0.453    (c_jaw at v 0.306-0.412)
//     hands   u 0.504-0.997   v 0.039-0.463
//     torso   v 0.443-0.933, spanning the full width
//     legs    v 0.503-0.995
//
// The head owning a clean quadrant is what makes facial damage practical.

/** Where a landed strike shows up on the texture. */
export interface ImpactSite {
  /** UV coordinates, 0-1. */
  u: number;
  v: number;
}

export interface BodyUvMap {
  /** Zone key ("head/centre", "body/left", ...) to the UV it marks. */
  sites: Map<string, ImpactSite>;
  vertexCount: number;
}

/**
 * How far to either side an impact site sits, as a weight on the forward
 * direction rather than a distance.
 *
 * The first attempt placed a probe POINT out in front of the body and took the
 * nearest vertex. That collapsed the three lanes onto each other: pushing the
 * probe far enough forward to avoid picking the back of the skull (0.18) made
 * it much further away than the 0.055 lateral offset, so the closest vertex
 * was the nose tip whichever lane was asked for — the head lanes came out
 * 0.008 apart in UV, effectively identical.
 *
 * Choosing by DIRECTION from the part's centre instead has no such scale to
 * get wrong: it simply asks which surface vertex lies furthest round toward
 * the cheek, and works the same on any size of head.
 */
const HEAD_LANE_WEIGHT = 0.8;
const TORSO_LANE_WEIGHT = 0.85;
/** Slight downward bias so a centre head shot lands on the nose and mouth
 * rather than the forehead. */
const HEAD_DROP = 0.18;

/**
 * Which bone dominates each vertex, from the skinning weights. The same
 * technique that identified the 117 anonymous morph targets.
 */
export function dominantBones(geometry: THREE.BufferGeometry): Int32Array {
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const count = geometry.getAttribute("position").count;
  const out = new Int32Array(count).fill(-1);
  if (!skinIndex || !skinWeight) return out;

  for (let v = 0; v < count; v++) {
    let best = -1;
    let bestW = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w > bestW) {
        bestW = w;
        best = skinIndex.getComponent(v, k);
      }
    }
    out[v] = best;
  }
  return out;
}

/** Locates the impact sites on the texture. */
export function buildBodyUvMap(
  geometry: THREE.BufferGeometry,
  boneNames: string[],
  dominant: Int32Array
): BodyUvMap {
  const count = geometry.getAttribute("position").count;
  const sites = geometry.getAttribute("uv")
    ? locateImpactSites(geometry, boneNames, dominant)
    : new Map<string, ImpactSite>();

  return { sites, vertexCount: count };
}

/**
 * Finds the texture coordinate for each strike zone.
 *
 * Each site is the surface vertex of the relevant body part that faces
 * furthest in a given direction — forward for a centre shot, forward and
 * round for a cheek or a rib. See the note on HEAD_LANE_WEIGHT for why this
 * replaced a nearest-point-to-a-probe search.
 */
function locateImpactSites(
  geometry: THREE.BufferGeometry,
  boneNames: string[],
  dominant: Int32Array
): Map<string, ImpactSite> {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv")!;
  const sites = new Map<string, ImpactSite>();

  // Bind-space anchors. The rig faces +Z, so the front of the body is +Z.
  const anchorOf = (pattern: RegExp): THREE.Vector3 | null => {
    let n = 0;
    const acc = new THREE.Vector3();
    for (let v = 0; v < position.count; v++) {
      const b = dominant[v];
      if (b < 0 || !pattern.test(boneNames[b] ?? "")) continue;
      acc.x += position.getX(v);
      acc.y += position.getY(v);
      acc.z += position.getZ(v);
      n++;
    }
    return n > 0 ? acc.multiplyScalar(1 / n) : null;
  };

  const head = anchorOf(/^c_(head|jaw|eye|teeth)/i);
  const torso = anchorOf(/^c_spine[123]$/i);
  if (!head || !torso) return sites;

  /**
   * The surface vertex lying furthest round in `direction` from `anchor` —
   * i.e. the point of that body part that faces the given way.
   */
  const facingUv = (
    anchor: THREE.Vector3,
    direction: THREE.Vector3,
    restrict: RegExp
  ): ImpactSite | null => {
    const dir = direction.clone().normalize();
    let bestV = -1;
    let bestScore = -Infinity;
    for (let v = 0; v < position.count; v++) {
      const b = dominant[v];
      if (b < 0 || !restrict.test(boneNames[b] ?? "")) continue;
      const dx = position.getX(v) - anchor.x;
      const dy = position.getY(v) - anchor.y;
      const dz = position.getZ(v) - anchor.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      const score = (dx * dir.x + dy * dir.y + dz * dir.z) / len;
      if (score > bestScore) {
        bestScore = score;
        bestV = v;
      }
    }
    if (bestV < 0) return null;
    return { u: uv.getX(bestV), v: uv.getY(bestV) };
  };

  const HEAD_BONES = /^c_(head|jaw|eye|teeth)/i;
  const TORSO_BONES = /^c_spine[0123]$/i;

  const lanes: [string, number][] = [
    ["left", 1],
    ["centre", 0],
    ["right", -1],
  ];
  // "left" and "right" are reported from the PUNCHER's point of view, and the
  // target faces them, so the puncher's left lands on the target's own right
  // side — world -X on a +Z-facing rig. Hence the sign flip.
  for (const [lane, dir] of lanes) {
    const hit = facingUv(
      head,
      new THREE.Vector3(-dir * HEAD_LANE_WEIGHT, -HEAD_DROP, 1),
      HEAD_BONES
    );
    if (hit) sites.set(`head/${lane}`, hit);

    const body = facingUv(
      torso,
      new THREE.Vector3(-dir * TORSO_LANE_WEIGHT, 0, 1),
      TORSO_BONES
    );
    if (body) sites.set(`body/${lane}`, body);
  }

  return sites;
}
