import { useEffect, useMemo, useState } from "react";
import { NET_CONFIG } from "../config/tuning";
import { fetchTop, type LeaderboardRow } from "../net/leaderboard";
import { playUrl, qrMatrix, qrPath } from "./stageModel";
import "./stage.css";

// The projector page for the talk: open the game with ?stage on the laptop
// driving the screen. A big QR code takes the audience to the game, and the
// leaderboard beside it refreshes on its own while people fight. No camera,
// no pose model - this page loads none of that.

const REFRESH_MS = 5000;

export function StagePage() {
  const link = useMemo(() => playUrl(window.location.href), []);
  const path = useMemo(() => {
    const m = qrMatrix(link);
    return { d: qrPath(m), size: m.length };
  }, [link]);

  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchTop(NET_CONFIG.matchmakingUrl, 10)
        .then((r) => {
          if (cancelled) return;
          setRows(r);
          setOffline(false);
        })
        .catch(() => !cancelled && setOffline(true));
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // The quiet zone (4 modules) is part of the QR spec; scanners need it.
  const q = 4;
  return (
    <main className="stagepage">
      <section className="stagepage-join">
        <h1>Shadow Box</h1>
        <p className="stagepage-sub">Scan to fight. Your phone's camera is the controller.</p>
        <svg
          className="stagepage-qr"
          viewBox={`${-q} ${-q} ${path.size + 2 * q} ${path.size + 2 * q}`}
          role="img"
          aria-label={`QR code for ${link}`}
          shapeRendering="crispEdges"
        >
          <rect x={-q} y={-q} width={path.size + 2 * q} height={path.size + 2 * q} fill="#fff" />
          <path d={path.d} fill="#000" />
        </svg>
        <p className="stagepage-url">{link.replace(/^https?:\/\//, "").replace(/\/$/, "")}</p>
      </section>

      <section className="stagepage-board" aria-label="Leaderboard">
        <h2>Top fighters</h2>
        {offline && <p className="stagepage-note">Leaderboard offline</p>}
        {!offline && rows.length === 0 && <p className="stagepage-note">No scores yet. Be the first.</p>}
        <ol>
          {rows.map((r, i) => (
            <li key={`${r.name}-${r.at}-${i}`}>
              <span className="stagepage-rank">{i + 1}</span>
              <span className="stagepage-name">{r.name}</span>
              <span className="stagepage-score">{r.score}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
