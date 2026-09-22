import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { findBodyMesh } from "../findBodyMesh";
import { buildBodyUvMap, dominantBones } from "./bodyUv";

// Against the real exported asset. The UV layout is a property of the mesh,
// not of this code, so a mock would only assert that the code agrees with
// itself.

const MODEL_PATH = "public/models/boxer_lod3.glb";
let mesh: THREE.SkinnedMesh;

beforeAll(async () => {
  const buf = readFileSync(MODEL_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const scene = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(ab as ArrayBuffer, "", (g) => resolve(g.scene), reject);
  });
  // The body specifically. The asset now carries eyeballs, which are also
  // skinned, so "the last skinned mesh" is an eye -- see findBodyMesh.
  mesh = findBodyMesh(scene)!;
}, 60_000);

function build() {
  const boneNames = mesh.skeleton.bones.map((b) => b.name);
  const dominant = dominantBones(mesh.geometry);
  return buildBodyUvMap(mesh.geometry, boneNames, dominant);
}

describe("body UV map", () => {
  it("still has the UVs the whole texturing path depends on", () => {
    // These survive only because strip-morphs.mjs passes keepAttributes: the
    // default prune removed TEXCOORD_0 once already, correctly by its own
    // logic, since no material referenced it. Losing them again would silently
    // disable every texture and all visible damage.
    const uv = mesh.geometry.getAttribute("uv");
    expect(uv, "mesh must carry TEXCOORD_0").toBeDefined();
    expect(uv.count).toBe(mesh.geometry.getAttribute("position").count);
  });

  it("locates every strike zone on the texture", () => {
    const map = build();
    for (const height of ["head", "body"]) {
      for (const lane of ["left", "centre", "right"]) {
        const site = map.sites.get(`${height}/${lane}`);
        expect(site, `${height}/${lane} should have a UV`).toBeDefined();
        expect(site!.u).toBeGreaterThanOrEqual(0);
        expect(site!.u).toBeLessThanOrEqual(1);
        expect(site!.v).toBeGreaterThanOrEqual(0);
        expect(site!.v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("puts head impacts inside the head's own UV island", () => {
    // Measured with tools/uv-regions.mjs: the head owns u 0.003-0.499,
    // v 0.003-0.453. A head bruise landing outside that rectangle would appear
    // somewhere else entirely on the body - a leg, most likely.
    const map = build();
    for (const lane of ["left", "centre", "right"]) {
      const site = map.sites.get(`head/${lane}`)!;
      expect(site.u, `head/${lane} u`).toBeLessThan(0.5);
      expect(site.v, `head/${lane} v`).toBeLessThan(0.46);
    }
  });

  it("separates the three lanes rather than stacking them", () => {
    // If left/centre/right resolved to the same spot, zone detection would be
    // working but invisible, which is the kind of bug that looks like nothing.
    const map = build();
    for (const height of ["head", "body"]) {
      const l = map.sites.get(`${height}/left`)!;
      const c = map.sites.get(`${height}/centre`)!;
      const r = map.sites.get(`${height}/right`)!;
      const gap = (a: typeof l, b: typeof l) => Math.hypot(a.u - b.u, a.v - b.v);
      expect(gap(l, c), `${height} left vs centre`).toBeGreaterThan(0.01);
      expect(gap(r, c), `${height} right vs centre`).toBeGreaterThan(0.01);
      expect(gap(l, r), `${height} left vs right`).toBeGreaterThan(0.02);
    }
  });

  it("keeps head and body impacts well apart", () => {
    const map = build();
    const head = map.sites.get("head/centre")!;
    const body = map.sites.get("body/centre")!;
    expect(Math.hypot(head.u - body.u, head.v - body.v)).toBeGreaterThan(0.1);
  });

  it("puts the left and right lanes on opposite sides of the face", () => {
    // The lanes are named from the puncher's point of view and the target
    // faces them, so the puncher's left must land on the target's own right.
    // Getting this backwards puts every bruise on the wrong cheek.
    const map = build();
    const uv = mesh.geometry.getAttribute("uv");
    const pos = mesh.geometry.getAttribute("position");

    // Find the model-space x of the vertex each site came from, by matching UV.
    const xAt = (u: number, v: number) => {
      for (let i = 0; i < uv.count; i++) {
        if (Math.abs(uv.getX(i) - u) < 1e-6 && Math.abs(uv.getY(i) - v) < 1e-6) {
          return pos.getX(i);
        }
      }
      return NaN;
    };
    const left = map.sites.get("head/left")!;
    const right = map.sites.get("head/right")!;
    const xl = xAt(left.u, left.v);
    const xr = xAt(right.u, right.v);
    expect(Number.isFinite(xl) && Number.isFinite(xr)).toBe(true);
    // The rig's own left is +X; a punch from the player's left lands there.
    expect(xl).toBeLessThan(xr);
  });
});
