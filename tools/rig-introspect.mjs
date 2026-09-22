// Prints ground truth about the exported MHR rig: real child bones, bind-pose
// world positions/directions, and the model bounding box.
//
// Exists because the retargeting code was written against assumptions about
// the rig (which child continues each chain, which side "l_" is on in world
// space) and those assumptions produced a visibly broken character. Everything
// here is read from the actual asset. Run: node tools/rig-introspect.mjs

import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const path = process.argv[2] ?? "public/models/boxer_lod3.glb";
const buf = readFileSync(path);
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// Keep in step with DRIVEN_BONES in src/render/retargeting/rigJointMap.ts.
const DRIVEN = [
  "c_spine0",
  "c_spine1",
  "c_spine2",
  "c_spine3",
  "c_neck",
  "l_uparm",
  "l_lowarm",
  "r_uparm",
  "r_lowarm",
];

const v = (x) => `[${x.x.toFixed(4)}, ${x.y.toFixed(4)}, ${x.z.toFixed(4)}]`;

new GLTFLoader().parse(
  arrayBuffer,
  "",
  (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    console.log("=== MODEL BOUNDS (world, as loaded) ===");
    console.log("min", v(box.min), "max", v(box.max), "size", v(size));

    let skinned = null;
    scene.traverse((o) => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
    });
    console.log("skinned mesh:", skinned?.name, "bones:", skinned?.skeleton.bones.length);
    console.log("frustumCulled:", skinned?.frustumCulled);

    const byName = new Map();
    scene.traverse((o) => {
      if (o.name) byName.set(o.name, o);
    });

    console.log("\n=== DRIVEN BONE DETAIL ===");
    for (const name of DRIVEN) {
      const bone = byName.get(name);
      if (!bone) {
        console.log(`\n${name}: *** NOT FOUND ***`);
        continue;
      }
      const wp = new THREE.Vector3();
      bone.getWorldPosition(wp);
      console.log(`\n${name}  parent=${bone.parent?.name}  worldPos=${v(wp)}`);
      console.log(`  children (${bone.children.length}):`);
      for (const c of bone.children) {
        const cwp = new THREE.Vector3();
        c.getWorldPosition(cwp);
        const d = cwp.distanceTo(wp);
        const dir = cwp.clone().sub(wp);
        const dirStr = d > 1e-6 ? v(dir.normalize()) : "*** ZERO LENGTH - normalize() would yield NaN ***";
        console.log(
          `    ${c.name.padEnd(26)} isBone=${!!c.isBone} dist=${d.toFixed(5)} dir=${dirStr}`
        );
      }
    }

    // Which world side is each arm on? Decides whether MediaPipe "left"
    // should drive "l_" or "r_" once the character faces the camera.
    console.log("\n=== ARM SIDE CHECK (world X sign) ===");
    for (const n of ["l_uparm", "l_lowarm", "r_uparm", "r_lowarm", "l_wrist", "r_wrist"]) {
      const b = byName.get(n);
      if (!b) continue;
      const wp = new THREE.Vector3();
      b.getWorldPosition(wp);
      console.log(`  ${n.padEnd(10)} worldX=${wp.x.toFixed(4)}  (${wp.x < 0 ? "-X" : "+X"})  worldPos=${v(wp)}`);
    }

    // Which way does the body face? Compare a front landmark to a back one via
    // the head/neck chain and the hips, using world Z.
    console.log("\n=== FACING CHECK (world Z) ===");
    for (const n of ["c_spine0", "c_neck", "c_head", "root"]) {
      const b = byName.get(n);
      if (!b) continue;
      const wp = new THREE.Vector3();
      b.getWorldPosition(wp);
      console.log(`  ${n.padEnd(10)} worldZ=${wp.z.toFixed(4)} worldPos=${v(wp)}`);
    }
  },
  (err) => {
    console.error("parse failed:", err);
    process.exit(1);
  }
);
