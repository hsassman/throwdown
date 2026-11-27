// Records a fake player: the game's own boxer, front-on, throwing a jab-cross
// on a loop, encoded as a video Chrome can play as its camera.
//
// Why: Chrome's built-in fake camera is a test pattern with no body in it, so
// every headless run has timed MediaPipe's whole-image detector rather than
// the tracking path real play uses (see the warning in perf-sweep.mjs). With
// this, `--use-file-for-fake-video-capture` puts a body in frame and the pose
// pipeline can be measured without a person standing at a webcam.
//
// It is a rendered figure, not a person: good enough to engage tracking and
// time it, not evidence about real-world accuracy.
//
// Usage (needs the dev server: npm run dev):
//   node tools/fake-player.mjs [seconds=4] [fps=30]
//   node tools/fake-player.mjs --shots 0,21   # preview frames as PNGs only
// Output: tools/out/fake-player.y4m (git-ignored), and PNGs for --shots.
//   FAKE_QUERY=guard=high  gloves at the chin instead of the chest
//   FAKE_NAME=fake-high    writes tools/out/fake-high.y4m instead
//   FAKE_QUERY="guard=high&move=1" FAKE_NAME=fake-move  ... 8 30
//                          guard up, no punches, stepping in and out, slipping
//                          and ducking on an 8 s loop (MOVE_SCRIPT in render.ts)

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
