import * as THREE from "three";
import type { BodyUvMap, ImpactSite } from "./bodyUv";
import { TEXTURE_CONFIG } from "../../config/tuning";

// Builds the character's texture and accumulates visible damage on it.
//
// The mesh ships with a single untextured `DefaultMaterial`, so the figures
// render as flat grey putty. This paints skin onto them, plus bruising that
// appears where punches actually landed.
//
// Layering
//
// `base` holds the skin and never changes. `map` is what the GPU samples: base
// blitted, then bruises drawn over it. Repainting is one canvas-to-canvas blit
// plus a handful of gradients, so damage can fade over time cheaply.

export interface Bruise {
  u: number;
  v: number;
  /** 0-1, drives size and opacity. */
  strength: number;
  /** Seconds since it landed, for colour progression. */
  age: number;
}

export interface BodyTextureOptions {
  skin: string;
}

export interface BodyTexture {
  map: THREE.CanvasTexture;
  /** The canvas the GPU samples. Exposed so an overlay (facial damage) can
   *  size itself to it. Draw into it only from inside `setOverlay`. */
  canvas: HTMLCanvasElement;
  /** Records a hit at a named zone ("head/left"). Unknown zones are ignored. */
  addBruise(zone: string, strength: number): void;
  /** Ages and repaints the damage. Cheap when nothing has changed. */
  update(dt: number): void;
  clear(): void;
  dispose(): void;
  readonly bruiseCount: number;
  /**
   * Draws on top of the skin and bruises, on every repaint.
   *
   * Facial damage composes here rather than painting the canvas itself. This
   * texture rebuilds from the clean base each repaint, so anything drawn
   * outside that cycle is wiped on the next bruise tick - and anything drawn
   * cumulatively would darken forever and never fade.
   */
  setOverlay(
    draw: ((ctx: CanvasRenderingContext2D, size: number) => void) | null
  ): void;
  /** Forces a repaint on the next update. Needed because overlay state can
   *  change with no bruise activity at all, which is the normal case for a
   *  face that is simply aging. */
  markDirty(): void;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

/** Fine mottling, so skin does not read as flat plastic. */
function addGrain(ctx: CanvasRenderingContext2D, size: number): void {
  const count = Math.floor((size * size) / TEXTURE_CONFIG.grainDensity);
  ctx.globalAlpha = TEXTURE_CONFIG.grainAlpha;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1 + Math.random() * 2.5;
    ctx.fillStyle = Math.random() < 0.5 ? "#000" : "#fff";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Bruise colour over time. Fresh impacts are red and angry; they darken toward
 * purple as they set, which is both what a real bruise does and a readable
 * signal of which hits are recent.
 */
function bruiseColour(age: number, alpha: number): [string, string] {
  const t = THREE.MathUtils.clamp(age / TEXTURE_CONFIG.bruiseSetSeconds, 0, 1);
  const fresh = new THREE.Color(TEXTURE_CONFIG.bruiseFresh);
  const set = new THREE.Color(TEXTURE_CONFIG.bruiseSet);
  const mid = fresh.clone().lerp(set, t);
  const edge = mid.clone().multiplyScalar(1.25);
  return [
    `rgba(${(mid.r * 255) | 0}, ${(mid.g * 255) | 0}, ${(mid.b * 255) | 0}, ${alpha})`,
    `rgba(${(edge.r * 255) | 0}, ${(edge.g * 255) | 0}, ${(edge.b * 255) | 0}, 0)`,
  ];
}

export function buildBodyTexture(
  geometry: THREE.BufferGeometry,
  uvMap: BodyUvMap,
  options: BodyTextureOptions
): BodyTexture | null {
  if (typeof document === "undefined") return null;
  if (!geometry.getAttribute("uv")) return null;

  const size = TEXTURE_CONFIG.size;
  const base = makeCanvas(size);
  const baseCtx = base.getContext("2d");
  const mapCanvas = makeCanvas(size);
  const mapCtx = mapCanvas.getContext("2d");
  if (!baseCtx || !mapCtx) return null;

  baseCtx.fillStyle = options.skin;
  baseCtx.fillRect(0, 0, size, size);
  addGrain(baseCtx, size);

  mapCtx.drawImage(base, 0, 0);

  const texture = new THREE.CanvasTexture(mapCanvas);
  // glTF UVs have their origin at the top-left and GLTFLoader sets flipY=false
  // on the textures it creates. A CanvasTexture defaults to flipY=true, which
  // would render the whole body upside down in texture space, so it has to be
  // matched explicitly.
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const bruises: Bruise[] = [];
  let overlay: ((ctx: CanvasRenderingContext2D, size: number) => void) | null = null;
  let dirty = false;
  let sinceRepaint = 0;

  const repaint = () => {
    mapCtx.clearRect(0, 0, size, size);
    mapCtx.drawImage(base, 0, 0);
    for (const b of bruises) {
      const fade = 1 - THREE.MathUtils.clamp(b.age / TEXTURE_CONFIG.bruiseLifeSeconds, 0, 1);
      const alpha = b.strength * fade * TEXTURE_CONFIG.bruiseAlpha;
      if (alpha <= 0.004) continue;
      const radius = size * TEXTURE_CONFIG.bruiseRadius * (0.6 + b.strength * 0.6);
      const x = b.u * size;
      const y = b.v * size;
      const [inner, outer] = bruiseColour(b.age, alpha);
      const g = mapCtx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      mapCtx.fillStyle = g;
      mapCtx.beginPath();
      mapCtx.arc(x, y, radius, 0, Math.PI * 2);
      mapCtx.fill();
    }
    // Overlay last, so facial damage sits on top of body bruising instead of
    // being buried under the next bruise drawn near the head.
    if (overlay) overlay(mapCtx, size);
    texture.needsUpdate = true;
  };

  return {
    map: texture,
    canvas: mapCanvas,
    setOverlay(draw) {
      overlay = draw;
      dirty = true;
    },
    markDirty() {
      dirty = true;
    },
    get bruiseCount() {
      return bruises.length;
    },
    addBruise(zone: string, strength: number) {
      const site: ImpactSite | undefined = uvMap.sites.get(zone);
      if (!site) return;
      // Scatter slightly, so a combination to one zone reads as several
      // separate marks instead of one ever-darkening dot.
      const jitter = TEXTURE_CONFIG.bruiseJitter;
      bruises.push({
        u: site.u + (Math.random() - 0.5) * jitter,
        v: site.v + (Math.random() - 0.5) * jitter,
        strength: THREE.MathUtils.clamp(strength, 0, 1),
        age: 0,
      });
      if (bruises.length > TEXTURE_CONFIG.maxBruises) bruises.shift();
      dirty = true;
    },
    update(dt: number) {
      if (bruises.length === 0) {
        if (dirty) {
          repaint();
          dirty = false;
        }
        return;
      }
      for (const b of bruises) b.age += dt;
      // Drop faded bruises so the list cannot grow without bound.
      for (let i = bruises.length - 1; i >= 0; i--) {
        if (bruises[i].age > TEXTURE_CONFIG.bruiseLifeSeconds) bruises.splice(i, 1);
      }
      sinceRepaint += dt;
      // Damage fades over many seconds, so repainting every rendered frame
      // would burn a canvas blit 60 times a second to show a change no one can
      // see. A few times a second is indistinguishable and effectively free.
      if (dirty || sinceRepaint >= TEXTURE_CONFIG.repaintInterval) {
        repaint();
        dirty = false;
        sinceRepaint = 0;
      }
    },
    clear() {
      bruises.length = 0;
      repaint();
    },
    dispose() {
      texture.dispose();
    },
  };
}
