import { describe, expect, it } from "vitest";
import { cleanName, fetchTop, fightScore, submitScore } from "./leaderboard";

const HUB = "https://api.example.com/hubs/matchmaking";

describe("fightScore", () => {
  it("rewards a KO win most", () => {
    expect(fightScore({ kind: "win", reason: "ko" }, 5)).toBe(200);
    expect(fightScore({ kind: "win", reason: "tko" }, 5)).toBe(180);
    expect(fightScore({ kind: "win", reason: "decision" }, 5)).toBe(150);
  });

  it("still scores landed punches on a loss or draw", () => {
    expect(fightScore({ kind: "loss", reason: "ko" }, 3)).toBe(30);
    expect(fightScore({ kind: "draw", reason: "decision" }, 3)).toBe(60);
  });

  it("never goes negative or past the server's cap", () => {
    expect(fightScore({ kind: "loss", reason: "decision" }, -4)).toBe(0);
    expect(fightScore({ kind: "win", reason: "ko" }, 1e9)).toBe(100_000);
  });
});

describe("cleanName", () => {
  it("trims and accepts a normal name", () => {
    expect(cleanName("  Kai ")).toBe("Kai");
  });

  it("rejects empty, too long and control characters", () => {
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("x".repeat(21))).toBeNull();
    expect(cleanName("a\nb")).toBeNull();
  });
});

describe("leaderboard requests", () => {
  it("fetches the top list from the server root", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify([{ name: "a", score: 9, at: "2026-11-13T00:00:00Z" }, { bad: true }]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const rows = await fetchTop(HUB, 5, f);

    expect(url).toBe("https://api.example.com/leaderboard?top=5");
    expect(rows).toEqual([{ name: "a", score: 9, at: "2026-11-13T00:00:00Z" }]);
  });

  it("posts name and score as JSON", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    await submitScore(HUB, "Kai", 120, f);

    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ name: "Kai", score: 120 });
  });

  it("explains a rate limit", async () => {
    const f = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    await expect(submitScore(HUB, "Kai", 1, f)).rejects.toThrow(/Too many/);
  });

  it("throws when the list is unavailable", async () => {
    const f = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchTop(HUB, 10, f)).rejects.toThrow(/unavailable/);
  });
});
