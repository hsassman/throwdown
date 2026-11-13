// Talks to the server's /leaderboard endpoints. Pure functions plus a thin
// fetch wrapper, so the score rule and the request shapes are testable
// without a browser or a server.
import type { FightResult } from "../sim/useFight";
import { serverBaseUrl } from "./iceServers";

export interface LeaderboardRow {
  name: string;
  score: number;
  at: string;
}

/** Same limits the server enforces (LeaderboardRules.cs). */
export const MAX_NAME_LENGTH = 20;
export const MAX_SCORE = 100_000;

/**
 * Points for one fight. Landed punches count for everyone, so a loss that
 * fought back still scores; the result and the way it ended add a bonus.
 */
export function fightScore(result: FightResult, landed: number): number {
  const outcome = result.kind === "win" ? 100 : result.kind === "draw" ? 30 : 0;
  const finish = result.kind === "win" ? (result.reason === "ko" ? 50 : result.reason === "tko" ? 30 : 0) : 0;
  const punches = Math.max(0, Math.floor(landed)) * 10;
  return Math.min(MAX_SCORE, outcome + finish + punches);
}

/** Trimmed name, or null if the server would reject it. */
export function cleanName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function isRow(x: unknown): x is LeaderboardRow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.score === "number" && typeof r.at === "string";
}

export async function fetchTop(
  matchmakingUrl: string,
  top = 10,
  fetchImpl: typeof fetch = fetch,
): Promise<LeaderboardRow[]> {
  const res = await fetchImpl(`${serverBaseUrl(matchmakingUrl)}/leaderboard?top=${top}`);
  if (!res.ok) throw new Error(`Leaderboard unavailable (${res.status})`);
  const body: unknown = await res.json();
  return Array.isArray(body) ? body.filter(isRow) : [];
}

export async function submitScore(
  matchmakingUrl: string,
  name: string,
  score: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${serverBaseUrl(matchmakingUrl)}/leaderboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, score }),
  });
  if (res.status === 429) throw new Error("Too many scores sent. Try again in a minute.");
  if (!res.ok) throw new Error(`Score not saved (${res.status})`);
}
