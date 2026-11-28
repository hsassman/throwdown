import * as THREE from "three";
import { FACE_CONFIG } from "../../config/tuning";
import type { FaceDamageState, FacePainter } from "./faceDamage";
import type { ImpactSite } from "../texturing/bodyUv";

// The painted half of facial damage: eyes, blood, discolouration.
// Why the eyes are painted here rather than shipped in the mesh

export interface FaceFeatureUv {
  eyeLeft: ImpactSite;
  eyeRight: ImpactSite;
  jaw: ImpactSite;
  /** Radius of an eye in UV units, from the spread of its vertices. */
  eyeRadius: number;
}

/**
 * Locates the facial features in UV space, from the vertices weighted to each
 * facial bone.
 */
export function locateFaceFeatures(
  geometry: THREE.BufferGeometry,
  boneNames: string[],
  dominant: Int32Array,
  /** Bind-pose positions of the eye bones, in geometry space. */
  eyeBindPositions?: { left: THREE.Vector3; right: THREE.Vector3 } | null
): FaceFeatureUv | null {
  const uv = geometry.getAttribute("uv");
  if (!uv) return null;

  const index = new Map<string, number>();
  boneNames.forEach((n, i) => index.set(n, i));

  /** UV of the surface vertex closest to a point, restricted to head skin. */
  const nearestHeadUv = (target: THREE.Vector3) => {
    const pos = geometry.getAttribute("position");
    const headBone = index.get("c_head");
    const jawBone = index.get("c_jaw");
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < dominant.length; i++) {
      const b = dominant[i];
      // Only head and jaw skin. Without this the search can latch onto a
      // shoulder vertex that happens to be closer in a T-pose.
      if (b !== headBone && b !== jawBone) continue;
      const dx = pos.getX(i) - target.x;
      const dy = pos.getY(i) - target.y;
      const dz = pos.getZ(i) - target.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    return { u: uv.getX(best), v: uv.getY(best), radius: 0 };
  };

  const gather = (name: string) => {
    const bone = index.get(name);
    if (bone === undefined) return null;
    let u = 0;
    let v = 0;
    let n = 0;
    let maxU = -Infinity;
    let minU = Infinity;
    let maxV = -Infinity;
    let minV = Infinity;
    for (let i = 0; i < dominant.length; i++) {
      if (dominant[i] !== bone) continue;
      const a = uv.getX(i);
      const b = uv.getY(i);
      u += a;
      v += b;
      n++;
      if (a > maxU) maxU = a;
      if (a < minU) minU = a;
      if (b > maxV) maxV = b;
      if (b < minV) minV = b;
    }
    if (n === 0) return null;
    return {
      u: u / n,
      v: v / n,
      radius: Math.max(maxU - minU, maxV - minV) / 2,
    };
  };

  // Eyes: by weight if the rig ever gains eye weights, otherwise by proximity
  // to the eye bone. On the shipped asset it is always the latter.
  const l = gather("l_eye") ?? (eyeBindPositions ? nearestHeadUv(eyeBindPositions.left) : null);
  const r = gather("r_eye") ?? (eyeBindPositions ? nearestHeadUv(eyeBindPositions.right) : null);
  const j = gather("c_jaw");
  if (!l || !r || !j) return null;

  // The jaw island's own extent is the only reliable scale reference here,
  // since the eye "radius" from a single nearest vertex is zero by
  // construction. An eye is roughly a sixth of the jaw's UV footprint.
  const eyeRadius =
    Math.max(l.radius, r.radius) > 0
      ? Math.max(l.radius, r.radius) * FACE_CONFIG.eyeRadiusScale
      : j.radius * FACE_CONFIG.eyeRadiusOfJaw;

  return {
    eyeLeft: { u: l.u, v: l.v },
    eyeRight: { u: r.u, v: r.v },
    jaw: { u: j.u, v: j.v },
    eyeRadius,
  };
}

