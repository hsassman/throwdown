import * as THREE from "three";
import { FACE_CONFIG } from "../../config/tuning";
import type { FaceDamageState, FacePainter } from "./faceDamage";
import type { ImpactSite } from "../texturing/bodyUv";

// The painted half of facial damage: eyes, blood, discolouration.
// WHY THE EYES ARE PAINTED HERE RATHER THAN SHIPPED IN THE MESH
//
// The exported character arrives with NO textures at all — the body texture is
// already built procedurally at load. So the face is currently a flat skin
// fill with eyeball geometry the same colour as the skin around it, which is
// why the figures read as mannequins. Painting a sclera and an iris at the
// eye's own UV is the smallest change that makes them read as a person.
//
// WHERE THE FEATURES GO
//
// Located by BONE, not by hardcoded UV coordinates. The rig has `l_eye`,
// `r_eye` and `c_jaw` as real skin joints, so the vertices weighted to each
// one give that feature's UV footprint directly. Hardcoding coordinates would
// break silently the moment the mesh is re-exported — and re-exporting through
// Blender is now on the table, which makes that a live risk rather than a
// hypothetical one.
//
// BLOOD FLOWS DOWN
//
// Drawn as streaks from the nose toward the chin in UV space. That only works
// because the head's UV island happens to be laid out upright; the direction
// is derived from the jaw's UV sitting below the eyes' rather than assumed, so
// a re-export that flips the island does not paint blood up the forehead.

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
 *
 * Returns null when the expected bones are absent, which keeps this a
 * cosmetic add-on rather than something that can break loading.
 */
export function locateFaceFeatures(
  geometry: THREE.BufferGeometry,
  boneNames: string[],
  dominant: Int32Array,
  /**
   * Bind-pose positions of the eye bones, in geometry space.
   *
   * Required, and not optional, because of a measured fact about this rig:
   * `l_eye` and `r_eye` carry ZERO skin weight (0 dominant vertices), so there
   * is no set of "eye vertices" whose UVs could be averaged. The first version
   * of this function tried exactly that and returned null on the real asset.
   *
   * Instead the eye's UV is taken from the nearest HEAD vertex to the eye
   * bone — the skin that sits over the socket, which is what a bruise or a
   * closing lid should be painted on anyway.
   */
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
  /** Canvas to draw into — the same one the body texture uses. */
  canvas: HTMLCanvasElement;
}

export function createFacePainter(options: FacePainterOptions): FacePainter | null {
  const ctx = options.canvas.getContext("2d");
  if (!ctx) return null;

  const size = options.canvas.width;
  const f = options.features;
  const cfg = FACE_CONFIG;

  // Which way is DOWN the face in UV space. Derived from where the jaw sits
  // relative to the eyes, so blood runs toward the chin even if the head's UV
  // island is laid out upside down.
  const eyeMidV = (f.eyeLeft.v + f.eyeRight.v) / 2;
  const downV = Math.sign(f.jaw.v - eyeMidV) || 1;

  const px = (u: number) => u * size;
  const py = (v: number) => v * size;

  // Socket discolouration only.
  //
  // This used to draw a sclera, iris, pupil, catchlight and a closing lid. All
  // of it was REMOVED on 2026-09-16: painting an eye onto flat head skin gives
  // a decal with no socket depth behind it, and it read as a staring mannequin
  // rather than a face. Eyes are now authored as real geometry in Blender and
  // baked into the exported mesh — see blender/README.md.
  //
  // The bruising stays, because a dark ring around the socket is surface
  // colour and is exactly the kind of thing a texture SHOULD carry.
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
      // NOTE: the clean skin underneath has already been laid down by
      // BodyTexture, which calls this as an OVERLAY at the end of its own
      // repaint. Damage is cumulative in the STATE, never on the canvas —
      // compositing each frame onto the last would darken the face
      // indefinitely and make fading impossible.
      drawCheek(f.eyeLeft, -1, state.sites.cheekLeft.swelling);
      drawCheek(f.eyeRight, 1, state.sites.cheekRight.swelling);

      drawSocket(f.eyeLeft, state.sites.eyeLeft.swelling);
      drawSocket(f.eyeRight, state.sites.eyeRight.swelling);

      drawCut(f.eyeLeft, state.sites.eyeLeft.cut, -f.eyeRadius * size * 0.2);
      drawCut(f.eyeRight, state.sites.eyeRight.cut, f.eyeRadius * size * 0.2);

      drawNoseBleed(state.sites.nose.bleed);

    },
  };
}
