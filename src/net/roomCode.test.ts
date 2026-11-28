import { describe, expect, it } from "vitest";
import { cleanCode, isRoomCode, joinCodeFrom, joinUrl } from "./roomCode";

describe("room codes", () => {
  it("accept four characters from the server's alphabet", () => {
    expect(isRoomCode("K7P2")).toBe(true);
    expect(isRoomCode("K7P")).toBe(false);
    // I, O, 0 and 1 are never issued.
    for (const bad of ["KIP2", "KOP2", "K0P2", "K1P2"]) expect(isRoomCode(bad)).toBe(false);
  });

  it("clean what is typed: upper case, no spaces, four at most", () => {
    expect(cleanCode(" k7-p2x ")).toBe("K7P2");
  });

  it("travel in a link and come back out of it", () => {
    const url = joinUrl("K7P2", "https://example.test", "/");
    expect(url).toBe("https://example.test/?join=K7P2");
    expect(joinCodeFrom(new URL(url).search)).toBe("K7P2");
    expect(joinCodeFrom("?join=k7p2")).toBe("K7P2");
    expect(joinCodeFrom("?join=nope")).toBeNull();
    expect(joinCodeFrom("")).toBeNull();
  });
});
