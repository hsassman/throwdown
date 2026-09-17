import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { PunchingDummy } from "./PunchingDummy";
import { HIT_ZONES, ZONE_BY_ID } from "../training/hitZones";
import { DUMMY, halfWidthAt, surfaceDepth } from "../training/dummySpec";

// Geometry tests against the built object. three.js runs perfectly well
// headless, so these assert the real mesh rather than a mock — the same
// approach the retargeting tests take against the real asset.

function build() {
  return new PunchingDummy({ scale: 1, distance: 0 });
}

describe("dummy geometry", () => {
  it("builds without a single NaN vertex", () => {
    // One NaN collapses the bounding sphere and the mesh vanishes under
    // frustum culling — it renders as nothing rather than as something wrong,
    // which is the hardest kind of fault to spot in a screenshot. The
    // superellipse raises values to fractional powers, so this is a live risk.
    const d = build();
    let checked = 0;
    d.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute("position");
      for (let i = 0; i < pos.count * pos.itemSize; i++) {
        expect(Number.isFinite(pos.array[i])).toBe(true);
      }
      checked += 1;
    });
    expect(checked).toBeGreaterThan(0);
    d.dispose();
  });

  it("has a finite bounding box of a plausible size", () => {
    const d = build();
    const box = new THREE.Box3().setFromObject(d.group);
    expect(box.isEmpty()).toBe(false);
    const size = box.getSize(new THREE.Vector3());
    // Torso units, scale 1: about one torso wide at the base, and a bit over
    // three torsos tall counting the stand.
    expect(size.y).toBeGreaterThan(2);
    expect(size.y).toBeLessThan(4);
    expect(size.x).toBeLessThan(2);
    d.dispose();
  });

  it("stands ON the floor rather than through it or above it", () => {
    const d = build();
    const box = new THREE.Box3().setFromObject(d.group);
    // A dummy hovering or sunk is the exact class of bug the boot fitting hit
    // in the Blender pipeline.
    expect(box.min.y).toBeCloseTo(0, 1);
    d.dispose();
  });

  it("reaches the floor at ANY belt height, by growing its stand", () => {
    // The stand has no length of its own — it is however long it needs to be.
    // Storing a fixed length would be a second answer to a question the
    // placement already answers, and the two would disagree the moment the
    // figure's proportions changed.
    for (const beltHeight of [0.6, 0.944, 1.4]) {
      const d = new PunchingDummy({ scale: 1, distance: 0, beltHeight });
      const box = new THREE.Box3().setFromObject(d.group);
      expect(box.min.y).toBeCloseTo(0, 1);
      d.dispose();
    }
  });

  it("anchors target heights on the BELT LINE, not on the floor", () => {
    // The bug this replaced: the dummy was placed floor-up, so every target
    // sat at the wrong world height by however tall the stand was — the chin
    // ended up around chest height and nothing lined up with the player.
    //
    // strikeGeometry measures height 0 at the belt and 1.0 at the shoulder, so
    // a zone at height h must land at beltHeight + h * scale.
    const beltHeight = 0.944;
    const scale = 0.475;
    const d = new PunchingDummy({ scale, distance: 0, beltHeight });
    const chin = ZONE_BY_ID.get("chin")!;
    const pos = d.markerWorldPosition("chin", new THREE.Vector3())!;
    expect(pos.y).toBeCloseTo(beltHeight + chin.centre.height * scale, 3);
    d.dispose();
  });
});

describe("target markers", () => {
  it("builds one for every hit zone", () => {
    const d = build();
    for (const z of HIT_ZONES) {
      expect(d.markerWorldPosition(z.id)).not.toBeNull();
    }
    expect(d.markerWorldPosition("does_not_exist")).toBeNull();
    d.dispose();
  });

  it("puts every marker ON the surface, not floating or sunk", () => {
    // A marker at a fixed depth sinks into the chest at the midline and hovers
    // in mid-air out by the ribs, because the body is curved and the zones are
    // spread right across it.
    for (const z of HIT_ZONES) {
      const depth = surfaceDepth(z.centre.lateral, z.centre.height);
      const halfW = halfWidthAt(z.centre.height);
      expect(depth).toBeGreaterThan(0);
      // The surface must bulge forward, and never further than the CHEST is
      // deep — the sternum is the most forward part of a torso, and a head
      // that protruded past it would put every body target behind the face.
      expect(depth).toBeLessThanOrEqual(DUMMY.torsoDepth / 2 + 1e-9);
      expect(Math.abs(z.centre.lateral)).toBeLessThanOrEqual(halfW);
    }
  });

  it("draws the ring at the radius accuracy is actually scored against", () => {
    // The most visible possible place to tell a lie: a decorative ring at a
    // different size from the circle the drill scores would mean the player is
    // aiming at something the game is not measuring.
    const d = build();
    const liver = ZONE_BY_ID.get("liver")!;
    const marker = d.markerWorldPosition("liver", new THREE.Vector3());
    expect(marker).not.toBeNull();
    let found: THREE.RingGeometry | null = null;
    d.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as THREE.RingGeometry;
      if (g.type === "RingGeometry" && Math.abs(g.parameters.outerRadius - liver.radius) < 1e-9) {
        found = g;
      }
    });
    expect(found).not.toBeNull();
    d.dispose();
  });
});

