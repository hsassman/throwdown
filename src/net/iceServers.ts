// Fetches STUN/TURN servers from the matchmaking server's /ice-servers
// endpoint, so TURN credentials live in the server's configuration rather
// than in this bundle or the repo. Any failure (server down, old server
// without the endpoint, bad JSON, empty list) falls back to the built-in
// STUN list: a fight that only works on easy NATs beats one that never
// starts.

/** The server root, derived from the hub URL: ".../hubs/matchmaking" -> "...". */
export function serverBaseUrl(matchmakingUrl: string): string {
  return matchmakingUrl.replace(/\/hubs\/matchmaking\/?$/, "");
}

function isIceServer(x: unknown): x is RTCIceServer {
  if (typeof x !== "object" || x === null) return false;
  const urls = (x as { urls?: unknown }).urls;
  const ok = (u: unknown) => typeof u === "string" && /^(stun|stuns|turn|turns):/.test(u);
  if (Array.isArray(urls)) return urls.length > 0 && urls.every(ok);
  return ok(urls);
}

/** Drops null username/credential, which RTCPeerConnection rejects. */
function clean(s: RTCIceServer): RTCIceServer {
  const out: RTCIceServer = { urls: s.urls };
  if (typeof s.username === "string") out.username = s.username;
  if (typeof s.credential === "string") out.credential = s.credential;
  return out;
}

export async function fetchIceServers(
  matchmakingUrl: string,
  fallback: RTCIceServer[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${serverBaseUrl(matchmakingUrl)}/ice-servers`, {
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return fallback;
    const servers = body.filter(isIceServer).map(clean);
    return servers.length > 0 ? servers : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
