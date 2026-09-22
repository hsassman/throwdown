import { describe, it, expect } from "vitest";
import {
  CAREER_LADDER,
  freshCareerProfile,
  currentOpponent,
  isComplete,
  recordResult,
  reviveCareerProfile,
  CAREER_VERSION,
} from "./career";

describe("a fresh career", () => {
  it("starts at the first rung with a clean record", () => {
    const p = freshCareerProfile();
    expect(p.rank).toBe(0);
    expect(p.record).toEqual({ wins: 0, losses: 0, draws: 0 });
    expect(currentOpponent(p)).toBe(CAREER_LADDER[0]);
    expect(isComplete(p)).toBe(false);
  });
});

describe("recording a result", () => {
  it("advances the rank on a win", () => {
    const p = freshCareerProfile();
    recordResult(p, "win", 100);
    expect(p.rank).toBe(1);
    expect(p.record.wins).toBe(1);
    expect(currentOpponent(p)).toBe(CAREER_LADDER[1]);
    expect(p.updatedAt).toBe(100);
  });

  it("does not advance on a loss — the same opponent is fought again", () => {
    const p = freshCareerProfile();
    recordResult(p, "loss");
    expect(p.rank).toBe(0);
    expect(p.record.losses).toBe(1);
    expect(currentOpponent(p)).toBe(CAREER_LADDER[0]);
  });

  it("does not advance on a draw", () => {
    const p = freshCareerProfile();
    recordResult(p, "draw");
    expect(p.rank).toBe(0);
    expect(p.record.draws).toBe(1);
  });

  it("completes once the last rung is won, rather than wrapping or overshooting", () => {
    const p = freshCareerProfile();
    for (let i = 0; i < CAREER_LADDER.length; i++) recordResult(p, "win");
    expect(isComplete(p)).toBe(true);
    expect(currentOpponent(p)).toBeNull();
    expect(p.rank).toBe(CAREER_LADDER.length);

    // One more win must not push the rank past the ladder's length.
    recordResult(p, "win");
    expect(p.rank).toBe(CAREER_LADDER.length);
    expect(p.record.wins).toBe(CAREER_LADDER.length + 1);
  });
});

describe("reviving a saved profile", () => {
  it("round-trips a real profile through JSON", () => {
    const p = freshCareerProfile(1);
    recordResult(p, "win", 2);
    recordResult(p, "loss", 3);
    const revived = reviveCareerProfile(JSON.parse(JSON.stringify(p)));
    expect(revived.rank).toBe(p.rank);
    expect(revived.record).toEqual(p.record);
  });

  it("starts fresh from garbage input rather than throwing", () => {
    for (const bad of [null, undefined, "a string", 42, [], {}]) {
      expect(() => reviveCareerProfile(bad)).not.toThrow();
    }
  });

  it("starts fresh on a version mismatch", () => {
    const stale = { version: CAREER_VERSION - 1, rank: 3, record: { wins: 9, losses: 0, draws: 0 } };
    expect(reviveCareerProfile(stale).rank).toBe(0);
  });

  it("clamps a rank outside the ladder's bounds rather than trusting it", () => {
    const tooHigh = { version: CAREER_VERSION, rank: 999, record: { wins: 0, losses: 0, draws: 0 } };
    expect(reviveCareerProfile(tooHigh).rank).toBe(CAREER_LADDER.length);

    const negative = { version: CAREER_VERSION, rank: -5, record: { wins: 0, losses: 0, draws: 0 } };
    expect(reviveCareerProfile(negative).rank).toBe(0);
  });
});

describe("the ladder itself", () => {
  it("has unique ids and ends rather than looping", () => {
    expect(new Set(CAREER_LADDER.map((o) => o.id)).size).toBe(CAREER_LADDER.length);
    expect(CAREER_LADDER.length).toBeGreaterThan(0);
  });

  it("gets harder, or at least never easier, moving up the ladder", () => {
    const rank: Record<string, number> = { rookie: 0, contender: 1, champion: 2 };
    for (let i = 1; i < CAREER_LADDER.length; i++) {
      expect(rank[CAREER_LADDER[i].difficulty]).toBeGreaterThanOrEqual(
        rank[CAREER_LADDER[i - 1].difficulty]
      );
    }
  });
});