describe("hosting a character figure", () => {
  it("builds no moulded body when a figure supplies one", () => {
    // Both bodies at once would put a character inside a urethane torso.
    const moulded = new PunchingDummy({ scale: 1, distance: 0 });
    const figure = new PunchingDummy({ scale: 1, distance: 0, body: "figure" });
    const count = (d: PunchingDummy) => {
      let n = 0;
      d.pivot.traverse((o) => {
        const m = o as THREE.Mesh;
        // Markers are rings and circles; the moulded torso is the only
        // BufferGeometry built from raw positions.
        if (m.isMesh && m.geometry.type === "BufferGeometry") n += 1;
      });
      return n;
    };
    expect(count(moulded)).toBe(1);
    expect(count(figure)).toBe(0);
    moulded.dispose();
    figure.dispose();
  });

  it("exposes a clip plane at the cut line, clipping DOWNWARD", () => {
    const beltHeight = 0.944;
    const scale = 0.475;
    const d = new PunchingDummy({ scale, distance: 0, beltHeight, body: "figure" });
    expect(d.cutHeight).toBeCloseTo(beltHeight + DUMMY.base * scale, 6);
    // A point below the cut must be on the negative side (clipped away), and
    // the chest above it must survive. Getting the sign backwards deletes the
    // torso and keeps the legs.
    expect(d.clipPlane.distanceToPoint(new THREE.Vector3(0, d.cutHeight - 0.2, 0))).toBeLessThan(0);
    expect(d.clipPlane.distanceToPoint(new THREE.Vector3(0, d.cutHeight + 0.2, 0))).toBeGreaterThan(0);
    d.dispose();
  });

  it("projects markers onto the supplied surface, not the moulded spec", () => {
    // Where a character is thicker than the moulded spec, a marker left at the
    // spec depth is buried INSIDE the chest — invisible, and silent about it.
    const d = new PunchingDummy({ scale: 1, distance: 0, body: "figure" });

    const before = d.markerWorldPosition("chest", new THREE.Vector3())!.clone();

    // A slab standing proud of the moulded surface, spanning the body.
    //
    // The dummy group is turned to face the player, so the dummy's own forward
    // is -Z in WORLD terms. The slab has to sit between the ray's start and
    // the body — putting it further out than the ray origin (which a first
    // version of this test did) means the ray starts behind it and misses.
    const PROUD = 0.1;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 0.02),
      new THREE.MeshBasicMaterial()
    );
    slab.position.set(0, before.y, before.z - PROUD);
    slab.updateMatrixWorld(true);

    d.projectMarkersOnto(slab);
    const after = d.markerWorldPosition("chest", new THREE.Vector3())!;
    // Landed on the slab, not left at the moulded spec's depth.
    expect(Math.abs(after.z - (before.z - PROUD))).toBeLessThan(0.03);
    expect(after.z).toBeLessThan(before.z - 0.05);
    d.dispose();
  });

  it("leaves a marker alone when the ray misses the figure entirely", () => {
    // A miss must not teleport the marker to the origin. Better a slightly
    // wrong depth than a ring floating in the middle of the room.
    const d = new PunchingDummy({ scale: 1, distance: 0, body: "figure" });
    const before = d.markerWorldPosition("liver", new THREE.Vector3())!.clone();
    const elsewhere = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.1),
      new THREE.MeshBasicMaterial()
    );
    elsewhere.position.set(50, 50, 50);
    elsewhere.updateMatrixWorld(true);
    d.projectMarkersOnto(elsewhere);
    const after = d.markerWorldPosition("liver", new THREE.Vector3())!;
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    d.dispose();
  });
});

describe("reaction", () => {
  it("rocks back when struck and settles again", () => {
    const d = build();
    const angle = () => {
      let a = 0;
      d.group.traverse((o) => {
        if (o.type === "Group" && o.rotation.x !== 0) a = o.rotation.x;
      });
      return a;
    };
    d.update(1 / 60);
    expect(angle()).toBe(0);

    d.impact(1);
    for (let i = 0; i < 8; i++) d.update(1 / 60);
    const moved = Math.abs(angle());
    expect(moved).toBeGreaterThan(0.001);

    // A dummy on a water base settles in about a second. It must not oscillate
    // forever, and it must come back to upright.
    for (let i = 0; i < 240; i++) d.update(1 / 60);
    expect(Math.abs(angle())).toBeLessThan(moved * 0.25);
    d.dispose();
  });

  it("survives an enormous frame gap without folding in half", () => {
    // A tab restored from the background delivers one huge dt. An unclamped
    // spring integrates that into a dummy bent through the floor.
    const d = build();
    d.impact(1);
    d.update(30);
    d.update(1 / 60);
    let ok = true;
    d.group.traverse((o) => {
      if (!Number.isFinite(o.rotation.x)) ok = false;
      if (Math.abs(o.rotation.x) > 1.5) ok = false;
    });
    expect(ok).toBe(true);
    d.dispose();
  });

  it("ignores a score on a zone that does not exist", () => {
    const d = build();
    expect(() => d.score("nonsense", 1)).not.toThrow();
    expect(() => d.score(null, 1)).not.toThrow();
    d.dispose();
  });

  it("rocks when hit even with NOTHING lit and nothing scored", () => {
    // Free work: no target, no drill, no score. A dummy that stood perfectly
    // still while being punched would read as the hit detection having failed,
    // which is why the physical and scoring reactions are separate calls.
    const d = build();
    const angle = () => {
      let a = 0;
      d.group.traverse((o) => {
        if (o.type === "Group" && o.rotation.x !== 0) a = o.rotation.x;
      });
      return a;
    };
    d.setLit(null);
    d.impact(0.8);
    for (let i = 0; i < 8; i++) d.update(1 / 60);
    expect(Math.abs(angle())).toBeGreaterThan(0.001);
    d.dispose();
  });
});