export interface FacePainterOptions {
  features: FaceFeatureUv;
  /** Canvas to draw into - the same one the body texture uses. */
  canvas: HTMLCanvasElement;
  /** The head's own UV island, painted opaque on a canvas the size of
   *  `canvas`. See headIslandMask. */
  mask?: HTMLCanvasElement | null;
}

/** The head and jaw skin's footprint in UV space, as an opaque-on-clear mask. */
export function headIslandMask(
  geometry: THREE.BufferGeometry,
  boneNames: string[],
  dominant: Int32Array,
  size: number
): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return null;
  const uv = geometry.getAttribute("uv");
  if (!uv) return null;
  const head = boneNames.indexOf("c_head");
  const jaw = boneNames.indexOf("c_jaw");
  if (head < 0 && jaw < 0) return null;
  const onHead = (i: number) => dominant[i] === head || dominant[i] === jaw;
  const index = geometry.getIndex();
  const count = index ? index.count : uv.count;
  const at = (k: number) => (index ? index.getX(k) : k);
  const path = new Path2D();
  let any = false;
  for (let k = 0; k + 2 < count; k += 3) {
    const a = at(k);
    const b = at(k + 1);
    const c = at(k + 2);
    if (!onHead(a) || !onHead(b) || !onHead(c)) continue;
    path.moveTo(uv.getX(a) * size, uv.getY(a) * size);
    path.lineTo(uv.getX(b) * size, uv.getY(b) * size);
    path.lineTo(uv.getX(c) * size, uv.getY(c) * size);
    path.closePath();
    any = true;
  }
  if (!any) return null;
  const mask = document.createElement("canvas");
  mask.width = size;
  mask.height = size;
  const mctx = mask.getContext("2d");
  if (!mctx) return null;
  mctx.fillStyle = "#fff";
  mctx.fill(path, "nonzero");
  // Seams: a triangle's antialiased edge is half transparent, and the damage
  // should reach the island's border rather than stop a pixel short of it.
  mctx.lineWidth = 2;
  mctx.strokeStyle = "#fff";
  mctx.stroke(path);
  return mask;
}

