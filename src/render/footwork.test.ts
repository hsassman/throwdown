import { describe, it, expect } from "vitest";
import { Footwork, boxingStance, type StanceOffsets } from "./footwork";
import { FOOTWORK_CONFIG } from "../config/tuning";

// The stepping rule, exercised without a rig or a renderer. Everything here is
// a position in a ground plane and a dt, which is the whole point of keeping
// this module frame-agnostic — see its header.

const OFFSETS: StanceOffsets = {
  left: { x: -0.3, z: 0.3 },
  right: { x: 0.3, z: -0.3 },
};

/** Runs the machine at 60 Hz while the body travels to `to` over `seconds`. */
function travel(
  fw: Footwork,
  to: { x: number; z: number },
  seconds: number,
  from = { x: 0, z: 0 }
) {
  const steps = Math.max(1, Math.round(seconds * 60));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    fw.update(1 / 60, {
      x: from.x + (to.x - from.x) * t,
      z: from.z + (to.z - from.z) * t,
    });
  }
}

/** Holds still for `seconds`, letting any step in flight finish. */
function settle(fw: Footwork, body: { x: number; z: number }, seconds = 1) {
  for (let i = 0; i < seconds * 60; i++) fw.update(1 / 60, body);
}

describe("standing still", () => {
  it("plants both feet in the stance and leaves them there", () => {
    const fw = new Footwork(OFFSETS);
    expect(fw.left).toMatchObject({ x: -0.3, z: 0.3, lift: 0 });
    expect(fw.right).toMatchObject({ x: 0.3, z: -0.3, lift: 0 });

    settle(fw, { x: 0, z: 0 }, 2);
    // Two seconds of standing must not produce a single step. A fighter whose
    // feet shuffle while nothing is happening reads as nervous idling, and it
    // was the first thing that went wrong when the trigger was too tight.
    expect(fw.steppingFoot).toBeNull();
    expect(fw.left.x).toBeCloseTo(-0.3, 9);
    expect(fw.right.x).toBeCloseTo(0.3, 9);
  });

  it("keeps both feet on the canvas while nothing is moving", () => {
    const fw = new Footwork(OFFSETS);
    settle(fw, { x: 0, z: 0 }, 1);
    expect(fw.left.lift).toBe(0);
    expect(fw.right.lift).toBe(0);
  });
});

describe("a foot is left behind before it steps", () => {
  it("does not step for travel inside the trigger distance", () => {
    const fw = new Footwork(OFFSETS);
    const small = FOOTWORK_CONFIG.stepTrigger * 0.5;
    travel(fw, { x: small, z: 0 }, 0.5);
    expect(fw.steppingFoot).toBeNull();
    // The feet really have been left behind — that is the point. The body has
    // moved and they have not.
    expect(fw.left.x).toBeCloseTo(-0.3, 9);
  });

  it("steps once the body has pulled a foot past the trigger", () => {
    const fw = new Footwork(OFFSETS);
    const to = FOOTWORK_CONFIG.stepTrigger * 2;
    travel(fw, { x: to, z: 0 }, 0.6);
    settle(fw, { x: to, z: 0 }, 1.5);
    // Both feet have caught up to the new stance — to within the settle bar,
    // which is where the feet are deliberately allowed to come to rest rather
    // than endlessly correcting the last millimetre.
    expect(Math.abs(fw.left.x - (to - 0.3))).toBeLessThan(
      FOOTWORK_CONFIG.settleTrigger
    );
    expect(Math.abs(fw.right.x - (to + 0.3))).toBeLessThan(
      FOOTWORK_CONFIG.settleTrigger
    );
  });
});

describe("only ever one foot at a time", () => {
  it("never lifts both feet, however fast the body travels", () => {
    const fw = new Footwork(OFFSETS);
    let bothOff = false;
    // Deliberately violent: a sprint across the ring, far faster than the sim
    // can actually command, because the invariant has to hold under the worst
    // input rather than the expected one.
    for (let i = 0; i < 240; i++) {
      fw.update(1 / 60, { x: i * 0.02, z: i * 0.01 });
      if (fw.left.lift > 0 && fw.right.lift > 0) bothOff = true;
    }
    expect(bothOff).toBe(false);
  });

  it("alternates feet under sustained travel rather than dragging one", () => {
    const fw = new Footwork(OFFSETS);
    const order: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 400; i++) {
      fw.update(1 / 60, { x: i * 0.004, z: 0 });
      const s = fw.steppingFoot;
      if (s && s !== last) order.push(s);
      last = s;
    }
    expect(order.length).toBeGreaterThan(3);
    // No foot takes two steps in a row while the other stands: that is the
    // difference between walking and dragging a leg behind you.
    for (let i = 1; i < order.length; i++) {
      expect(order[i], `step ${i} repeated ${order[i]}`).not.toBe(order[i - 1]);
    }
  });
});

