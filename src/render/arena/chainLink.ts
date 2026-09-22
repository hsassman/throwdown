import * as THREE from "three";

// Procedural chain-link fencing.
//
// Why a texture and not geometry
//
// Modelled wire is the obvious answer and the wrong one. One wall of 2-inch
// diamonds is about 140 x 70 = ~9800 links; at even 40 triangles for a link's
// tube that is ~400k triangles per panel and 3.1M for the cage, before a
// single fighter is drawn. The mesh is also the one thing in the scene the
// camera is almost always looking through rather than at.
//
// So: one alpha-masked quad per wall, with the diamond pattern drawn into a
// tiling texture. The cost is that the wire has no thickness in silhouette;
// the mitigation is that real chain-link seen at fight distance is mostly a
// grey haze anyway, and the diamonds still read correctly because the pattern
// is generated at the true physical aperture rather than eyeballed.
//
// The tile is one diamond, repeated by the sampler. Drawing a whole wall into
// a texture instead would need a ~4096px map to keep the wire crisp, and would
// have to be regenerated whenever a wall's size changed.

export interface ChainLinkOptions {
  /** Corner-to-corner size of one diamond, metres. */
  aperture: number;
  /** Wire diameter, metres. */
  wire: number;
  /** Pixels across one diamond in the generated tile. */
  resolution?: number;
  colour?: string;
}

/**
 * Builds the repeating diamond tile.
 *
 * Returns null in a non-DOM environment (tests, SSR) rather than throwing, so
 * the arena's geometry can still be constructed and asserted headlessly.
 */
export function chainLinkTexture(options: ChainLinkOptions): {
  map: THREE.CanvasTexture;
  alpha: THREE.CanvasTexture;
} | null {
  if (typeof document === "undefined") return null;

  const res = options.resolution ?? 128;
  const colour = options.colour ?? "#d8dce2";
  // Wire width in tile pixels, from the real ratio. A 0.18" wire in a 2"
  // aperture is 9% of the tile - thin, but never thinner than one pixel or the
  // canvas rasteriser drops it entirely and the fence renders invisible.
  const w = Math.max(1.4, (options.wire / options.aperture) * res);

  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, res, res);
  ctx.lineWidth = w;
  ctx.lineCap = "square";
  ctx.strokeStyle = colour;

  // One diamond = two crossing diagonals. Each is drawn three times - once
  // through the tile and once shifted by a full tile in each direction - so
  // the strokes meet exactly at the seam instead of stopping a half-width
  // short and leaving a visible grid of dashes when tiled.
  const diagonals: [number, number, number, number][] = [
    [-res, 0, res, res * 2],
    [-res, -res, res * 2, res * 2],
    [0, -res, res * 2, res],
    [-res, res, res * 2, -res * 2],
    [-res, res * 2, res * 2, -res],
    [-res, res * 2 - res, res * 2, -res * 2 + res],
  ];
  for (const [x0, y0, x1, y1] of diagonals) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // A galvanised wire is not evenly lit around its circumference. A single
  // highlight pass down one side of every stroke is enough to stop the mesh
  // reading as a flat printed pattern under the dim key light.
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(1, w * 0.35);
  ctx.strokeStyle = "#ffffff";
  for (const [x0, y0, x1, y1] of diagonals) {
    ctx.beginPath();
    ctx.moveTo(x0, y0 - w * 0.3);
    ctx.lineTo(x1, y1 - w * 0.3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  // The mesh is the worst case in the scene for aliasing: a high-frequency
  // pattern viewed at a grazing angle, which is exactly what anisotropic
  // filtering exists for. Without it the far side of the cage boils.
  map.anisotropy = 8;

  // The same canvas serves as the alpha mask. Its RGB is the wire colour and
  // its alpha is 1 on wire / 0 in the holes, which is precisely the mask the
  // material wants, so no second canvas is needed.
  const alpha = map.clone();
  alpha.colorSpace = THREE.NoColorSpace;
  alpha.needsUpdate = true;

  return { map, alpha };
}
