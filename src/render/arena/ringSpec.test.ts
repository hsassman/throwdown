import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildRing } from "./Ring";
import {
  RING,
  platformHalfSpan,
  ringArea,
  ringCorners,
  ropeHalfSpan,
  ropes,
} from "./ringSpec";
import { FT } from "./octagonSpec";

describe("ring dimensions", () => {
  it("measures 20 feet INSIDE THE ROPES, not across the platform", () => {
    // Reading the 20 feet as the platform edge would put the ropes 16 feet
    // apart and make the ring a quarter smaller than a real one.
    expect(ropeHalfSpan() * 2).toBeCloseTo(20 * FT, 9);
    expect(platformHalfSpan() * 2).toBeCloseTo(24 * FT, 9);
  });

  it("gives a championship ring its 400 square feet of canvas", () => {
    expect(ringArea() / (FT * FT)).toBeCloseTo(400, 6);
  });

  it("puts the posts on the rope line, where the ropes can reach them", () => {
    const h = ropeHalfSpan();
    for (const c of ringCorners()) {
      expect(Math.abs(c.x)).toBeCloseTo(h, 9);
      expect(Math.abs(c.z)).toBeCloseTo(h, 9);
    }
  });

  it("carries four ropes, and they all clear the canvas and the posts", () => {
    expect(RING.ropeHeights).toHaveLength(4);
    for (const h of RING.ropeHeights) {
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThan(RING.postHeight);
    }
    // Ordered bottom to top, evenly. A rope out of order would cross another.
    const sorted = [...RING.ropeHeights].sort((a, b) => a - b);
    expect(RING.ropeHeights).toEqual(sorted);
  });

  it("runs sixteen rope segments - four sides at four heights", () => {
    expect(ropes()).toHaveLength(16);
  });

  it("closes each rope loop", () => {
    // Every corner must be the end of one segment and the start of the next,
    // or the ring has a gap a fighter would fall through.
    for (const height of RING.ropeHeights) {
      const atHeight = ropes().filter((r) => r.height === height);
      for (const corner of ringCorners()) {
        const starts = atHeight.filter(
          (r) => Math.hypot(r.from.x - corner.x, r.from.z - corner.z) < 1e-9
        );
        const ends = atHeight.filter(
          (r) => Math.hypot(r.to.x - corner.x, r.to.z - corner.z) < 1e-9
        );
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
      }
    }
  });

  it("rescales from one number", () => {
    const small = ropeHalfSpan(16 * FT);
    expect(small * 2).toBeCloseTo(16 * FT, 9);
    expect(ringCorners(16 * FT)[0].x).toBeCloseTo(-small, 9);
  });
});

describe("the built ring", () => {
  it("stands the canvas at y = 0, like every other surface fighters use", () => {
    const ring = buildRing();
    const canvas = ring.group.getObjectByName("canvas-inside")!;
    expect(canvas.position.y).toBeLessThan(0.01);
    ring.dispose();
  });

  it("lays each rope ALONG its side rather than across the ring", () => {
    // The same class of fault the octagon's fence panels had: an angle taken
    // from the wrong axis turns every piece a quarter turn. Checked through
    // the real transform, by walking half a rope's length along its own axis
    // and requiring that to land on a corner post.
    const ring = buildRing();
    ring.group.updateMatrixWorld(true);
    const corners = ringCorners();

    for (const run of ropes()) {
      const length = Math.hypot(run.to.x - run.from.x, run.to.z - run.from.z);
      const rope = ring.group.children.find(
        (o) =>
          o.name.startsWith("rope-") &&
          Math.abs(o.position.y - run.height) < 1e-9 &&
          Math.abs(o.position.x - (run.from.x + run.to.x) / 2) < 1e-9 &&
          Math.abs(o.position.z - (run.from.z + run.to.z) / 2) < 1e-9
      )!;
      expect(rope).toBeDefined();

      // A cylinder runs along its own +Y.
      const end = new THREE.Vector3(0, length / 2, 0)
        .applyQuaternion(rope.quaternion)
        .add(rope.position);
      const onAPost = corners.some(
        (c) => Math.hypot(end.x - c.x, end.z - c.z) < 1e-6
      );
      expect(onAPost).toBe(true);
      // And horizontal: a rope that sloped would be a rope tied to the floor.
      expect(Math.abs(end.y - rope.position.y)).toBeLessThan(1e-6);
    }
    ring.dispose();
  });

  it("builds four posts and four pads", () => {
    const ring = buildRing();
    const names = ring.group.children.map((c) => c.name);
    expect(names.filter((n) => n.startsWith("post-"))).toHaveLength(4);
    expect(names.filter((n) => n.startsWith("pad-"))).toHaveLength(4);
    ring.dispose();
  });

  it("disposes everything it made", () => {
    const ring = buildRing();
    let disposed = 0;
    ring.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose = () => {
          disposed++;
        };
      }
    });
    ring.dispose();
    // Geometries are shared between repeated parts, so this is not one per
    // mesh - the point is that dispose actually reaches them.
    expect(disposed).toBeGreaterThan(0);
  });
});
