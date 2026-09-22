import { describe, it, expect } from "vitest";
import { FightCamera, type CameraPose, type DirectorInput } from "./fightCamera";

const input: DirectorInput = {
  player: { x: 0, y: 0, z: -0.4 },
  opponent: { x: 0, y: 0, z: 0.4 },
  radius: 4.95,
};

// Stepped by count, not by accumulating a float clock. `for (t = 0; t < 1;
// t += 1/30)` runs 31 times, not 30 - the accumulated float error leaves it
// just under 1 after the 30th - so a naive loop simulates 1.033 s at 30 FPS
// against 1.004 s at 240 FPS, and the frame-rate-independence test below fails
// on a 3% difference in elapsed time that has nothing to do with the code.
const run = (cam: FightCamera, seconds: number, dt = 1 / 60, i = input) => {
  const steps = Math.round(seconds / dt);
  for (let n = 0; n < steps; n++) cam.update(dt, i);
};

describe("shot selection", () => {
  it("refuses discretionary cuts while a round is live", () => {
    // The rule the whole director is built around. A cut mid-exchange costs
    // the viewer a beat, and here the viewer is also throwing real punches.
    const cam = new FightCamera(input);
    cam.setLive(true);
    expect(cam.cut("overhead")).toBe(false);
    expect(cam.shot).toBe("broadcast");
  });

  it("allows a forced cut, which is what a knockdown is", () => {
    const cam = new FightCamera(input);
    cam.setLive(true);
    expect(cam.cut("lowAngle", true)).toBe(true);
    expect(cam.shot).toBe("lowAngle");
  });

  it("returns to the broadcast shot on its own after a held shot", () => {
    const cam = new FightCamera(input);
    cam.cut("lowAngle", true);
    run(cam, 2);
    expect(cam.shot).toBe("lowAngle");
    run(cam, 2);
    expect(cam.shot).toBe("broadcast");
  });

  it("holds the broadcast shot indefinitely", () => {
    const cam = new FightCamera(input);
    run(cam, 120);
    expect(cam.shot).toBe("broadcast");
  });
});

describe("framing", () => {
  it("puts the default camera side-on, so neither fighter occludes the other", () => {
    // The single most important property of a fight camera, and the reason
    // broadcast sits side-on rather than behind one fighter.
    const cam = new FightCamera(input);
    const pose = cam.snap(input);
    // Fighters are separated along z, so the camera must be off to the side
    // in x, not down the z axis between them.
    expect(Math.abs(pose.position.x)).toBeGreaterThan(Math.abs(pose.position.z) + 1);
  });

  it("looks up from below for a knockdown", () => {
    const cam = new FightCamera(input);
    cam.cut("lowAngle", true);
    const pose = cam.snap(input);
    expect(pose.position.y).toBeLessThan(pose.target.y);
    expect(pose.position.y).toBeLessThan(1);
  });

  it("narrows the field of view for a tight shot", () => {
    const wide = new FightCamera(input).snap(input).fov;
    const cam = new FightCamera(input);
    cam.cut("tight");
    expect(cam.snap(input).fov).toBeLessThan(wide);
  });

  it("keeps the camera inside a sane distance of the cage", () => {
    const cam = new FightCamera(input);
    for (const shot of ["broadcast", "tight", "lowAngle", "corner", "overhead"] as const) {
      cam.cut(shot, true);
      const p = cam.snap(input);
      expect(Math.hypot(p.position.x, p.position.z)).toBeLessThan(input.radius * 2);
      expect(Number.isFinite(p.position.y)).toBe(true);
    }
  });
});

describe("robustness", () => {
  it("does not produce NaN when the fighters are in a clinch", () => {
    // Two fighters in exactly the same spot gives no axis to derive a shot
    // from - and a clinch is precisely when they are closest. Without a
    // fallback every shot becomes NaN and the camera vanishes.
    const clinch: DirectorInput = {
      player: { x: 1, y: 0, z: 1 },
      opponent: { x: 1, y: 0, z: 1 },
      radius: 4.95,
    };
    const cam = new FightCamera(clinch);
    for (const shot of ["broadcast", "tight", "lowAngle", "corner", "overhead"] as const) {
      cam.cut(shot, true);
      const p = cam.snap(clinch);
      for (const v of [p.position, p.target]) {
        expect(Number.isFinite(v.x)).toBe(true);
        expect(Number.isFinite(v.y)).toBe(true);
        expect(Number.isFinite(v.z)).toBe(true);
      }
    }
  });

  it("eases at the same rate regardless of frame rate", () => {
    // The naive `current += (want - current) * k` moves further per second at
    // 120 FPS than at 30, so the camera would feel different on different
    // machines - the same bug the bone smoothing had to fix.
    const far: DirectorInput = { ...input, player: { x: 3, y: 0, z: 0 } };
    const a = new FightCamera(input);
    const b = new FightCamera(input);
    run(a, 1, 1 / 30, far);
    run(b, 1, 1 / 240, far);
    expect(b.pose.position.x).toBeCloseTo(a.pose.position.x, 2);
    expect(b.pose.position.z).toBeCloseTo(a.pose.position.z, 2);
  });

  it("eases rather than teleporting", () => {
    const cam = new FightCamera(input);
    const start = { ...cam.pose.position };
    cam.cut("overhead", true);
    cam.update(1 / 60, input);
    // Moved, but nowhere near all the way in one frame.
    const moved = Math.abs(cam.pose.position.y - start.y);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(1);
  });
});

