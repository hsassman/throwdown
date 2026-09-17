import { describe, it, expect } from "vitest";
import {
  HIT_ZONES,
  ZONE_BY_ID,
  accuracyOf,
  missDistance,
  nearestZone,
  zonesOffTheBody,
  zonesUpTo,
} from "./hitZones";
import { DUMMY, halfWidthAt, onDummy } from "./dummySpec";
import { regionAt } from "../perception/strikeGeometry";

describe("dummy silhouette", () => {
  it("has nothing to hit below the cut or above the crown", () => {
    // The reference dummy's torso ends at the lower chest. A punch into the
    // space where a fighter's stomach would be hits the STAND.
    expect(halfWidthAt(DUMMY.base - 0.01)).toBe(0);
    expect(halfWidthAt(DUMMY.crown + 0.01)).toBe(0);
    expect(onDummy({ lateral: 0, height: 0.1 })).toBe(false);
  });

  it("closes the head at the crown instead of leaving a hole", () => {
    // The loft caps the BOTTOM of the body but not the top, so the head
    // profile has to reach exactly zero on its own. It did not — it bottomed
    // out at 0.42 of full width — and the dummy rendered with a flat open
    // cylinder where its skull should be.
    expect(halfWidthAt(DUMMY.crown)).toBeCloseTo(0, 6);
    expect(halfWidthAt(DUMMY.crown - 0.02)).toBeGreaterThan(0);
  });

  it("has no crease where the shoulder cap meets the head", () => {
    // The sections meet by CONSTRUCTION — the cap ends at whatever width the
    // head profile has at the neck — rather than by two stored numbers
    // agreeing. Sampling either side of the join catches a ledge.
    const below = halfWidthAt(DUMMY.neck - 0.005);
    const above = halfWidthAt(DUMMY.neck + 0.005);
    expect(Math.abs(above - below)).toBeLessThan(0.01);
  });

  it("holds full width across the shoulders instead of coning to a point", () => {
    // The reference dummy has broad, flat shoulders. Without a plateau the
    // body starts narrowing the instant it reaches full width, so there is no
    // shoulder at all — just a cone, and the whole thing reads as a bowling
    // pin. The plateau runs from the deltoid line to the shoulder line.
    const deltoid = halfWidthAt(DUMMY.deltoid);
    const shoulder = halfWidthAt(DUMMY.shoulder);
    const mid = halfWidthAt((DUMMY.deltoid + DUMMY.shoulder) / 2);
    expect(deltoid).toBeCloseTo(shoulder, 6);
    expect(mid).toBeCloseTo(shoulder, 6);
    // And it really is the widest the body gets.
    expect(shoulder).toBeGreaterThan(halfWidthAt(DUMMY.deltoid - 0.15));
    expect(shoulder).toBeGreaterThan(halfWidthAt(DUMMY.neck));
  });

  it("is widest at the chest and narrowest at the head", () => {
    const chest = halfWidthAt(0.95);
    const head = halfWidthAt(1.4);
    const waist = halfWidthAt(DUMMY.base + 0.02);
    expect(chest).toBeGreaterThan(head);
    expect(chest).toBeGreaterThan(waist);
  });
});

describe("hit zones", () => {
  it("every zone actually IS the region it claims to be", () => {
    // The single most important test in this file. strikeGeometry's region
    // table and these target positions are two descriptions of the same
    // anatomy, and nothing else keeps them in agreement — a zone labelled
    // "Liver" that resolves to "ribs_left" would score the player for hitting
    // a target they were never shown.
    for (const z of HIT_ZONES) {
      expect(`${z.id} -> ${regionAt(z.centre).id}`).toBe(`${z.id} -> ${z.region}`);
    }
  });

  it("paints no target on thin air or on the stand", () => {
    expect(zonesOffTheBody().map((z) => z.id)).toEqual([]);
  });

  it("puts the liver on the puncher's LEFT", () => {
    // Real anatomy, and the reason a left hook to the body ends fights. If
    // this ever flips, every body drill trains the wrong hand.
    expect(ZONE_BY_ID.get("liver")!.centre.lateral).toBeLessThan(0);
    expect(ZONE_BY_ID.get("ribs_right")!.centre.lateral).toBeGreaterThan(0);
  });

  it("has no gut target, because the dummy has no gut", () => {
    expect(ZONE_BY_ID.has("gut")).toBe(false);
    const lowest = Math.min(...HIT_ZONES.map((z) => z.centre.height));
    expect(lowest).toBeGreaterThan(DUMMY.base);
  });

  it("has unique ids", () => {
    expect(ZONE_BY_ID.size).toBe(HIT_ZONES.length);
  });
});

