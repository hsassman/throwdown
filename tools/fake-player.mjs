// Records a fake player: the game's own boxer, front-on, throwing a jab-cross
// on a loop, encoded as a video Chrome can play as its camera.

import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BASE = process.env.DEV_URL ?? "http://localhost:5174";
const args = process.argv.slice(2);
const shotsArg = args.indexOf("--shots");
const shots = shotsArg >= 0 ? args[shotsArg + 1].split(",").map(Number) : null;
const query = process.env.FAKE_QUERY ?? "";
const NAME = process.env.FAKE_NAME ?? "fake-player";
const [seconds = 4, fps = 30] = args
  .filter((a, i) => !a.startsWith("--") && (shotsArg < 0 || i !== shotsArg + 1))
  .map(Number);

const OUT = "tools/out";
const FRAMES = `${OUT}/fake-player-frames`;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`${BASE}/tools/fake-player/index.html?${query}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__fakePlayer?.ready, null, { timeout: 60_000 });

const capture = async (i, path) => {
  await page.evaluate(([f, r]) => window.__fakePlayer.setFrame(f, r), [i, fps]);
  await page.locator("canvas").screenshot({ path });
};

if (shots) {
  for (const i of shots) await capture(i, `${OUT}/fake-player-${i}.png`);
  console.log(`wrote ${shots.map((i) => `${OUT}/fake-player-${i}.png`).join(", ")}`);
} else {
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    await capture(i, `${FRAMES}/${String(i).padStart(5, "0")}.png`);
  }
  // y4m is what Chrome's file-backed fake camera reads most reliably.
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-framerate", String(fps),
    "-i", `${FRAMES}/%05d.png`,
    "-pix_fmt", "yuv420p",
    `${OUT}/${NAME}.y4m`,
  ]);
  rmSync(FRAMES, { recursive: true, force: true });
  console.log(`wrote ${OUT}/${NAME}.y4m (${n} frames @ ${fps} fps)`);
}
await browser.close();
