// A/B timing of the pose pipeline during a real CPU fight, with the fake
// player (tools/fake-player.mjs) as the camera.

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const VIDEO = resolve("tools/out/fake-player.y4m");
const [secArg, repArg, ...queries] = process.argv.slice(2);
const SECONDS = Number(secArg ?? 15);
const REPEATS = Number(repArg ?? 2);
const CONDITIONS = queries.length ? queries : ["worker=0", "worker=1"];

if (!existsSync(VIDEO)) {
  console.error(`No ${VIDEO}. Run: node tools/fake-player.mjs 2.4`);
  process.exit(1);
}

const browser = await chromium.launch({
  channel: "chrome",
  // Headless by default: a headed window that is not in front gets throttled
  // to ~1 Hz by Windows occlusion tracking, which voided the first runs.
  // HEADED=1 for a visible window. The GPU is forced on either way, and the
  // delegate actually used is reported per row.
  headless: !process.env.HEADED,
  args: [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-angle=d3d11",
    "--enable-unsafe-webgpu",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${VIDEO}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Without this Windows reports the window occluded the moment it loses
    // focus, and Chrome drops it to ~1 Hz - which voided the first runs.
    "--disable-features=CalculateNativeWinOcclusion",
  ],
});

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};

async function measure(query) {
  const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?firstrun=0&mode=cpu&${query}`, { waitUntil: "networkidle" });
  await page.locator(".gate-btn").click();
  // A tracked pose, not just a loaded model: the fake player has to be found.
  await page.waitForFunction(() => !!window.__shadowboxPose?.(), null, { timeout: 90_000 });
  // The fight hides the diagnostics, and the perf hook lives in them.
  await page.keyboard.press("Backquote");
  await page.waitForFunction(() => typeof window.__shadowboxPerf === "function", null, { timeout: 15_000 });
  await page.waitForTimeout(5000); // model warm-up, scene build, first crop

  await page.bringToFront();
  const result = await page.evaluate(async (seconds) => {
    const perf = window.__shadowboxPerf;
    const longTasks = [];
    const obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)));
    try {
      obs.observe({ entryTypes: ["longtask"] });
    } catch {}
    // Pose samples counted by watching the published pose change, so this
    // measures what the game receives rather than trusting the pipeline's own
    // statistics.
    let renderFrames = 0;
    let poseSamples = 0;
    let found = 0;
    let lastPose = null;
    const frameGaps = [];
    let last = performance.now();
    const end = last + seconds * 1000;
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now();
        frameGaps.push(now - last);
        last = now;
        renderFrames++;
        const p = window.__shadowboxPose?.();
        if (p && p !== lastPose) {
          poseSamples++;
          found++;
          lastPose = p;
        }
        if (now < end) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    obs.disconnect();
    const stats = perf();
    const interval = stats.frameInterval?.median;
    return {
      // From the pipeline's own completed-inference intervals. Counting pose
      // changes per rendered frame (poseSamples) caps the reading at the render
      // rate, which is exactly the wrong thing when inference starves rendering.
      pipelinePoseFps: interval > 0 ? 1000 / interval : 0,
      renderFps: renderFrames / seconds,
      frameGaps,
      poseFps: poseSamples / seconds,
      foundRatio: stats.poseFoundRatio,
      inferenceMed: stats.inference?.median ?? stats.inference?.p50 ?? null,
      mode: stats.mode,
      delegate: stats.delegate,
      roi: stats.pipeline?.roi?.active ?? null,
      longTaskMs: longTasks.reduce((a, b) => a + b, 0) / seconds,
      longTasks: longTasks.length / seconds,
    };
  }, SECONDS);
  await context.close();
  return { query, ...result, errors };
}

const rows = Object.fromEntries(CONDITIONS.map((q) => [q, []]));
for (let r = 0; r < REPEATS; r++) {
  for (const q of CONDITIONS) {
    const m = await measure(q);
    rows[q].push(m);
    console.log(
      `[${r + 1}/${REPEATS}] ${q.padEnd(22)} pose ${m.pipelinePoseFps.toFixed(1)}/s (seen ${m.poseFps.toFixed(1)})  render ${m.renderFps.toFixed(1)} fps` +
        ` (p95 gap ${pct(m.frameGaps, 95).toFixed(1)}ms)  found ${(m.foundRatio * 100).toFixed(0)}%` +
        `  infer ${Number(m.inferenceMed).toFixed(1)}ms  longtask ${m.longTaskMs.toFixed(0)}ms/s  ${m.mode}/${m.delegate} roi=${m.roi}` +
        (m.errors.length ? `  ERRORS: ${m.errors.join(" | ")}` : "")
    );
  }
}

console.log("\nMean over repeats:");
for (const q of CONDITIONS) {
  const ms = rows[q];
  const avg = (k) => ms.reduce((a, m) => a + m[k], 0) / ms.length;
  console.log(
    `  ${q.padEnd(22)} pose ${avg("pipelinePoseFps").toFixed(1)}/s (seen ${avg("poseFps").toFixed(1)})  render ${avg("renderFps").toFixed(1)} fps` +
      `  found ${(avg("foundRatio") * 100).toFixed(0)}%  longtask ${avg("longTaskMs").toFixed(0)}ms/s`
  );
}
await browser.close();
