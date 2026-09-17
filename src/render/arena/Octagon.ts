import * as THREE from "three";
import { chainLinkTexture } from "./chainLink";
import {
  OCTAGON,
  circumradius,
  corners,
  walls,
  type Corner,
} from "./octagonSpec";

// A regulation octagon, built to real dimensions from octagonSpec.ts.
//
// Everything here is procedural. There is no cage asset to license, the shape
// is eight repetitions of one wall, and a modelled cage would be a ~3MB
// download for something describable in two numbers. It also means the whole
// structure rescales from `acrossFlats` alone if the spec ever changes — a
// training cage, a smaller practice ring — instead of being baked into
// vertices someone would have to re-export.
//
// The whole thing sits with the CANVAS at y = 0, not the ground. Fighters are
// placed on the canvas, so making it the origin means a character's feet go at
// y = 0 like they do everywhere else in this project; the platform and its
// legs hang down into negative y where nothing else has to reason about them.

/** Which wall carries the gate. 0 faces +Z (see corners() on the half-step
 *  rotation); 4 is the far wall, so the door does not sit between the default
 *  camera and the fighters. */
const GATE_WALL = 4;

export interface OctagonOptions {
  /** Override the wall-to-wall span, metres. Defaults to regulation. */
  acrossFlats?: number;
  /** Draw the chain-link. Off gives a clean structural view — useful for
   *  camera work and for screenshots where the mesh only obscures things. */
  fencing?: boolean;
  /** Include the platform legs and under-structure. Off when the arena is
   *  viewed from above the canvas only, where none of it is visible. */
  understructure?: boolean;
}

export interface Octagon {
  group: THREE.Group;
  /** Radius of the fighting surface, centre to corner, metres. */
  radius: number;
  /** Everything needing disposal. The group is added to a scene the caller
   *  owns, so it does not dispose that. */
  dispose(): void;
}

