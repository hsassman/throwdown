import * as THREE from "three";

// Procedural chain-link fencing.

export interface ChainLinkOptions {
  /** Corner-to-corner size of one diamond, metres. */
  aperture: number;
  /** Wire diameter, metres. */
  wire: number;
  /** Pixels across one diamond in the generated tile. */
  resolution?: number;
  colour?: string;
}

/** Builds the repeating diamond tile. */
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
