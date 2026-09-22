import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  FT,
  OCTAGON,
  apothem,
  circumradius,
  corners,
  floorArea,
  sideLength,
  walls,
} from "./octagonSpec";

// These assert the arena against the reference sheet, not against the code's
// own arithmetic. The sheet gives three figures; if the interpretation of
// "30 feet across" were wrong, two of the three would disagree, so this is a
// real check rather than a restatement.

describe("octagon dimensions", () => {
  it("encloses ~750 square feet, as the reference sheet states", () => {
    const sqFt = floorArea() / (FT * FT);
    expect(sqFt).toBeGreaterThan(735);
    expect(sqFt).toBeLessThan(760);
  });

  it("makes each of the eight walls about 12.4 feet", () => {
    // Third independent figure: nothing above feeds this, and a regulation
    // octagon's panels are ~12.4 ft. Reading "30 feet" as corner-to-corner
    // instead would give 11.5 ft here and 636 sq ft above.
    const ft = sideLength() / FT;
    expect(ft).toBeGreaterThan(12.2);
    expect(ft).toBeLessThan(12.6);
  });

  it("measures 30 feet wall to opposite wall", () => {
    expect((apothem() * 2) / FT).toBeCloseTo(30, 5);
  });

  it("has a circumradius larger than its apothem", () => {
    // Trivially true for any polygon, but it is the direction of this
    // inequality that the flat-to-flat reading hinges on: corner-to-corner
    // must come out larger than 30 ft, not smaller.
    expect(circumradius()).toBeGreaterThan(apothem());
    expect((circumradius() * 2) / FT).toBeGreaterThan(30);
  });

  it("keeps the fence and platform within the sheet's stated maxima", () => {
    expect(OCTAGON.fenceHeight / FT).toBeLessThanOrEqual(6);
    expect(OCTAGON.platformHeight / FT).toBeLessThanOrEqual(4);
    expect(OCTAGON.apron / FT).toBeGreaterThanOrEqual(1.5);
  });
});

describe("octagon layout", () => {
  it("has eight corners, all on the circumradius", () => {
    const pts = corners();
    expect(pts).toHaveLength(8);
    for (const p of pts) {
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(circumradius(), 6);
    }
  });

  it("puts a WALL at +Z, not a corner", () => {
    // Not cosmetic. The fighters face along Z and the default camera looks
    // down -Z; with a corner at +Z the nearest padded post would stand dead
    // centre of frame, between the camera and the action.
    const near = corners().reduce((best, p) =>
      p.z > best.z ? p : best
    );
    // The most-forward corner must be off to one side, not on the axis.
    expect(Math.abs(near.x)).toBeGreaterThan(0.5);
  });

  it("gives eight equal walls whose midpoints sit on the apothem", () => {
    const w = walls();
    expect(w).toHaveLength(8);
    for (const wall of w) {
      expect(wall.length).toBeCloseTo(sideLength(), 6);
      expect(Math.hypot(wall.mid.x, wall.mid.z)).toBeCloseTo(apothem(), 6);
    }
  });

  it("rescales coherently when a smaller cage is asked for", () => {
    // The practice-cage case. Everything must stay proportional or a training
    // arena would silently have regulation-sized fencing on a small floor.
    const small = 20 * FT;
    expect(floorArea(small) / floorArea()).toBeCloseTo((20 / 30) ** 2, 6);
    expect(sideLength(small) / sideLength()).toBeCloseTo(20 / 30, 6);
  });
});

describe("wall orientation", () => {
  // The fault this catches: the panels were turned a quarter turn, so the
  // eight fence walls stood perpendicular to the cage instead of enclosing it.
  // Asserted through the actual three.js transform rather than by comparing
  // the angle to a formula, because a test written from the same wrong formula
  // as the code agrees with it.

  it("faces every panel at the centre of the cage", () => {
    const r = circumradius();
    for (const wall of walls(r)) {
      const panel = new THREE.Object3D();
      panel.position.set(wall.mid.x, 0, wall.mid.z);
      panel.rotation.y = wall.angle;
      panel.updateMatrixWorld(true);

      // A PlaneGeometry faces local +Z.
      const normal = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(panel.quaternion)
        .normalize();
      const inward = new THREE.Vector3(-wall.mid.x, 0, -wall.mid.z).normalize();

      // Either face will do - the material is DoubleSide - but the panel has
      // to lie across the opening, not point through it.
      expect(Math.abs(normal.dot(inward))).toBeCloseTo(1, 6);
    }
  });

  it("spans each panel from one corner to the next", () => {
    const r = circumradius();
    const c = corners(r);
    const list = walls(r);
    for (let i = 0; i < list.length; i++) {
      const panel = new THREE.Object3D();
      panel.position.set(list[i].mid.x, 0, list[i].mid.z);
      panel.rotation.y = list[i].angle;
      panel.updateMatrixWorld(true);

      // Walking half a wall along the panel's own +X must land on a corner.
      const edge = new THREE.Vector3(list[i].length / 2, 0, 0)
        .applyQuaternion(panel.quaternion)
        .add(panel.position);
      const a = c[i];
      const b = c[(i + 1) % 8];
      const hitsACorner =
        Math.hypot(edge.x - a.x, edge.z - a.z) < 1e-6 ||
        Math.hypot(edge.x - b.x, edge.z - b.z) < 1e-6;
      expect(hitsACorner).toBe(true);
    }
  });
});
