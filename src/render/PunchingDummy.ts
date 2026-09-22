import * as THREE from "three";
import {
  DUMMY,
  halfDepthAt,
  halfWidthAt,
  sectionExponent,
  surfaceDepth,
  type DummySpec,
} from "../training/dummySpec";
import { HIT_ZONES, type HitZone } from "../training/hitZones";
import { RENDER_CONFIG, TARGET_CONFIG } from "../config/tuning";

// The punching dummy: an upper body on a sprung column, with lit target zones.
// Two bodies, one stand
//
// The body is either:
//
//   "moulded" - generated geometry, a Century-BOB style urethane torso. No
//   rig, no skinning, nothing that deforms. Safe to generate precisely because
//   a BOB is a single moulded piece with no seams, cloth or fingers - the
//   opposite of the procedural gloves/shorts/eyes this project built and threw
//   away three times.
//
//   "figure" - the real character mesh, supplied by the caller, clipped off
//   below the belt and plugged into the stand's collar. It is fully skinned,
//   so it reacts to being hit and takes bruises like any other fighter.
//
// The stand, the spring, the target markers and the scoring are identical
// either way. Only what is bolted on top changes.
// Scale is baked into the geometry, not applied to the group
//
// Everything below is generated in torso units and multiplied by `scale` as it
// is built, so the dummy's group sits at world scale.
//
// That is deliberate and load-bearing. A scaled group would also scale
// anything parented into it, so the character figure would need a
// compensating 1/scale - and a compensating scale buried in a parent chain is
// exactly the thing that silently corrupts a skinned mesh's world matrices.
// Raycasting to place the markers would need the same correction. Baking it
// once, here, removes both problems.

/** Vertical samples up the body. Enough that the shoulder line reads smooth. */
const RINGS = 56;
/** Samples around each cross-section. */
const SEGMENTS = 44;

export type DummyBody = "moulded" | "figure";

export interface DummyOptions {
  spec?: DummySpec;
  /** World units per torso unit. Defaults to the exported rig's own torso. */
  scale?: number;
  /** How far in front of the player the dummy stands. */
  distance?: number;
  /**
   * World height of the belt line - the origin of the torso-normalised space
   * the hit zones are defined in.
   *
   * This, not the floor, is what the dummy is anchored by. `strikeGeometry.ts`
   * measures height 0 at the belt and 1.0 at the shoulder, so a dummy placed
   * with its floor at y=0 puts every target at the wrong world height by
   * however tall its stand happens to be - the chin ends up at chest height
   * and nothing lines up with the player it is facing.
   */
  beltHeight?: number;
  /** Which body to build. Defaults to the generated one. */
  body?: DummyBody;
}

export interface ZoneMarker {
  zone: HitZone;
  ring: THREE.Mesh;
  fill: THREE.Mesh;
  ringMat: THREE.MeshStandardMaterial;
  fillMat: THREE.MeshStandardMaterial;
  /** 0..1 lit state. */
  lit: number;
  /** Decaying flash from a landed punch. */
  flash: number;
  /** Colour the flash is playing in. */
  flashColour: THREE.Color;
}

const COLOURS = {
  // Matched to the reference photo: a pinkish flesh-toned urethane torso on a
  // black column and base.
  flesh: 0xc88b7a,
  column: 0x1b1b1e,
  base: 0x141416,
  /** An unlit target: visible, but clearly not the one being asked for. */
  idle: 0x2a3550,
  /** The target currently being asked for. */
  lit: 0xffb020,
  good: 0x3ddc84,
  poor: 0xe8453c,
};

/** One superelliptical cross-section at height `h`, already scaled. */
function ringAt(h: number, spec: DummySpec, s: number): THREE.Vector3[] {
  const halfW = halfWidthAt(h, spec) * s;
  const halfD = halfDepthAt(h, spec) * s;
  const n = sectionExponent(h, spec);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    // Signed-power form. Math.abs before the power, sign restored after -
    // raising a negative to a fractional power is NaN, and one NaN vertex
    // collapses the mesh's bounding sphere so it vanishes under frustum
    // culling rather than rendering wrong.
    const x = halfW * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const z = halfD * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
    pts.push(new THREE.Vector3(x, h * s, z));
  }
  return pts;
}

