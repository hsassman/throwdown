import { describe, expect, it } from "vitest";
import { LIVE_SITE, liveSiteServer } from "./tuning";

describe("liveSiteServer", () => {
  it("points the live site at the deployed .NET server", () => {
    expect(liveSiteServer("throwdown-orcin.vercel.app")).toBe(
      "https://throwdown-myc3.onrender.com/hubs/matchmaking"
    );
  });

  it("gives any other host no server, rather than one that would refuse it", () => {
    for (const h of ["localhost", "throwdown-git-main-x.vercel.app", "example.com", ""]) {
      expect(liveSiteServer(h)).toBeNull();
    }
  });

  it("is an https hub URL the leaderboard can derive its base from", () => {
    expect(LIVE_SITE.matchmakingUrl).toMatch(/^https:\/\/.+\/hubs\/matchmaking$/);
  });
});