// The director is not the gameplay camera - see setHouseShot. These cover the
// handover, which is the part that decides whether a knockdown replay feels
// like coverage or like the camera glitching.
describe("house shot", () => {
  const house: CameraPose = {
    position: { x: 0.7, y: 1.45, z: -2.2 },
    target: { x: 0, y: 1.3, z: 0.2 },
    fov: 35,
  };

  it("rests at the caller's pose instead of the built-in broadcast frame", () => {
    const cam = new FightCamera(input);
    cam.setHouseShot(house);
    const pose = cam.snap(input);
    expect(pose.position.x).toBeCloseTo(house.position.x, 6);
    expect(pose.position.z).toBeCloseTo(house.position.z, 6);
    expect(pose.fov).toBeCloseTo(house.fov, 6);
  });

  it("still uses the side-on broadcast frame when no house shot is set", () => {
    const cam = new FightCamera(input);
    cam.setHouseShot(house);
    cam.setHouseShot(null);
    const pose = cam.snap(input);
    expect(Math.abs(pose.position.x)).toBeGreaterThan(1);
  });

  it("eases back to the house shot after a knockdown rather than snapping", () => {
    // The whole reason the house shot exists. Without it the only way back to
    // the gameplay camera is a teleport on the frame the hold expires.
    const cam = new FightCamera(input);
    cam.setHouseShot(house);
    cam.snap(input);
    cam.cut("lowAngle", true);
    run(cam, 1);
    // Gone somewhere else...
    expect(cam.cinematic).toBe(true);
    expect(cam.pose.position.y).toBeLessThan(house.position.y);
    // ...held, expired, and come back on its own.
    run(cam, 6);
    expect(cam.cinematic).toBe(false);
    expect(cam.settleError(input)).toBeLessThan(0.05);
    expect(cam.pose.position.y).toBeCloseTo(house.position.y, 1);
  });

  it("reports a large settle error mid-move and a small one once parked", () => {
    // This is the signal the renderer uses to decide when to take its own
    // camera back, so a stuck-high or stuck-low value would either strand the
    // director in control or hand back mid-swing.
    const cam = new FightCamera(input);
    cam.setHouseShot(house);
    cam.snap(input);
    cam.cut("overhead", true);
    cam.update(1 / 60, input);
    expect(cam.settleError(input)).toBeGreaterThan(1);
    run(cam, 20);
    expect(cam.settleError(input)).toBeLessThan(0.05);
  });

  it("follows a house shot that moves, so the gameplay camera stays authoritative", () => {
    const cam = new FightCamera(input);
    cam.setHouseShot(house);
    cam.snap(input);
    cam.setHouseShot({ ...house, position: { x: 3, y: 2, z: -3 } });
    run(cam, 5);
    expect(cam.pose.position.x).toBeCloseTo(3, 1);
  });
});

describe("who the shot is about", () => {
  // A knockdown is about the fighter on the canvas. Framed on the midpoint -
  // which is what this did at first - the middle of a downed fighter and the
  // man standing over him is the standing man's waist, and the first real
  // knockdown put the downed fighter in the bottom corner, half out of frame.
  const downed: DirectorInput = {
    ...input,
    // On the canvas: still at the same spot on the ground, which is exactly
    // why the subject cannot be inferred from the positions.
    subject: { x: 0, y: 0, z: -0.4 },
  };

  it("points the knockdown shot at the named fighter", () => {
    const cam = new FightCamera(downed);
    cam.cut("lowAngle", true);
    const aimed = cam.snap(downed).target;
    const cam2 = new FightCamera(input);
    cam2.cut("lowAngle", true);
    const midAimed = cam2.snap(input).target;
    // The subject sits 0.4 behind the midpoint, so the aim must follow it.
    expect(aimed.z).toBeLessThan(midAimed.z - 0.3);
  });

  it("holds both fighters in the knockdown shot", () => {
    // It is a shot about the relationship between them, so a distance that
    // filled the frame with whoever was still standing was wrong.
    const cam = new FightCamera(downed);
    cam.cut("lowAngle", true);
    const p = cam.snap(downed).position;
    for (const who of [downed.player, downed.opponent]) {
      const d = Math.hypot(p.x - who.x, p.z - who.z);
      expect(d).toBeGreaterThan(1.5);
    }
  });

  it("looks up at a downed fighter rather than down on them", () => {
    const cam = new FightCamera(downed);
    cam.cut("lowAngle", true);
    const pose = cam.snap(downed);
    expect(pose.position.y).toBeLessThan(pose.target.y);
  });

  it("falls back to the midpoint when no subject is named", () => {
    const cam = new FightCamera(input);
    cam.cut("lowAngle", true);
    const t = cam.snap(input).target;
    expect(t.x).toBeCloseTo(0, 6);
    expect(t.z).toBeCloseTo(0, 6);
  });
});
