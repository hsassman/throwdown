import * as THREE from "three";
import { FACE_CONFIG } from "../../config/tuning";

// Visible facial damage: swelling, cuts, bleeding, and the eyes themselves.

/** Which facial structure took damage. Mirrors strikeGeometry's region ids. */
export type FaceSite = "eyeLeft" | "eyeRight" | "cheekLeft" | "cheekRight" | "nose" | "jaw";

/** How damaged one site is, 0-1, plus how wet the bleeding still is. */
interface SiteState {
  swelling: number;
  /** Fresh blood, fades as it dries and is wiped. */
  bleed: number;
  /** An open cut, which does not heal within a fight. */
  cut: number;
}

export interface FaceDamageState {
  sites: Record<FaceSite, SiteState>;
  /** 0 = both eyes open, 1 = fully closed. Convenience for the HUD and CPU. */
  eyeClosure: { left: number; right: number };
}

function freshSite(): SiteState {
  return { swelling: 0, bleed: 0, cut: 0 };
}

const SITES: FaceSite[] = [
  "eyeLeft",
  "eyeRight",
  "cheekLeft",
  "cheekRight",
  "nose",
  "jaw",
];

/**
 * Maps an anatomical region id from strikeGeometry onto the facial sites a hit
 * there would damage, with how much of the blow each one absorbs.
 */
const REGION_TO_SITES: Record<string, [FaceSite, number][]> = {
  temple_left: [
    ["eyeLeft", 0.7],
    ["cheekLeft", 0.4],
  ],
  temple_right: [
    ["eyeRight", 0.7],
    ["cheekRight", 0.4],
  ],
  jaw_left: [
    ["jaw", 0.6],
    ["cheekLeft", 0.5],
  ],
  jaw_right: [
    ["jaw", 0.6],
    ["cheekRight", 0.5],
  ],
  chin: [["jaw", 0.8]],
  // The nose is the classic bleeder, and it bleeds far more than it swells.
  nose: [
    ["nose", 1.0],
    ["cheekLeft", 0.2],
    ["cheekRight", 0.2],
  ],
  forehead: [
    ["eyeLeft", 0.25],
    ["eyeRight", 0.25],
  ],
  crown: [],
  throat: [],
};

export interface FaceDamageOptions {
  /** The figure whose bones are scaled. */
  root: THREE.Object3D;
  /** Called when the damage state has changed and the texture needs a repaint. */
  onChanged?: () => void;
}

/** What the texture layer needs to draw a face. Implemented in facePainter.ts
 *  and registered as an overlay on the body texture. */
export interface FacePainter {
  /** Draws eyes, blood and discolouration for the given state. */
  render(state: FaceDamageState): void;
}

export class FaceDamage {
  private state: FaceDamageState;
  private bones = new Map<string, THREE.Bone>();
  /** Bind-pose scales, so swelling is applied relative to rest rather than
   *  compounding every frame into a balloon. */
  private restScale = new Map<string, THREE.Vector3>();
  private onChanged: (() => void) | null;
  private dirty = true;

  constructor(options: FaceDamageOptions) {
    this.onChanged = options.onChanged ?? null;
    this.state = {
      sites: {
        eyeLeft: freshSite(),
        eyeRight: freshSite(),
        cheekLeft: freshSite(),
        cheekRight: freshSite(),
        nose: freshSite(),
        jaw: freshSite(),
      },
      eyeClosure: { left: 0, right: 0 },
    };

    for (const name of ["l_eye", "r_eye", "c_jaw", "c_head"]) {
      const b = options.root.getObjectByName(name) as THREE.Bone | undefined;
      if (b) {
        this.bones.set(name, b);
        this.restScale.set(name, b.scale.clone());
      }
    }
  }

  get damage(): FaceDamageState {
    return this.state;
  }

  /** True while any site shows damage - lets callers skip work on a clean face. */
  get any(): boolean {
    for (const s of SITES) {
      const st = this.state.sites[s];
      if (st.swelling > 0.01 || st.bleed > 0.01 || st.cut > 0.01) return true;
    }
    return false;
  }