export function createFacePainter(options: FacePainterOptions): FacePainter | null {
  const target = options.canvas.getContext("2d");
  if (!target) return null;
  // With a mask, damage is drawn on a scratch layer, cut to the head island
  // and composited; without one, straight onto the texture as before.
  const layer = options.mask ? document.createElement("canvas") : null;
  if (layer) {
    layer.width = options.canvas.width;
    layer.height = options.canvas.height;
  }
  const ctx = layer?.getContext("2d") ?? target;

  const size = options.canvas.width;
  const f = options.features;
  const cfg = FACE_CONFIG;

  // Which way is down the face in UV space. Derived from where the jaw sits
  // relative to the eyes, so blood runs toward the chin even if the head's UV
  // island is laid out upside down.
  const eyeMidV = (f.eyeLeft.v + f.eyeRight.v) / 2;
  const downV = Math.sign(f.jaw.v - eyeMidV) || 1;

  const px = (u: number) => u * size;
  const py = (v: number) => v * size;

  // Socket discolouration only.
  const drawSocket = (site: ImpactSite, swelling: number) => {
    if (swelling < 0.02) return;
    const cx = px(site.u);
    const cy = py(site.v);
    const r = f.eyeRadius * size;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
    const a = Math.min(cfg.bruiseMaxAlpha, swelling * cfg.bruiseAlphaGain);
    g.addColorStop(0, `rgba(74, 24, 48, ${a})`);
    g.addColorStop(0.55, `rgba(96, 40, 56, ${a * 0.5})`);
    g.addColorStop(1, "rgba(96, 40, 56, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawCut = (site: ImpactSite, cut: number, offset: number) => {
    if (cut < 0.02) return;
    const cx = px(site.u) + offset;
    const cy = py(site.v) - downV * f.eyeRadius * size * 1.5;
    const len = f.eyeRadius * size * (0.8 + cut);
    ctx.save();
    ctx.strokeStyle = cfg.cutColour;
    ctx.lineWidth = Math.max(1.5, size * 0.004 * (0.6 + cut));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - len / 2, cy);
    ctx.lineTo(cx + len / 2, cy + len * 0.18);
    ctx.stroke();
    ctx.restore();
  };

  const drawNoseBleed = (bleed: number) => {
    if (bleed < 0.02) return;
    // The nose sits between the eyes, a little toward the jaw.
    const nx = (px(f.eyeLeft.u) + px(f.eyeRight.u)) / 2;
    const ny = (py(f.eyeLeft.v) + py(f.eyeRight.v)) / 2 + downV * f.eyeRadius * size * 1.6;

    ctx.save();
    ctx.globalAlpha = Math.min(1, bleed * cfg.bloodAlphaGain);
    ctx.strokeStyle = cfg.bloodColour;
    ctx.lineCap = "round";

    // Two streaks, one per nostril, running toward the chin. Length scales
    // with how fresh the bleed is, so it creeps down as the round goes on.
    const reach = f.eyeRadius * size * (2 + bleed * 6);
    for (const s of [-1, 1]) {
      const x0 = nx + s * f.eyeRadius * size * 0.32;
      ctx.lineWidth = Math.max(2, size * 0.006 * (0.5 + bleed));
      ctx.beginPath();
      ctx.moveTo(x0, ny);
      // A slight wander, so it reads as liquid finding a path rather than a
      // ruled line.
      ctx.bezierCurveTo(
        x0 + s * reach * 0.12,
        ny + downV * reach * 0.35,
        x0 - s * reach * 0.1,
        ny + downV * reach * 0.7,
        x0 + s * reach * 0.06,
        ny + downV * reach
      );
      ctx.stroke();
    }

    // A smear across the upper lip, which is what actually sells a nosebleed.
    ctx.globalAlpha = Math.min(1, bleed * cfg.bloodAlphaGain * 0.7);
    ctx.beginPath();
    ctx.ellipse(
      nx,
      ny + downV * f.eyeRadius * size * 0.55,
      f.eyeRadius * size * 0.75,
      f.eyeRadius * size * 0.28,
      0,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = cfg.bloodColour;
    ctx.fill();
    ctx.restore();
  };

  const drawCheek = (site: ImpactSite, side: number, swelling: number) => {
    if (swelling < 0.02) return;
    const cx = px(site.u) + side * f.eyeRadius * size * 1.5;
    const cy = py(site.v);
    const r = f.eyeRadius * size * 2.2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const a = Math.min(cfg.bruiseMaxAlpha, swelling * cfg.bruiseAlphaGain * 0.8);
    g.addColorStop(0, `rgba(120, 48, 48, ${a})`);
    g.addColorStop(1, "rgba(120, 48, 48, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  return {
    render(state: FaceDamageState) {
      if (layer) ctx.clearRect(0, 0, size, size);
      // Note: the clean skin underneath has already been laid down by
      // BodyTexture, which calls this as an overlay at the end of its own
      // repaint. Damage is cumulative in the state, never on the canvas -
      // compositing each frame onto the last would darken the face
      // indefinitely and make fading impossible.
      drawCheek(f.eyeLeft, -1, state.sites.cheekLeft.swelling);
      drawCheek(f.eyeRight, 1, state.sites.cheekRight.swelling);

      drawSocket(f.eyeLeft, state.sites.eyeLeft.swelling);
      drawSocket(f.eyeRight, state.sites.eyeRight.swelling);

      drawCut(f.eyeLeft, state.sites.eyeLeft.cut, -f.eyeRadius * size * 0.2);
      drawCut(f.eyeRight, state.sites.eyeRight.cut, f.eyeRadius * size * 0.2);

      drawNoseBleed(state.sites.nose.bleed);

      if (layer && options.mask) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(options.mask, 0, 0);
        ctx.restore();
        target.drawImage(layer, 0, 0);
      }

    },
  };
}