describe("accuracy scoring", () => {
  const nose = ZONE_BY_ID.get("nose")!;

  it("gives full marks anywhere inside the ring", () => {
    expect(accuracyOf(nose.centre, nose)).toBe(1);
    expect(
      accuracyOf(
        { lateral: nose.centre.lateral + nose.radius * 0.9, height: nose.centre.height },
        nose
      )
    ).toBe(1);
  });

  it("falls off smoothly rather than pass/fail", () => {
    // A punch a centimetre outside the ring is a better punch than one on the
    // far shoulder, and the adaptation loop needs to be able to tell.
    const near = accuracyOf(
      { lateral: 0, height: nose.centre.height + nose.radius * 1.2 },
      nose
    );
    const far = accuracyOf(
      { lateral: 0, height: nose.centre.height + nose.radius * 2.5 },
      nose
    );
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(1);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it("bottoms out at zero and never goes negative", () => {
    expect(accuracyOf({ lateral: 3, height: -4 }, nose)).toBe(0);
  });
});

describe("nearest zone", () => {
  it("finds the zone a punch was closest to", () => {
    const liver = ZONE_BY_ID.get("liver")!;
    const near = { lateral: liver.centre.lateral + 0.02, height: liver.centre.height };
    expect(nearestZone(near)!.id).toBe("liver");
  });

  it("returns nothing when the punch missed the dummy altogether", () => {
    expect(nearestZone({ lateral: 2.0, height: 1.0 })).toBeNull();
    expect(nearestZone({ lateral: 0, height: 0.05 })).toBeNull();
  });
});

describe("tiers", () => {
  it("widen as they progress, and never shrink", () => {
    const open = zonesUpTo("open");
    const precise = zonesUpTo("precise");
    const expert = zonesUpTo("expert");
    expect(open.length).toBeGreaterThan(0);
    expect(precise.length).toBeGreaterThan(open.length);
    expect(expert.length).toBe(HIT_ZONES.length);
    // Progression must be a superset, not a different set — a drill that
    // "progresses" by removing the target you just learned is not progression.
    expect(precise.map((z) => z.id)).toEqual(
      expect.arrayContaining(open.map((z) => z.id))
    );
  });

  it("grades by REACH off the midline, not by size", () => {
    // Worth stating because the obvious assumption is wrong, and a test
    // asserting it failed: the liver is a BIGGER target than the nose and
    // still much harder, because it is around the side of the body and needs a
    // hook to reach. Difficulty here is about the angle a punch has to arrive
    // from, not about how many centimetres wide the circle is.
    const open = zonesUpTo("open");
    const expert = HIT_ZONES.filter((z) => z.tier === "expert");
    const furthestOpen = Math.max(...open.map((z) => Math.abs(z.centre.lateral)));
    const nearestExpert = Math.min(...expert.map((z) => Math.abs(z.centre.lateral)));
    expect(nearestExpert).toBeGreaterThan(furthestOpen);
  });
});

describe("miss distance", () => {
  it("is zero at the centre and symmetric", () => {
    const chin = ZONE_BY_ID.get("chin")!;
    expect(missDistance(chin.centre, chin)).toBe(0);
    const a = missDistance({ lateral: 0.1, height: chin.centre.height }, chin);
    const b = missDistance({ lateral: -0.1, height: chin.centre.height }, chin);
    expect(a).toBeCloseTo(b, 10);
  });
});