  reset(): void {
    for (const s of SITES) this.state.sites[s] = freshSite();
    this.state.eyeClosure.left = 0;
    this.state.eyeClosure.right = 0;
    this.dirty = true;
    this.applySwelling();
  }

  /** Records a landed strike. */
  hit(regionId: string, power: number): void {
    const targets = REGION_TO_SITES[regionId];
    if (!targets || targets.length === 0) return;
    const cfg = FACE_CONFIG;

    for (const [site, share] of targets) {
      const s = this.state.sites[site];
      const force = power * share;
      s.swelling = Math.min(1, s.swelling + force * cfg.swellPerHit);

      // Bleeding needs a real blow, not a graze. Below the threshold a punch
      // swells but does not break skin, which is both true and stops a jab
      // tally turning the face into a horror prop.
      if (force >= cfg.bleedThreshold) {
        s.bleed = Math.min(1, s.bleed + force * cfg.bleedPerHit);
        // A cut only opens once the tissue is already swollen - swollen skin
        // splits, fresh skin absorbs. That is why cuts appear late in a fight
        // rather than from the first clean shot.
        if (s.swelling > cfg.cutSwellingRequired) {
          s.cut = Math.min(1, s.cut + force * cfg.cutPerHit);
        }
      }
    }
    this.dirty = true;
  }

  /** Ages the damage and re-applies it. Call once per rendered frame. */
  update(dt: number): void {
    const cfg = FACE_CONFIG;
    let changed = false;

    for (const site of SITES) {
      const s = this.state.sites[site];
      // Swelling goes down slowly - over a fight, not over a round.
      if (s.swelling > 0) {
        s.swelling = Math.max(0, s.swelling - dt / cfg.swellFadeSeconds);
        changed = true;
      }
      // Blood dries and is wiped away much faster than swelling subsides.
      if (s.bleed > 0) {
        s.bleed = Math.max(0, s.bleed - dt / cfg.bleedFadeSeconds);
        changed = true;
      }
      // Cuts do not close during a fight. They stay until reset().
    }

    // Eye closure is swelling on the eye itself plus, at a discount, the cheek
    // under it - which is anatomically how an eye actually closes up.
    const closure = (eye: FaceSite, cheek: FaceSite) =>
      Math.min(
        1,
        this.state.sites[eye].swelling +
          this.state.sites[cheek].swelling * cfg.cheekClosureShare
      );
    this.state.eyeClosure.left = closure("eyeLeft", "cheekLeft");
    this.state.eyeClosure.right = closure("eyeRight", "cheekRight");

    if (changed || this.dirty) {
      this.applySwelling();
      this.onChanged?.();
      this.dirty = false;
    }
  }

  /** Pushes the damage state onto the bones. */
  private applySwelling(): void {
    const cfg = FACE_CONFIG;

    // Note: eyeClosure is tracked as a damage metric only - nothing renders
    // it. It cannot be driven through the rig because l_eye/r_eye carry zero
    // skin weight (asserted in the test), and the generated eyeballs that
    // used to consume it were removed. See blender/README.md.

    const jaw = this.bones.get("c_jaw");
    const jawRest = this.restScale.get("c_jaw");
    if (jaw && jawRest) {
      const puff =
        (this.state.sites.cheekLeft.swelling +
          this.state.sites.cheekRight.swelling +
          this.state.sites.jaw.swelling) /
        3;
      const k = 1 + puff * cfg.jawPuff;
      jaw.scale.set(jawRest.x * k, jawRest.y * k, jawRest.z * k);
    }
  }
}

/** Total damage across the face, 0-1 - a single number for the HUD. */
export function faceDamageScore(state: FaceDamageState): number {
  let total = 0;
  for (const s of SITES) {
    const st = state.sites[s];
    total += st.swelling * 0.5 + st.cut * 0.35 + st.bleed * 0.15;
  }
  return Math.min(1, total / SITES.length);
}
