import { describe, expect, it } from "vitest";
import { fetchIceServers, serverBaseUrl } from "./iceServers";

const FALLBACK: RTCIceServer[] = [{ urls: "stun:fallback.example:3478" }];
const HUB = "https://api.example.com/hubs/matchmaking";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("serverBaseUrl", () => {
  it("strips the hub path", () => {
    expect(serverBaseUrl(HUB)).toBe("https://api.example.com");
    expect(serverBaseUrl("http://localhost:5160/hubs/matchmaking/")).toBe("http://localhost:5160");
  });
});

describe("fetchIceServers", () => {
  it("uses the server's list and requests the right URL", async () => {
    let requested = "";
    const f = (async (url: string) => {
      requested = url;
      return new Response(
        JSON.stringify([
          { urls: ["stun:s.example:3478"], username: null, credential: null },
          { urls: ["turn:t.example:3478"], username: "u", credential: "p" },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const servers = await fetchIceServers(HUB, FALLBACK, f);

    expect(requested).toBe("https://api.example.com/ice-servers");
    expect(servers).toEqual([
      { urls: ["stun:s.example:3478"] },
      { urls: ["turn:t.example:3478"], username: "u", credential: "p" },
    ]);
  });

  it("falls back on an HTTP error", async () => {
    expect(await fetchIceServers(HUB, FALLBACK, fakeFetch(404, {}))).toBe(FALLBACK);
  });

  it("falls back on an empty list", async () => {
    expect(await fetchIceServers(HUB, FALLBACK, fakeFetch(200, []))).toBe(FALLBACK);
  });

  it("falls back on a malformed body", async () => {
    expect(await fetchIceServers(HUB, FALLBACK, fakeFetch(200, { nope: 1 }))).toBe(FALLBACK);
  });

  it("drops entries that are not ICE servers", async () => {
    const servers = await fetchIceServers(
      HUB,
      FALLBACK,
      fakeFetch(200, [{ urls: "http://not-ice" }, { urls: "stun:ok.example" }, 7]),
    );
    expect(servers).toEqual([{ urls: "stun:ok.example" }]);
  });

  it("falls back when the network fails", async () => {
    const f = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect(await fetchIceServers(HUB, FALLBACK, f)).toBe(FALLBACK);
  });
});
