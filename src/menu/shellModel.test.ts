import { describe, it, expect } from "vitest";
import { CATEGORY_LABEL, ITEM_BY_ID, SHELL_ITEMS, STAGES, grouped, isPlayable } from "./shellModel";

describe("availability", () => {
  it("gives every locked entry a reason, and nothing else one", () => {
    for (const item of [...SHELL_ITEMS, ...STAGES]) {
      if (item.availability === "locked") expect(item.lockedReason?.length ?? 0).toBeGreaterThan(10);
      else expect(item.lockedReason).toBeUndefined();
    }
  });

  it("does not oversell online play", () => {
    expect(ITEM_BY_ID.get("internet")!.detail).toMatch(/some networks may prevent/i);
    expect(ITEM_BY_ID.get("lan")!.detail).toMatch(/guest may see a slight delay/i);
  });

  it("has no dead or folded-in modes", () => {
    for (const id of ["fps", "freeplay", "local", "phonecam", "punchlab"]) expect(ITEM_BY_ID.has(id)).toBe(false);
  });
});

describe("shape", () => {
  it("has unique ids across modes and stages", () => {
    expect(ITEM_BY_ID.size).toBe(SHELL_ITEMS.length);
    expect(new Set(STAGES.map((s) => s.id)).size).toBe(STAGES.length);
  });

  it("gives every entry a one-line blurb and a longer detail", () => {
    for (const i of SHELL_ITEMS) {
      expect(i.blurb.length).toBeGreaterThan(10);
      expect(i.blurb.length).toBeLessThan(96);
      expect(i.detail.length).toBeGreaterThan(i.blurb.length);
    }
  });

  it("loses nothing when grouped, and labels every group", () => {
    const flat = grouped().flatMap((g) => g.items);
    expect(new Set(flat.map((i) => i.id)).size).toBe(SHELL_ITEMS.length);
    for (const g of grouped()) expect(CATEGORY_LABEL[g.category]).toBeTruthy();
  });

  it("puts the fight first", () => {
    expect(grouped()[0].items[0].id).toBe("cpu");
    expect(isPlayable(grouped()[0].items[0])).toBe(true);
  });

  it("treats locked as the only unplayable state", () => {
    expect(isPlayable({ ...SHELL_ITEMS[0], availability: "preview" })).toBe(true);
    expect(isPlayable({ ...SHELL_ITEMS[0], availability: "locked" })).toBe(false);
  });
});
