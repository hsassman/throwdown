// Reports where each body part lives in the mesh's UV layout.
//
// Needed because the exported material carries no textures at all, so nothing
// so far has had to know the UV layout — but painting a bruise on the jaw
// means knowing which rectangle of texture space the head occupies.
// TEXCOORD_0 survives in the shipped mesh only because strip-morphs.mjs passes
// `keepAttributes: true`; the default prune dropped it precisely because no
// material referenced it.
//
// Regions are derived the same way the morph targets were identified: by which
// bone each vertex is skinned to. No rendering, no guessing.
//
// Usage: node tools/uv-regions.mjs [in.glb]

import { NodeIO } from "@gltf-transform/core";

const inPath = process.argv[2] ?? "public/models/boxer_lod3.glb";
const doc = await new NodeIO().read(inPath);
const root = doc.getRoot();
const mesh = root.listMeshes()[0];
const prim = mesh.listPrimitives()[0];

const uv = prim.getAttribute("TEXCOORD_0")?.getArray();
const pos = prim.getAttribute("POSITION").getArray();
const joints = prim.getAttribute("JOINTS_0")?.getArray();
const weights = prim.getAttribute("WEIGHTS_0")?.getArray();
const skin = root.listSkins()[0];
const jointNodes = skin ? skin.listJoints() : [];

if (!uv) {
  console.error("mesh has no TEXCOORD_0 — nothing can be textured");
  process.exit(1);
}

const vertexCount = pos.length / 3;
console.log(`vertices: ${vertexCount}   joints: ${jointNodes.length}`);

// Which bone dominates each vertex.
const dominant = new Array(vertexCount).fill(-1);
for (let v = 0; v < vertexCount; v++) {
  let best = -1;
  let bestW = 0;
  for (let k = 0; k < 4; k++) {
    const w = weights[v * 4 + k];
    if (w > bestW) {
      bestW = w;
      best = joints[v * 4 + k];
    }
  }
  dominant[v] = best;
}

/** Body regions, by bone-name pattern. Order matters: first match wins, so the
 * narrower patterns (hands, head) come before the limbs that contain them. */
const REGIONS = [
  ["head", /head|jaw|eye|teeth|tongue|neck/i],
  ["hand_l", /^l_(wrist|thumb|index|middle|ring|pinky)/i],
  ["hand_r", /^r_(wrist|thumb|index|middle|ring|pinky)/i],
  ["arm_l", /^l_(clavicle|uparm|lowarm)/i],
  ["arm_r", /^r_(clavicle|uparm|lowarm)/i],
  ["torso", /spine|root/i],
  ["leg_l", /^l_(upleg|lowleg|foot|ball|toe)/i],
  ["leg_r", /^r_(upleg|lowleg|foot|ball|toe)/i],
];

const regionOf = (boneName) => {
  for (const [name, re] of REGIONS) if (re.test(boneName)) return name;
  return "other";
};

const stats = new Map();
for (let v = 0; v < vertexCount; v++) {
  const b = dominant[v];
  const name = b >= 0 && jointNodes[b] ? jointNodes[b].getName() : "";
  const region = name ? regionOf(name) : "other";
  let s = stats.get(region);
  if (!s) {
    s = { n: 0, uMin: 1e9, uMax: -1e9, vMin: 1e9, vMax: -1e9, uSum: 0, vSum: 0 };
    stats.set(region, s);
  }
  const u = uv[v * 2];
  const w = uv[v * 2 + 1];
  s.n++;
  s.uSum += u;
  s.vSum += w;
  if (u < s.uMin) s.uMin = u;
  if (u > s.uMax) s.uMax = u;
  if (w < s.vMin) s.vMin = w;
  if (w > s.vMax) s.vMax = w;
}

console.log("\nregion        verts     u range          v range         centroid");
for (const [name, s] of [...stats].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    name.padEnd(12) +
      String(s.n).padStart(6) +
      `   ${s.uMin.toFixed(3)}-${s.uMax.toFixed(3)}` +
      `    ${s.vMin.toFixed(3)}-${s.vMax.toFixed(3)}` +
      `    ${(s.uSum / s.n).toFixed(3)}, ${(s.vSum / s.n).toFixed(3)}`
  );
}

// Overall UV extent, to see whether the layout fills the square.
let uMin = 1e9,
  uMax = -1e9,
  vMin = 1e9,
  vMax = -1e9;
for (let i = 0; i < uv.length; i += 2) {
  if (uv[i] < uMin) uMin = uv[i];
  if (uv[i] > uMax) uMax = uv[i];
  if (uv[i + 1] < vMin) vMin = uv[i + 1];
  if (uv[i + 1] > vMax) vMax = uv[i + 1];
}
console.log(
  `\noverall UV extent: u ${uMin.toFixed(3)}-${uMax.toFixed(3)}  v ${vMin.toFixed(3)}-${vMax.toFixed(3)}`
);

// Finer detail for the head, since facial impacts need sub-regions.
console.log("\n--- head sub-regions ---");
const headBones = new Map();
for (let v = 0; v < vertexCount; v++) {
  const b = dominant[v];
  const name = b >= 0 && jointNodes[b] ? jointNodes[b].getName() : "";
  if (!/head|jaw|eye|teeth|tongue|neck/i.test(name)) continue;
  let s = headBones.get(name);
  if (!s) {
    s = { n: 0, uSum: 0, vSum: 0, uMin: 1e9, uMax: -1e9, vMin: 1e9, vMax: -1e9 };
    headBones.set(name, s);
  }
  const u = uv[v * 2];
  const w = uv[v * 2 + 1];
  s.n++;
  s.uSum += u;
  s.vSum += w;
  if (u < s.uMin) s.uMin = u;
  if (u > s.uMax) s.uMax = u;
  if (w < s.vMin) s.vMin = w;
  if (w > s.vMax) s.vMax = w;
}
for (const [name, s] of [...headBones].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    name.padEnd(14) +
      String(s.n).padStart(6) +
      `   u ${s.uMin.toFixed(3)}-${s.uMax.toFixed(3)}  v ${s.vMin.toFixed(3)}-${s.vMax.toFixed(3)}` +
      `   centroid ${(s.uSum / s.n).toFixed(3)}, ${(s.vSum / s.n).toFixed(3)}`
  );
}
