// Identifies what the exported mesh's anonymous morph targets actually do.
//
// FBX2glTF drops morph target names (`targetNames` is absent and each target
// carries only position deltas), so the 117 shapes arrive unlabelled. That is
// the blocker for ever using them: facial impact reactions need to address
// "jaw open" or "brow lower", not "target 63".
//
// They can still be identified without rendering anything, by asking where on
// the body each one actually moves vertices:
//   - which bones those vertices are skinned to (via JOINTS_0 / WEIGHTS_0)
//   - where they sit vertically within the head, for face shapes
//   - how far they displace, and how many vertices they touch
//
// A shape confined to head-skinned vertices is an expression; one spread
// across the whole body is an identity/body shape. That distinction is what
// decides which are worth keeping for combat reactions.
//
// Usage: node analyze-morphs.mjs <in.glb> [out.json]

import { writeFileSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";

const [, , inPath, outPath] = process.argv;
if (!inPath) {
  console.error("usage: node analyze-morphs.mjs <in.glb> [out.json]");
  process.exit(1);
}

const doc = await new NodeIO().read(inPath);
const root = doc.getRoot();
const mesh = root.listMeshes()[0];
const prim = mesh.listPrimitives()[0];

const pos = prim.getAttribute("POSITION").getArray();
const jointsAttr = prim.getAttribute("JOINTS_0");
const weightsAttr = prim.getAttribute("WEIGHTS_0");
const joints = jointsAttr?.getArray();
const weights = weightsAttr?.getArray();
const skin = root.listSkins()[0];
const jointNodes = skin ? skin.listJoints() : [];
const vertexCount = pos.length / 3;

// Bones that make a shape "facial" rather than body-wide.
const FACE_BONE = /head|jaw|eye|brow|lip|mouth|nose|cheek|chin|teeth|tongue|face|ear/i;

console.log(`vertices: ${vertexCount}  targets: ${prim.listTargets().length}`);
const faceBones = jointNodes
  .map((n) => n.getName())
  .filter((n) => FACE_BONE.test(n));
console.log(`face-ish bones in rig (${faceBones.length}): ${faceBones.join(", ") || "(none)"}`);

// Vertical extent of head-skinned vertices, so face shapes can be placed as
// upper (brow/eyes) or lower (jaw/mouth) within the head itself.
const dominantBone = new Array(vertexCount).fill(-1);
if (joints && weights) {
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
    dominantBone[v] = best;
  }
}
const isFaceVert = dominantBone.map((j) =>
  j >= 0 && jointNodes[j] ? FACE_BONE.test(jointNodes[j].getName()) : false
);
let headMinY = Infinity;
let headMaxY = -Infinity;
for (let v = 0; v < vertexCount; v++) {
  if (!isFaceVert[v]) continue;
  const y = pos[v * 3 + 1];
  if (y < headMinY) headMinY = y;
  if (y > headMaxY) headMaxY = y;
}
const headSpan = headMaxY - headMinY;

const EPS = 1e-5;
const results = [];

prim.listTargets().forEach((target, i) => {
  const d = target.getAttribute("POSITION")?.getArray();
  if (!d) return;

  let moved = 0;
  let maxDisp = 0;
  let sumY = 0;
  let faceMoved = 0;
  const boneTally = new Map();

  for (let v = 0; v < vertexCount; v++) {
    const dx = d[v * 3];
    const dy = d[v * 3 + 1];
    const dz = d[v * 3 + 2];
    const mag = Math.hypot(dx, dy, dz);
    if (mag <= EPS) continue;

    moved++;
    if (mag > maxDisp) maxDisp = mag;
    sumY += pos[v * 3 + 1];
    if (isFaceVert[v]) faceMoved++;

    const b = dominantBone[v];
    if (b >= 0) boneTally.set(b, (boneTally.get(b) ?? 0) + 1);
  }

  if (moved === 0) {
    results.push({ index: i, moved: 0, kind: "empty" });
    return;
  }

  const faceShare = faceMoved / moved;
  const centroidY = sumY / moved;
  // Where within the head this sits, 0 = chin, 1 = crown.
  const headFrac = headSpan > 0 ? (centroidY - headMinY) / headSpan : null;

  const topBones = [...boneTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([b, n]) => `${jointNodes[b]?.getName() ?? b}:${((n / moved) * 100).toFixed(0)}%`);

  const kind =
    faceShare > 0.9 ? "face" : faceShare > 0.4 ? "mixed" : "body";

  let region = null;
  if (kind === "face" && headFrac !== null) {
    region = headFrac > 0.66 ? "upper (brow/eyes)" : headFrac > 0.33 ? "mid (cheek/nose)" : "lower (jaw/mouth)";
  }

  results.push({
    index: i,
    moved,
    coverage: moved / vertexCount,
    maxDisp,
    faceShare,
    headFrac,
    kind,
    region,
    topBones,
  });
});

const byKind = { face: 0, mixed: 0, body: 0, empty: 0 };
for (const r of results) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

console.log(
  `\nclassification: face=${byKind.face} mixed=${byKind.mixed} body=${byKind.body} empty=${byKind.empty}`
);

console.log("\n=== FACE-LOCALISED TARGETS (candidates for impact reactions) ===");
console.log(
  "idx".padStart(4) + "verts".padStart(8) + "maxDisp".padStart(10) + "  region".padEnd(22) + "top bones"
);
for (const r of results.filter((r) => r.kind === "face").sort((a, b) => b.maxDisp - a.maxDisp)) {
  console.log(
    String(r.index).padStart(4) +
      String(r.moved).padStart(8) +
      r.maxDisp.toFixed(5).padStart(10) +
      "  " + String(r.region ?? "").padEnd(20) +
      r.topBones.join(" ")
  );
}

console.log("\n=== BODY / IDENTITY TARGETS (candidates for body-type customization) ===");
const body = results.filter((r) => r.kind === "body");
console.log(`${body.length} targets, mean coverage ${(body.reduce((s, r) => s + r.coverage, 0) / (body.length || 1) * 100).toFixed(0)}% of vertices`);
for (const r of body.slice(0, 10)) {
  console.log(
    String(r.index).padStart(4) +
      String(r.moved).padStart(8) +
      r.maxDisp.toFixed(5).padStart(10) +
      "  coverage " + (r.coverage * 100).toFixed(0) + "%  " + r.topBones.join(" ")
  );
}
if (body.length > 10) console.log(`  ... and ${body.length - 10} more`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify({ source: inPath, vertexCount, results }, null, 2));
  console.log(`\nwrote ${outPath}`);
}
