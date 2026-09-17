import { describe, it, expect } from "vitest";
import {
  CATEGORY_LABEL,
  ITEM_BY_ID,
  SHELL_ITEMS,
  STAGES,
  grouped,
  isPlayable,
} from "./shellModel";

// These enforce the honesty rule. They are cheap and they are the reason the
// menu cannot quietly start claiming more than the code does — which has
// already happened once in this project's own status docs.

describe("the honesty rule", () => {
  it("gives every locked entry a reason", () => {
    // A dead row with no explanation is the most annoying thing a menu can
    // contain: the player cannot tell a bug from a deliberate omission.
    for (const item of [...SHELL_ITEMS, ...STAGES]) {
      if (item.availability === "locked") {
        expect(`${item.id}: ${item.lockedReason ?? "MISSING"}`).toMatch(/: .+/);
        expect(item.lockedReason && item.lockedReason.length).toBeGreaterThan(10);
      }
    }
  });

  it("does not put a lockedReason on something that is not locked", () => {
    // A stale reason left behind after something shipped would read as the
    // opposite of the truth.
    for (const item of [...SHELL_ITEMS, ...STAGES]) {
      if (item.availability !== "locked") {
        expect(`${item.id}:${item.lockedReason ?? ""}`).toBe(`${item.id}:`);
      }
    }
  });

  it("names the punch classifier's real measured rate", () => {
    // The single most important number in the project to not quietly drop.
    // It is 19%, nothing depends on it, and the menu says so out loud.
    const lab = ITEM_BY_ID.get("punchlab")!;
    expect(lab.availability).not.toBe("ready");
    expect(lab.detail).toMatch(/19%/);
  });

  it("marks multiplayer locked, not preview", () => {
    // Networking is genuinely not started. "Preview" would imply a player
    // could get into a fight and be disappointed rather than informed.
    for (const id of ["lan", "internet", "local"]) {
      expect(ITEM_BY_ID.get(id)!.availability).toBe("locked");
    }
  });

  it("offers at least one thing that actually works", () => {
    // A menu where nothing is ready is a menu with no reason to exist.
    expect(SHELL_ITEMS.filter((i) => i.availability === "ready").length).toBeGreaterThan(0);
  });
});

describe("shape", () => {
  it("has unique ids across modes and stages", () => {
    expect(ITEM_BY_ID.size).toBe(SHELL_ITEMS.length);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(STAGES.length);
  });

  it("gives every entry both a short blurb and a longer detail", () => {
    for (const i of SHELL_ITEMS) {
      expect(i.blurb.length).toBeGreaterThan(10);
      expect(i.detail.length).toBeGreaterThan(i.blurb.length);
      // The row has to stay one line at phone width.
      expect(i.blurb.length).toBeLessThan(96);
    }
  });

  it("loses nothing when grouped", () => {
    const flat = grouped().flatMap((g) => g.items);
    expect(flat.length).toBe(SHELL_ITEMS.length);
    expect(new Set(flat.map((i) => i.id)).size).toBe(SHELL_ITEMS.length);
  });

  it("labels every category it actually uses", () => {
    for (const g of grouped()) expect(CATEGORY_LABEL[g.category]).toBeTruthy();
  });

  it("puts something playable first", () => {
    // The player is holding their arm in the air. The first row must not be a
    // locked one.
    expect(isPlayable(grouped()[0].items[0])).toBe(true);
  });

  it("treats locked as the only unplayable state", () => {
    expect(isPlayable({ ...SHELL_ITEMS[0], availability: "preview" })).toBe(true);
    expect(isPlayable({ ...SHELL_ITEMS[0], availability: "locked" })).toBe(false);
  });
});
