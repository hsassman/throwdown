import { describe, it, expect } from "vitest";
import {
  ARENAS,
  FIGHT_MODES,
  MAIN_MENU,
  ONLINE_MODES,
  ROSTER,
  defaultMatch,
  formatRoundLength,
  matchBlockedReason,
  missingLockReasons,
} from "./menuModel";
import { defaultSettings, formatSetting, stepSetting } from "./settingsModel";

describe("menu honesty", () => {
  it("explains every locked item", () => {
    // The rule this project's docs already broke once by claiming more than
    // the code did. A menu is the most visible place for that to recur, and a
    // dead tile with no explanation is the worst version of it.
    expect(missingLockReasons()).toEqual([]);
  });

  it("offers at least one thing that actually works on every screen it can", () => {
    const playable = (items: { availability: string }[]) =>
      items.some((i) => i.availability !== "locked");
    expect(playable(MAIN_MENU)).toBe(true);
    expect(playable(FIGHT_MODES)).toBe(true);
    expect(playable(ROSTER)).toBe(true);
    expect(playable(ARENAS)).toBe(true);
    // Online is the exception, and deliberately so — nothing there is built.
    expect(ONLINE_MODES.every((m) => m.availability === "locked")).toBe(true);
  });

  it("starts on a config that can actually be played", () => {
    // A default selection that is itself blocked would mean the very first
    // press of Start fails, which is a bad first thirty seconds.
    expect(matchBlockedReason(defaultMatch())).toBeNull();
  });

  it("refuses a locked selection with a reason, not a silent no-op", () => {
    const blocked = matchBlockedReason({ ...defaultMatch(), arenaId: "gym" });
    expect(blocked).toBeTruthy();
    expect(blocked).toContain("Gym");
  });
});

describe("settings stepper", () => {
  const find = (tab: string, id: string) =>
    defaultSettings()
      .find((t) => t.id === tab)!
      .settings.find((s) => s.id === id)!;

  it("does not accumulate floating-point drift", () => {
    // 0.95 -0.05 +0.05 must still be 0.95 and must still render as "0.95".
    // Without snapping, the label grows a tail of nines after a few presses —
    // which looks exactly like a broken setting.
    let s = find("gameplay", "reach");
    for (let i = 0; i < 40; i++) {
      s = stepSetting(s, i % 2 === 0 ? -1 : 1);
    }
    expect(s.kind).toBe("slider");
    expect(formatSetting(s)).toBe("0.95");
  });

  it("clamps sliders at both ends instead of running away", () => {
    let s = find("gameplay", "damageScale");
    for (let i = 0; i < 50; i++) s = stepSetting(s, 1);
    expect(formatSetting(s)).toBe("2 x");
    for (let i = 0; i < 50; i++) s = stepSetting(s, -1);
    expect(formatSetting(s)).toBe("0.25 x");
  });

  it("wraps choices in both directions", () => {
    const first = find("tracking", "delegate");
    let s = stepSetting(first, -1);
    expect(formatSetting(s)).toContain("CPU");
    s = stepSetting(s, 1);
    expect(formatSetting(s)).toBe(formatSetting(first));
  });

  it("toggles ignore direction", () => {
    const s = find("gameplay", "fouls");
    expect(formatSetting(stepSetting(s, 1))).toBe(
      formatSetting(stepSetting(s, -1))
    );
  });

  it("keeps the gameplay default in step with the tuned constant", () => {
    // The punch-sensitivity slider mirrors STRIKE_CONFIG.reachThreshold. If
    // one moves without the other, the menu quietly lies about the default.
    expect(formatSetting(find("gameplay", "reach"))).toBe("0.95");
  });
});

describe("formatting", () => {
  it("renders round lengths as clock time", () => {
    expect(formatRoundLength(180)).toBe("3:00");
    expect(formatRoundLength(90)).toBe("1:30");
  });
});
