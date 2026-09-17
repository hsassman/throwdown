// Removes the exported mesh's morph targets (facial/expression blendshapes).
//
// Why: this project's retargeting never drives a blendshape — facial joints
// and expressions have no tracked source from a single frontal webcam, so all
// 117 targets sit at weight 0 forever. They are not free: every target adds
// per-vertex position deltas the GPU must store and the vertex shader must
// consider, on a machine whose integrated GPU is simultaneously running pose
// inference. They also dominate the file size, which matters now that mobile
// is in scope (Draco only reached 8.09MB -> 7.84MB precisely because it
// compresses base geometry, not morph deltas).
//
// Skinning is deliberately left untouched — that IS driven.
//
// SELECTIVE KEEPING
//
// The 117 targets are not interchangeable. analyze-morphs.mjs established that
// their order maps exactly onto MHR's documented parameterization — the
// classification boundaries fall on 20/20/5/72, summing to 117:
//
//     0-19    body shape identity      -> body-type customization
//     20-39   head shape identity      -> face customization
//     40-44   hand shape identity
//     45-116  the 72 expression shapes -> facial impact reactions
//
// So `--keep=expression` yields a mesh that can wince and grimace without
// carrying the identity shapes, which are only useful at character-creation
// time and can be baked rather than shipped.
//
// Usage:
//   node strip-morphs.mjs <in.glb> <out.glb> [--keep=none|expression|identity|A-B]

import { NodeIO } from "@gltf-transform/core";
import { prune, dedup } from "@gltf-transform/functions";

const [, , inPath, outPath, ...flags] = process.argv;
if (!inPath || !outPath) {
  console.error(
    "usage: node strip-morphs.mjs <in.glb> <out.glb> [--keep=none|expression|identity|A-B]"
  );
  process.exit(1);
}

const keepArg = (flags.find((f) => f.startsWith("--keep=")) ?? "--keep=none").slice(7);

/** Target indices to preserve, per the MHR layout above. */
function keepRange(spec) {
  if (spec === "none") return null;
  if (spec === "expression") return [45, 116];
  if (spec === "identity") return [0, 44];
  const m = /^(\d+)-(\d+)$/.exec(spec);
  if (m) return [Number(m[1]), Number(m[2])];
  console.error(`unrecognised --keep value: ${spec}`);
  process.exit(1);
}
const keep = keepRange(keepArg);

const io = new NodeIO();
const doc = await io.read(inPath);
const root = doc.getRoot();

let targetsRemoved = 0;
let meshes = 0;

let targetsKept = 0;

for (const mesh of root.listMeshes()) {
  meshes++;
  for (const prim of mesh.listPrimitives()) {
    const targets = prim.listTargets();
    targets.forEach((target, i) => {
      const keepThis = keep !== null && i >= keep[0] && i <= keep[1];
      if (keepThis) {
        targetsKept++;
        // Name what survives. FBX2glTF dropped the original names, so without
        // this the kept shapes would be just as unaddressable as before —
        // which was the whole reason they couldn't be used.
        target.setName(`mhr_${i < 45 ? "identity" : "expression"}_${i}`);
        return;
      }
      targetsRemoved++;
      prim.removeTarget(target);
      target.dispose();
    });
  }
  // Weights must match the surviving target count, in order.
  mesh.setWeights(new Array(targetsKept).fill(0));
}

// Drop the accessors/buffer views the targets referenced, then merge anything
// now duplicated.
//
// keepAttributes: the default prune also removed TEXCOORD_0, because the
// material currently has no texture. That is correct by its own logic and
// wrong for this project — the skin texture and the impact damage painted on
// it both need UVs, and regenerating them after the fact is far more painful
// than carrying ~43KB of them now.
//
// keepLeaves: preserves the 77 empty `Collision_*` nodes. They carry no
// geometry and drive no deformation (verified), so they cost almost nothing,
// but they are the rig's own collision markers and deleting them would close
// a door for no real saving.
await doc.transform(
  prune({ keepAttributes: true, keepLeaves: true }),
  dedup()
);

await io.write(outPath, doc);

// Report what survived, so a silent loss of skinning can't go unnoticed.
const check = await io.read(outPath);
for (const mesh of check.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const semantics = prim.listSemantics().sort().join(", ");
    console.log(`  mesh "${mesh.getName()}" attributes: ${semantics}`);
    console.log(`  morph targets remaining: ${prim.listTargets().length}`);
  }
}
console.log(`skins: ${check.getRoot().listSkins().length}`);
const names = check.getRoot().listMeshes()[0]?.listPrimitives()[0]?.listTargets()
  .map((t) => t.getName());
if (names?.length) {
  console.log(`kept target names: ${names[0]} ... ${names[names.length - 1]}`);
}
console.log(
  `keep=${keepArg}: removed ${targetsRemoved}, kept ${targetsKept} morph targets ` +
    `across ${meshes} mesh(es) -> ${outPath}`
);