/** Lofts the moulded torso and head as one closed shell. */
function buildMouldedBody(spec: DummySpec, s: number): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = [];
  for (let r = 0; r < RINGS; r++) {
    // Biased toward the top: the head and shoulder line carry all the
    // curvature, while the chest is nearly a straight taper.
    const t = r / (RINGS - 1);
    const eased = Math.pow(t, 0.82);
    rings.push(ringAt(spec.base + eased * (spec.crown - spec.base), spec, s));
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const push = (p: THREE.Vector3, u: number, v: number) => {
    positions.push(p.x, p.y, p.z);
    uvs.push(u, v);
  };

  for (let r = 0; r < rings.length - 1; r++) {
    const lo = rings[r];
    const hi = rings[r + 1];
    for (let i = 0; i < SEGMENTS; i++) {
      const j = (i + 1) % SEGMENTS;
      const u0 = i / SEGMENTS;
      const u1 = (i + 1) / SEGMENTS;
      const v0 = r / (rings.length - 1);
      const v1 = (r + 1) / (rings.length - 1);
      push(lo[i], u0, v0);
      push(hi[i], u0, v1);
      push(hi[j], u1, v1);
      push(lo[i], u0, v0);
      push(hi[j], u1, v1);
      push(lo[j], u1, v0);
    }
  }

  // Cap the bottom, where the torso meets the column. Left open it shows the
  // inside of the chest from below - invisible in a screenshot and glaring in
  // motion. The top needs no cap: the head profile closes to a point.
  const bottom = rings[0];
  const centre = new THREE.Vector3(0, bottom[0].y, 0);
  for (let i = 0; i < SEGMENTS; i++) {
    const j = (i + 1) % SEGMENTS;
    push(centre, 0.5, 0);
    push(bottom[j], 0.5, 0);
    push(bottom[i], 0.5, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

export class PunchingDummy {
  readonly group = new THREE.Group();
  /**
   * Everything that rocks when hit. Public so a supplied figure can be
   * parented into it and share the spring.
   */
  readonly pivot = new THREE.Group();
  /** World height of the cut line, where a supplied figure is clipped. */
  readonly cutHeight: number;
  /** A clipping plane at the cut, for a supplied figure's materials. */
  readonly clipPlane: THREE.Plane;

  private readonly markers = new Map<string, ZoneMarker>();
  private readonly spec: DummySpec;
  private readonly scale: number;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly raycaster = new THREE.Raycaster();

  private rock = 0;
  private rockVel = 0;

  constructor(options: DummyOptions = {}) {
    const spec = (this.spec = options.spec ?? DUMMY);
    const s = (this.scale = options.scale ?? RENDER_CONFIG.rigTorsoWorldLength);
    const distance = options.distance ?? TARGET_CONFIG.distance;
    const beltHeight = options.beltHeight ?? RENDER_CONFIG.rigHipWorldHeight;
    const body = options.body ?? "moulded";

    // Where the floor is, in torso units. Solving
    //   0 = beltHeight + floorLocal * scale
    // so the base sits on the ground whatever the figure's proportions are.
    const floorLocal = -beltHeight / s;
    this.cutHeight = beltHeight + spec.base * s;
    // Normal points UP, so everything below the cut is clipped away.
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.cutHeight);

    if (body === "moulded") {
      const geo = buildMouldedBody(spec, s);
      const mat = new THREE.MeshStandardMaterial({
        color: COLOURS.flesh,
        roughness: 0.58,
        metalness: 0.02,
      });
      this.pivot.add(new THREE.Mesh(geo, mat));
      this.disposables.push(geo, mat);
    }

    for (const zone of HIT_ZONES) {
      const marker = this.buildMarker(zone, s);
      this.markers.set(zone.id, marker);
      this.pivot.add(marker.fill, marker.ring);
    }

    // The pivot's origin is at the top of the column, so the body rocks about
    // the point the spring actually bends at. Rotating about the body's own
    // centre makes it wobble in place like a bobblehead.
    this.pivot.position.y = spec.base * s;
    for (const child of this.pivot.children) child.position.y -= spec.base * s;

    // The stand is not inside the pivot: a real dummy's base stays planted and
    // only the column above it flexes.
    this.group.add(this.buildStand(floorLocal, body, s), this.pivot);

    // Anchored on the belt line, which is the origin of the space the hit
    // zones live in - so the dummy's chin is at the height the resolver calls
    // chin height. Its front is +Z in spec space and the player's boxer also
    // faces +Z, so the dummy is turned to meet it.
    this.group.position.set(0, beltHeight, distance);
    this.group.rotation.y = Math.PI;
  }

  /**
   * A target marker sitting on the skin at a zone's position.
   *
   * The ring's radius is the zone's actual radius, so what the player aims at
   * and what the drill scores are the same circle. A decorative marker at a
   * different size would be a lie told in the most visible possible place.
   */
  private buildMarker(zone: HitZone, s: number): ZoneMarker {
    const { lateral, height } = zone.centre;
    const depth = surfaceDepth(lateral, height, this.spec);

    const ringMat = new THREE.MeshStandardMaterial({
      color: COLOURS.idle,
      emissive: new THREE.Color(COLOURS.idle),
      emissiveIntensity: 0.35,
      roughness: 0.4,
      transparent: true,
      opacity: 0.9,
      // Drawn over the body it sits on. Without this it z-fights with the
      // chest at every angle, because it is deliberately only a fraction of a
      // millimetre proud of the surface.
      depthWrite: false,
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(zone.radius * 0.86 * s, zone.radius * s, 40),
      ringMat
    );

    const fillMat = new THREE.MeshStandardMaterial({
      color: COLOURS.idle,
      emissive: new THREE.Color(COLOURS.idle),
      emissiveIntensity: 0.15,
      roughness: 0.5,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(zone.radius * 0.86 * s, 40),
      fillMat
    );

    for (const m of [ring, fill]) {
      m.position.set(lateral * s, height * s, depth * s + 0.004);
      // Tilted to follow the body's curve, so a marker out on the ribs lies on
      // the surface instead of standing edge-on to it.
      m.rotation.y = Math.atan2(lateral, depth) * 0.85;
      m.renderOrder = 2;
    }
    fill.renderOrder = 1;

    this.disposables.push(ringMat, fillMat, ring.geometry, fill.geometry);
    return {
      zone,
      ring,
      fill,
      ringMat,
      fillMat,
      lit: 0,
      flash: 0,
      flashColour: new THREE.Color(COLOURS.good),
    };
  }

  /** The sprung column, the mounting collar, and the weighted base. */
  private buildStand(floorLocal: number, body: DummyBody, s: number): THREE.Group {
    const g = new THREE.Group();
    const { radius, footRadius } = this.spec.stand;
    const floor = floorLocal * s;
    const top = this.spec.base * s;

    const columnMat = new THREE.MeshStandardMaterial({
      color: COLOURS.column,
      roughness: 0.62,
      metalness: 0.1,
    });
    this.disposables.push(columnMat);

    // The collar: a socket the body plugs into.
    //
    // It exists for the "figure" body specifically. Clipping a skinned mesh
    // leaves an open cross-section - a torso is a shell, so cutting it shows
    // the inside of the chest. The collar is a solid cap wide enough to cover
    // that hole, and it reads as the mounting socket a real dummy's torso sits
    // in rather than as a patch over a mistake.
    const collarTop = halfWidthAt(this.spec.base, this.spec) * s * 1.14;
    const collarHeight = (body === "figure" ? 0.3 : 0.16) * s;
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(collarTop, radius * s * 1.5, collarHeight, 30),
      columnMat
    );
    collar.position.y = top - collarHeight / 2;
    g.add(collar);
    this.disposables.push(collar.geometry);

    // The ribbed bellows sleeve over the height-adjustment shaft. The ribs are
    // what make the stand read as a piece of equipment rather than a pole.
    const ribs = 11;
    const ribTop = top - collarHeight;
    const ribBottom = floor + (top - floor) * 0.42;
    const ribHeight = (ribTop - ribBottom) / ribs;
    for (let i = 0; i < ribs; i++) {
      const t = i / (ribs - 1);
      const r = radius * s * (i % 2 === 0 ? 1.28 : 1.0);
      const rib = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, ribHeight * 1.05, 20),
        columnMat
      );
      rib.position.y = ribTop + (ribBottom - ribTop) * t;
      g.add(rib);
      this.disposables.push(rib.geometry);
    }

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * s * 0.8, radius * s * 0.8, top - floor, 20),
      columnMat
    );
    shaft.position.y = (top + floor) / 2;
    g.add(shaft);
    this.disposables.push(shaft.geometry);

    // Weighted base: a broad truncated cone, which is both what the photo
    // shows and what a water-filled base actually is.
    const baseHeight = (top - floor) * 0.22;
    const baseMat = new THREE.MeshStandardMaterial({
      color: COLOURS.base,
      roughness: 0.75,
      metalness: 0.12,
    });
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(footRadius * s * 0.62, footRadius * s, baseHeight, 28),
      baseMat
    );
    base.position.y = floor + baseHeight / 2;
    g.add(base);
    this.disposables.push(base.geometry, baseMat);
    return g;
  }

  /**
   * Re-seats every marker onto the surface of a supplied figure.
   *
   * The moulded body's surface is known analytically; a character's is not, so
   * the markers are raycast onto the real mesh. Without this they sit at the
   * moulded spec's depth, and wherever the character is thicker than that spec
   * the marker is buried inside the chest - invisible, and silent about it.
   *
   * This reads the character mesh, and is allowed to: it decides where to draw
   * a decal. The zone's position in torso units is unchanged and hit
   * resolution never comes near this, so what you hit still does not depend on
   * how it is drawn.
   */
  projectMarkersOnto(figure: THREE.Object3D): void {
    figure.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();

    for (const m of this.markers.values()) {
      const parent = m.ring.parent;
      if (!parent) continue;
      const { lateral, height } = m.zone.centre;
      // Start well clear of any plausible chest and look back toward the
      // midline, along the dummy's own forward axis.
      origin.set(
        lateral * this.scale,
        m.ring.position.y,
        this.spec.torsoDepth * this.scale * 1.5
      );
      parent.localToWorld(origin);
      dir.set(0, 0, -1).transformDirection(parent.matrixWorld).normalize();

      this.raycaster.set(origin, dir);
      this.raycaster.far = this.spec.torsoDepth * this.scale * 4;
      const hits = this.raycaster.intersectObject(figure, true);
      if (hits.length === 0) continue;

      const local = parent.worldToLocal(hits[0].point.clone());
      // Proud of the skin by a hair, or it z-fights with the surface it is on.
      local.z += 0.005;
      m.ring.position.copy(local);
      m.fill.position.copy(local);
      void height;
    }
  }

  /** Marks one zone as the target being asked for. Pass null to clear. */
  setLit(zoneId: string | null): void {
    for (const [id, m] of this.markers) m.lit = id === zoneId ? 1 : 0;
  }

  /**
   * The physical reaction to being hit.
   *
   * Separate from `score` because the two are caused by different things. A
   * dummy rocks when it is punched - always, including in free work where
   * nothing is scored and no target is lit. Folding the rock into the scoring
   * call would leave the dummy standing perfectly still while being hit
   * whenever a drill was not running, which reads as broken hit detection.
   */
  impact(power: number): void {
    // An impulse rather than a set angle, so a fast combination compounds
    // instead of each punch resetting the last.
    this.rockVel += 2.6 * Math.max(0.15, power);
  }

  /** The scoring reaction: flashes a marker by how well the punch landed. */
  score(zoneId: string | null, accuracy: number): void {
    if (!zoneId) return;
    const m = this.markers.get(zoneId);
    if (!m) return;
    m.flash = 1;
    m.flashColour.setHex(accuracy >= 0.5 ? COLOURS.good : COLOURS.poor);
  }

  /** Advances the flashes and the spring. `dt` in seconds. */
  update(dt: number): void {
    // Clamped: a tab restored from the background delivers one enormous dt,
    // and an unclamped spring integrates that into a dummy folded in half.
    const step = Math.min(dt, 1 / 20);

    // Damped harmonic return. Stiff and heavily damped, because a dummy on a
    // water base settles in about a second rather than oscillating.
    this.rockVel += (-46 * this.rock - 7.4 * this.rockVel) * step;
    this.rock += this.rockVel * step;
    this.pivot.rotation.x = -this.rock * 0.1;

    for (const m of this.markers.values()) {
      m.flash = Math.max(0, m.flash - step * 2.6);
      const base = m.lit > 0 ? COLOURS.lit : COLOURS.idle;
      const intensity = m.lit > 0 ? 1.15 : 0.3;

      if (m.flash > 0) {
        m.ringMat.color.copy(m.flashColour);
        m.ringMat.emissive.copy(m.flashColour);
        m.ringMat.emissiveIntensity = 0.6 + m.flash * 2.4;
        m.fillMat.color.copy(m.flashColour);
        m.fillMat.opacity = 0.18 + m.flash * 0.5;
      } else {
        m.ringMat.color.setHex(base);
        m.ringMat.emissive.setHex(base);
        m.ringMat.emissiveIntensity = intensity;
        m.fillMat.color.setHex(base);
        m.fillMat.opacity = m.lit > 0 ? 0.3 : 0.14;
      }
      m.fillMat.emissive.copy(m.ringMat.emissive);
      m.fillMat.emissiveIntensity = intensity * 0.4;
      // A lit target breathes, so it is findable in peripheral vision - which
      // is where it will be, because the player is watching their own hands.
      const pulse = m.lit > 0 ? 1 + Math.sin(performance.now() / 260) * 0.07 : 1;
      m.ring.scale.setScalar(pulse);
    }
  }

  /** Marker positions in world space, for the HUD to point at. */
  markerWorldPosition(zoneId: string, out = new THREE.Vector3()): THREE.Vector3 | null {
    const m = this.markers.get(zoneId);
    if (!m) return null;
    return m.ring.getWorldPosition(out);
  }

  /**
   * Disposes everything this built.
   *
   * Only what is in `disposables`, which is the list of things this class
   * Created. A supplied figure belongs to the caller - and materials are
   * shared across the stand's ribs by design, so traversing and disposing per
   * mesh would double-dispose. This project has already been bitten by exactly
   * that with SkeletonUtils.clone sharing materials by reference.
   */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