/** Builds a flat octagonal slab of the given radius and thickness. */
function octagonSlab(radius: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const pts = corners(radius);
  shape.moveTo(pts[0].x, pts[0].z);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].z);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  // The shape is authored on XY; the arena lives on XZ. Rotating the geometry
  // once here is cheaper and less error-prone than rotating every mesh that
  // uses it and then having to reason about which way its normals point.
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Canvas surface texture: a woven mat, not a flat colour. */
function canvasTexture(): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#2b2f36";
  ctx.fillRect(0, 0, size, size);

  // Tatami/canvas weave: alternating light and dark threads both ways. Drawn
  // rather than noised because a real mat's grain is directional, and
  // undirected noise reads as dirt instead of fabric.
  for (let i = 0; i < size; i += 3) {
    ctx.fillStyle = i % 6 === 0 ? "rgba(255,255,255,0.028)" : "rgba(0,0,0,0.05)";
    ctx.fillRect(i, 0, 1.5, size);
    ctx.fillRect(0, i, size, 1.5);
  }
  // Scuffing, so the centre of the mat does not look factory-fresh.
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
    ctx.beginPath();
    ctx.ellipse(
      Math.random() * size,
      Math.random() * size,
      2 + Math.random() * 14,
      1 + Math.random() * 4,
      Math.random() * Math.PI,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function buildOctagon(options: OctagonOptions = {}): Octagon {
  const acrossFlats = options.acrossFlats ?? OCTAGON.acrossFlats;
  const showFence = options.fencing ?? true;
  const showUnder = options.understructure ?? true;

  const radius = circumradius(acrossFlats);
  const outerRadius = circumradius(acrossFlats + OCTAGON.apron * 2);

  const group = new THREE.Group();
  group.name = "octagon";

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- Canvas -------------------------------------------------------------
  // The fighting surface. A separate, slightly inset slab from the platform so
  // the apron beyond the fence can be a different material — on a real
  // octagon the apron is the same mat, but it takes far less light and reading
  // them as one uniform sheet flattens the whole platform.
  const matTex = canvasTexture();
  if (matTex) {
    matTex.repeat.set(acrossFlats / 2, acrossFlats / 2);
    track(matTex);
  }
  const canvasThickness = 0.04;
  const canvasGeo = track(octagonSlab(outerRadius, canvasThickness));
  const canvasMat = track(
    new THREE.MeshStandardMaterial({
      map: matTex,
      color: matTex ? 0xffffff : 0x2b2f36,
      roughness: 0.94,
      metalness: 0,
    })
  );
  const canvasMesh = new THREE.Mesh(canvasGeo, canvasMat);
  canvasMesh.position.y = -canvasThickness;
  canvasMesh.receiveShadow = true;
  canvasMesh.name = "canvas";
  group.add(canvasMesh);

  // --- Platform edge and understructure -----------------------------------
  if (showUnder) {
    // The vinyl skirt: the red band wrapping the platform edge in both
    // reference images. Built as a slab rather than a ring of quads because
    // an eight-sided extrusion already has exactly the side faces needed.
    const skirtGeo = track(octagonSlab(outerRadius * 1.004, OCTAGON.skirtHeight));
    const skirtMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x8c1d1d,
        roughness: 0.45,
        metalness: 0.05,
      })
    );
    const skirt = new THREE.Mesh(skirtGeo, skirtMat);
    skirt.position.y = -OCTAGON.skirtHeight - canvasThickness;
    skirt.name = "skirt";
    group.add(skirt);

    // Scaffold legs down to the ground. Not visible from any fighting camera,
    // but the platform reads as floating the moment a camera drops to floor
    // level for a low-angle replay, which is a shot this game will want.
    const legH = OCTAGON.platformHeight - OCTAGON.skirtHeight - canvasThickness;
    if (legH > 0) {
      const legGeo = track(new THREE.BoxGeometry(0.12, legH, 0.12));
      const legMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x14161a,
          roughness: 0.7,
          metalness: 0.4,
        })
      );
      const inner = outerRadius * 0.62;
      for (const r of [outerRadius * 0.93, inner]) {
        for (const c of corners(r)) {
          const leg = new THREE.Mesh(legGeo, legMat);
          leg.position.set(
            c.x,
            -OCTAGON.skirtHeight - canvasThickness - legH / 2,
            c.z
          );
          group.add(leg);
        }
      }
    }
  }

  // --- Posts --------------------------------------------------------------
  // Eight padded corner posts, running the full fence height. The steel is
  // drawn separately from its foam so the pad can be the fat matte sausage it
  // is in the photograph rather than a coloured stripe on a pole.
  const postSteelGeo = track(
    new THREE.BoxGeometry(OCTAGON.postWidth, OCTAGON.fenceHeight, OCTAGON.postDepth)
  );
  const postSteelMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.5, metalness: 0.6 })
  );
  const padGeo = track(
    new THREE.CylinderGeometry(
      OCTAGON.postPadRadius,
      OCTAGON.postPadRadius,
      OCTAGON.fenceHeight * 0.97,
      16
    )
  );
  const padMat = track(
    new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.92, metalness: 0 })
  );

  const cornerPts: Corner[] = corners(radius);
  for (let i = 0; i < cornerPts.length; i++) {
    const c = cornerPts[i];
    const steel = new THREE.Mesh(postSteelGeo, postSteelMat);
    steel.position.set(c.x, OCTAGON.fenceHeight / 2, c.z);
    // Turn each post to face the centre, so its flat sides align with the two
    // walls meeting there instead of cutting across them at an angle.
    steel.rotation.y = Math.atan2(c.x, c.z);
    steel.castShadow = true;
    group.add(steel);

    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.set(c.x, (OCTAGON.fenceHeight * 0.97) / 2, c.z);
    pad.castShadow = true;
    group.add(pad);
  }

  // --- Fencing ------------------------------------------------------------
  const wallList = walls(radius);
  if (showFence) {
    const tex = chainLinkTexture({
      aperture: OCTAGON.meshAperture,
      wire: OCTAGON.meshWire,
    });

    const meshMat = track(
      new THREE.MeshStandardMaterial({
        map: tex?.map ?? null,
        alphaMap: tex?.alpha ?? null,
        color: tex ? 0xffffff : 0xb9bec6,
        transparent: true,
        // A hard cutout, not a blend. Blended alpha on eight overlapping
        // panels means the far side of the cage sorts against the near side
        // per-object, and whichever draws second wins — the mesh visibly
        // flickers between layers as the camera orbits. alphaTest resolves it
        // in the depth buffer instead, per fragment, where it cannot flicker.
        alphaTest: 0.4,
        side: THREE.DoubleSide,
        roughness: 0.55,
        metalness: 0.75,
      })
    );
    if (tex) {
      track(tex.map);
      track(tex.alpha);
    }

    for (let i = 0; i < wallList.length; i++) {
      const wall = wallList[i];
      const geo = track(new THREE.PlaneGeometry(wall.length, OCTAGON.fenceHeight));
      const panel = new THREE.Mesh(geo, meshMat);
      panel.position.set(wall.mid.x, OCTAGON.fenceHeight / 2, wall.mid.z);
      panel.rotation.y = wall.angle;
      panel.name = `fence-${i}`;
      group.add(panel);

      // Repeat count comes from the REAL aperture, so the diamonds are
      // physically 2 inches regardless of how long the wall is or what the
      // texture resolution happens to be. Rounded to whole diamonds in each
      // direction, otherwise the pattern is cut mid-link at the seam.
      if (tex) {
        // One clone of the map per panel would be the naive fix for per-panel
        // repeats; all eight walls are the same length, so one shared setting
        // is correct and costs one texture instead of eight.
        tex.map.repeat.set(
          Math.round(wall.length / OCTAGON.meshAperture),
          Math.round(OCTAGON.fenceHeight / OCTAGON.meshAperture)
        );
        tex.alpha.repeat.copy(tex.map.repeat);
      }
    }
  }

  // --- Rails and gate -----------------------------------------------------
  // Horizontal tubing top and bottom, plus a mid rail. These are what actually
  // sell the cage at a distance: the mesh fades to grey haze but the rails
  // hold their line, which is why the reference photo reads as a cage even in
  // thumbnail.
  const railMat = track(
    new THREE.MeshStandardMaterial({ color: 0x9c2222, roughness: 0.35, metalness: 0.5 })
  );
  const railRadius = 0.035;
  for (const wall of wallList) {
    for (const h of [0.02, OCTAGON.fenceHeight * 0.55, OCTAGON.fenceHeight - 0.03]) {
      const geo = track(
        new THREE.CylinderGeometry(railRadius, railRadius, wall.length, 10)
      );
      geo.rotateZ(Math.PI / 2);
      const rail = new THREE.Mesh(geo, railMat);
      rail.position.set(wall.mid.x, h, wall.mid.z);
      rail.rotation.y = wall.angle;
      rail.castShadow = true;
      group.add(rail);
    }
  }

  // The gate. A doorway frame standing slightly proud of its wall — a real
  // octagon door is a hinged section of the same fence, and modelling it as a
  // separate swinging panel buys nothing until something needs to open it.
  const gate = wallList[GATE_WALL];
  const gateW = gate.length * 0.42;
  const gateH = OCTAGON.fenceHeight * 0.82;
  const frameMat = track(
    new THREE.MeshStandardMaterial({ color: 0xb02525, roughness: 0.35, metalness: 0.5 })
  );
  const jamb = track(new THREE.BoxGeometry(0.06, gateH, 0.09));
  const header = track(new THREE.BoxGeometry(gateW + 0.12, 0.06, 0.09));
  const gateGroup = new THREE.Group();
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(jamb, frameMat);
    m.position.set((sx * gateW) / 2, gateH / 2, 0);
    gateGroup.add(m);
  }
  const head = new THREE.Mesh(header, frameMat);
  head.position.set(0, gateH, 0);
  gateGroup.add(head);
  gateGroup.position.set(gate.mid.x, 0, gate.mid.z);
  gateGroup.rotation.y = gate.angle;
  gateGroup.name = "gate";
  group.add(gateGroup);

  return {
    group,
    radius,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * The dim lighting rig the arena is meant to be seen under.
 *
 * Kept separate from the cage so the two can be reused apart — the menu's
 * background wants this lighting with a different subject, and a bright
 * inspection view wants the cage without it.
 *
 * The shape of it is not arbitrary. A broadcast fight is lit from a truss
 * directly above the canvas, which is why fighters have bright shoulders and
 * their eyes sit in shadow, and why the crowd behind them is black. Four
 * overhead spots reproduce that; the ambient is kept very low so the cage
 * falls off into darkness rather than sitting in an evenly lit grey room.
 */
export function buildArenaLighting(radius: number): {
  group: THREE.Group;
  dispose(): void;
} {
  const group = new THREE.Group();
  group.name = "arena-lighting";

  // Just enough bounce that unlit sides are dark, not pure black.
  group.add(new THREE.AmbientLight(0x2a3446, 0.55));
  // Cool from above, warm bounce off the canvas below.
  group.add(new THREE.HemisphereLight(0x5a6d8c, 0x3a2a22, 0.35));

  const truss = radius * 1.25;
  const height = 7.5;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const spot = new THREE.SpotLight(0xfff4e2, 260, 0, Math.PI / 7, 0.55, 2);
    spot.position.set(Math.sin(a) * truss, height, Math.cos(a) * truss);
    spot.target.position.set(0, 0, 0);
    // One shadow-casting light, not four. Four shadow maps on a scene with
    // this much alpha-tested geometry is the single most expensive thing that
    // could be done here, and the three extra maps would be near-identical.
    spot.castShadow = i === 0;
    if (spot.castShadow) {
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.0015;
    }
    group.add(spot);
    group.add(spot.target);
  }

  // A tight key straight down the middle, so a fighter at centre canvas is the
  // brightest thing in frame regardless of where the truss spots fall.
  const key = new THREE.SpotLight(0xffffff, 140, 0, Math.PI / 9, 0.7, 2);
  key.position.set(0, height + 1.5, 0);
  key.target.position.set(0, 0.9, 0);
  group.add(key);
  group.add(key.target);

  return {
    group,
    dispose() {
      group.traverse((o) => {
        const l = o as THREE.SpotLight;
        if (l.isSpotLight && l.shadow?.map) l.shadow.map.dispose();
      });
    },
  };
}