describe("the step itself", () => {
  it("lifts the foot off the canvas and puts it back down", () => {
    const fw = new Footwork(OFFSETS);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      fw.update(1 / 60, { x: 0.5, z: 0 });
      peak = Math.max(peak, fw.left.lift, fw.right.lift);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(FOOTWORK_CONFIG.stepHeight + 1e-9);
    // And it is DOWN at the end. A foot that finishes a step in the air is a
    // foot the IK will hold in the air indefinitely.
    expect(fw.left.lift).toBe(0);
    expect(fw.right.lift).toBe(0);
  });

  it("lands the foot where the body ENDED UP, not where it started", () => {
    // The failure this pins: freezing the step's destination at lift-off. A
    // foot launched while the body is still travelling then lands a full step
    // behind, and the fighter moonwalks — visibly wrong and easy to reintroduce.
    //
    // Asserted against the SETTLE bar rather than an exact landing, because
    // coming to rest within that bar is the deliberate contract. A frozen
    // destination would miss by roughly the distance the body covers during a
    // step, which is an order of magnitude larger.
    const fw = new Footwork(OFFSETS);
    travel(fw, { x: 1.2, z: 0 }, 0.8);
    settle(fw, { x: 1.2, z: 0 }, 2);
    expect(Math.abs(fw.left.x - (1.2 - 0.3))).toBeLessThan(
      FOOTWORK_CONFIG.settleTrigger
    );
    expect(Math.abs(fw.right.x - (1.2 + 0.3))).toBeLessThan(
      FOOTWORK_CONFIG.settleTrigger
    );
  });

  it("brings the trailing foot up instead of leaving the stance lopsided", () => {
    // Without the settle rule the second foot never moves at all: its own
    // stretch sits below the step trigger, so a fighter who circled once stayed
    // permanently narrow, and drifted further with every exchange.
    const fw = new Footwork(OFFSETS);
    travel(fw, { x: 0.9, z: 0 }, 0.5);
    settle(fw, { x: 0.9, z: 0 }, 2);
    const width = Math.abs(fw.right.x - fw.left.x);
    const restingWidth = Math.abs(OFFSETS.right.x - OFFSETS.left.x);
    expect(width).toBeCloseTo(restingWidth, 1);
  });

  it("finishes a step within its configured duration", () => {
    const fw = new Footwork(OFFSETS);
    // Trigger one step, then hold still and count how long it stays in flight.
    travel(fw, { x: 0.6, z: 0 }, 0.2);
    let frames = 0;
    while (fw.steppingFoot !== null && frames < 600) {
      fw.update(1 / 60, { x: 0.6, z: 0 });
      frames++;
    }
    expect(frames / 60).toBeLessThanOrEqual(FOOTWORK_CONFIG.stepSeconds + 0.02);
  });
});

describe("resetting", () => {
  it("re-seats both feet under the body with no step animation", () => {
    const fw = new Footwork(OFFSETS);
    travel(fw, { x: 2, z: 1 }, 0.3);
    fw.plantBoth({ x: 5, z: -5 });
    expect(fw.left).toMatchObject({ x: 4.7, z: -4.7, lift: 0 });
    expect(fw.right).toMatchObject({ x: 5.3, z: -5.3, lift: 0 });
    expect(fw.steppingFoot).toBeNull();
  });
});

describe("the boxing stance", () => {
  const LEFT = { x: 1, z: 0 };
  const FWD = { x: 0, z: 1 };

  it("straddles the centre line rather than putting both feet on one side", () => {
    // The sign bug this pins produced a fighter standing with its ankles
    // crossed. Asserted as "opposite sides", never as a particular sign, so it
    // still holds for either basis a caller passes.
    for (const lead of ["left", "right"] as const) {
      for (const s of [1, -1]) {
        const st = boxingStance(lead, 0.3, 0.3, { x: s, z: 0 }, FWD);
        expect(Math.sign(st.left.x), `lead=${lead} leftAxis=${s}`).toBe(
          -Math.sign(st.right.x)
        );
      }
    }
  });

  it("puts the LEAD foot forward and the rear foot back", () => {
    const orthodox = boxingStance("left", 0.3, 0.3, LEFT, FWD);
    expect(orthodox.left.z).toBeGreaterThan(orthodox.right.z);

    const southpaw = boxingStance("right", 0.3, 0.3, LEFT, FWD);
    expect(southpaw.right.z).toBeGreaterThan(southpaw.left.z);
  });

  it("flips front for back when the caller's forward axis is reversed", () => {
    const facing = boxingStance("left", 0.3, 0.3, LEFT, FWD);
    const away = boxingStance("left", 0.3, 0.3, LEFT, { x: 0, z: -1 });
    expect(facing.left.z).toBeCloseTo(-away.left.z, 9);
  });

  it("gives the rear foot the wider base", () => {
    const s = boxingStance("left", 0.3, 0.3, LEFT, FWD);
    expect(Math.abs(s.right.x)).toBeGreaterThan(Math.abs(s.left.x));
  });

  it("orients the whole stance to an off-axis basis", () => {
    // A stage that stands the fighters on a diagonal. The stance must rotate
    // with them rather than staying glued to the world axes — the feet still
    // have to straddle the body and the lead foot still has to be the forward
    // one, measured along the basis the caller actually passed.
    const k = Math.SQRT1_2;
    const left = { x: k, z: k };
    const forward = { x: k, z: -k };
    const s = boxingStance("left", 0.3, 0.3, left, forward);

    const along = (g: { x: number; z: number }, b: { x: number; z: number }) =>
      g.x * b.x + g.z * b.z;
    expect(Math.sign(along(s.left, left))).toBe(-Math.sign(along(s.right, left)));
    expect(along(s.left, forward)).toBeGreaterThan(along(s.right, forward));
  });
});
