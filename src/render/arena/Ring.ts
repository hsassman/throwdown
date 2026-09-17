import * as THREE from "three";
import {
  RING,
  platformHalfSpan,
  ringCorners,
  ropeHalfSpan,
  ropes,
} from "./ringSpec";

// A boxing ring, built to real dimensions from ringSpec.ts.
//
// Procedural for the same reasons the octagon is: no asset to license, the
// shape is four repetitions of one side, and it rescales from one number.
//
// Like the octagon, the CANVAS sits at y = 0. Fighters stand on the canvas, so
// making it the origin keeps a character's feet at y = 0 the way they are
// everywhere else; the platform and its skirt hang into negative y where
// nothing else has to reason about them.

export interface RingOptions {
  /** Override the inside-the-ropes span, metres. Defaults to championship. */
  insideRopes?: number;
  /** Include the skirt and platform sides. Off when only the canvas is in
   *  shot, where none of it is visible. */
  understructure?: boolean;
}

export interface Ring {
  group: THREE.Group;
  /** Half the distance between opposite ropes, metres. */
  halfSpan: number;
  dispose(): void;
}

export function buildRing(options: RingOptions = {}): Ring {
  const { insideRopes = RING.insideRopes, understructure = true } = options;
  const group = new THREE.Group();
  group.name = "ring";

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const half = ropeHalfSpan(insideRopes);
  const platform = platformHalfSpan(insideRopes);

  // --- Canvas -------------------------------------------------------------
  const canvasMat = track(
    new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.92 })
  );
  const canvasGeo = track(new THREE.BoxGeometry(platform * 2, 0.06, platform * 2));
  const canvas = new THREE.Mesh(canvasGeo, canvasMat);
  canvas.position.y = -0.03;
  canvas.receiveShadow = true;
  canvas.name = "canvas";
  group.add(canvas);

  // The apron reads as a different surface in every photograph of a ring —
  // usually a lighter band outside the ropes. One inset quad rather than a
  // second slab, so there is no z-fighting between two coplanar faces.
  const apronMat = track(
    new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.9 })
  );
  const insideGeo = track(new THREE.PlaneGeometry(half * 2, half * 2));
  const inside = new THREE.Mesh(insideGeo, apronMat);
  inside.rotation.x = -Math.PI / 2;
  inside.position.y = 0.001;
  inside.receiveShadow = true;
  inside.name = "canvas-inside";
  group.add(inside);

  // --- Corner posts and turnbuckle pads -----------------------------------
  const postMat = track(
    new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.4, metalness: 0.8 })
  );
  const padMat = track(
    new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.75 })
  );
  const postGeo = track(
    new THREE.CylinderGeometry(RING.postRadius, RING.postRadius, RING.postHeight, 12)
  );
  const padGeo = track(
    new THREE.CylinderGeometry(RING.padRadius, RING.padRadius, RING.padHeight, 16)
  );

  const cornerList = ringCorners(insideRopes);
  for (let i = 0; i < cornerList.length; i++) {
    const c = cornerList[i];
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(c.x, RING.postHeight / 2, c.z);
    post.castShadow = true;
    post.name = `post-${i}`;
    group.add(post);

    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(c.x, RING.padHeight / 2, c.z);
    pad.castShadow = true;
    pad.name = `pad-${i}`;
    group.add(pad);
  }

  // --- Ropes --------------------------------------------------------------
  const ropeMat = track(
    new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.85 })
  );
  const runs = ropes(insideRopes);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const dx = run.to.x - run.from.x;
    const dz = run.to.z - run.from.z;
    const length = Math.hypot(dx, dz);

    const geo = track(
      new THREE.CylinderGeometry(RING.ropeRadius, RING.ropeRadius, length, 8)
    );
    const rope = new THREE.Mesh(geo, ropeMat);
    // A CylinderGeometry runs along its own +Y, so it is laid down onto the
    // horizontal first and then turned to face along the side. Rotating about
    // Y by atan2(dx, dz) sends the (now horizontal) axis onto (dx, dz) — the
    // cylinder's axis after the -pi/2 pitch is +Z, not +X, which is why this
    // is atan2(dx, dz) and the octagon's flat panels are not.
    rope.rotation.set(-Math.PI / 2, 0, 0);
    rope.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
    rope.position.set(
      (run.from.x + run.to.x) / 2,
      run.height,
      (run.from.z + run.to.z) / 2
    );
    rope.castShadow = true;
    rope.name = `rope-${i}`;
    group.add(rope);
  }

  // --- Skirt --------------------------------------------------------------
  if (understructure) {
    const skirtMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x111827,
        roughness: 0.95,
        side: THREE.DoubleSide,
      })
    );
    for (let i = 0; i < 4; i++) {
      const geo = track(new THREE.PlaneGeometry(platform * 2, RING.skirtDrop));
      const skirt = new THREE.Mesh(geo, skirtMat);
      skirt.position.y = -RING.skirtDrop / 2;
      const angle = (i / 4) * Math.PI * 2;
      skirt.position.x = Math.sin(angle) * platform;
      skirt.position.z = Math.cos(angle) * platform;
      skirt.rotation.y = angle;
      skirt.name = `skirt-${i}`;
      group.add(skirt);
    }
  }

  return {
    group,
    halfSpan: half,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
