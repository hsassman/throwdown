// Back-to-back A/B of main-thread vs Web Worker inference.
//
// Runs both conditions in one sitting so they see the same machine load, the
// same lighting and the same person — comparing runs taken minutes apart gave
// misleading results, because inference cost on this laptop drifts with
// background load (36ms to 51ms observed for the same code path).
//
// STAND IN FRAME OF THE WEBCAM FOR THE WHOLE RUN. A condition where no body is
// detected times BlazePose's detection path instead of its tracking path and
// is not comparable to one where a body is present. The script reports the
// body-found ratio per condition and refuses to declare a winner if the two
// conditions didn't see comparable input.
//
// Usage:
//   npm run build && npx vite preview --port 4173
//   node tools/ab-worker.mjs [secondsPerCondition]
//
// Note it must run against a production build (`vite preview`), not the dev
// server: Vite's `worker.format` setting only applies to builds, so in dev the
// pose worker is always an ES module and MediaPipe cannot load its WASM there.

import { chromium } from "playwright-core";

const BASE = process.env.MEASURE_BASE ?? "http://localhost:4173/";
const SECONDS = Number(process.argv[2] ?? 30);
const REPEATS = Number(process.env.REPEATS ?? 2);

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
  ],
});

async function runCondition(useWorker) {
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.goto(`${BASE}?worker=${useWorker ? 1 : 0}`, {
    waitUntil: "domcontentloaded",
  });
  await page.bringToFront();
  await page.getByRole("button", { name: /enable camera/i }).click();
  await page.waitForFunction(
    () => window.__shadowboxPerf?.().poseStatus === "ready",
    { timeout: 120_000 }
  );

  await page.evaluate(() => {
    // Counts its own frames, matching measure-pose.mjs. Without this the
    // `keepalive` field reported below is always 0, silently discarding the
    // only evidence that Chrome throttled rAF for a condition — which would
    // invalidate that condition's frame-rate numbers without anyone noticing.
    window.__keepaliveFrames = 0;
    const tick = () => {
      window.__keepaliveFrames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // Warm up (WASM init, shader compilation), then reset the counters.
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector(".hud-row button")?.click());

  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await page.bringToFront();
    await page.waitForTimeout(2000);
  }

  const perf = await page.evaluate(() => ({
    ...window.__shadowboxPerf(),
    keepalive: window.__keepaliveFrames ?? 0,
  }));
  await context.close();
  return perf;
}

const hz = (ms) => (ms > 0 ? 1000 / ms : 0);
const results = [];

for (let r = 0; r < REPEATS; r++) {
  // Alternate order across repeats so any warm-up or thermal drift doesn't
  // systematically favour whichever condition happens to run first.
  const order = r % 2 === 0 ? [false, true] : [true, false];
  for (const useWorker of order) {
    const label = useWorker ? "worker" : "main-thread";
    console.log(`\n[repeat ${r + 1}/${REPEATS}] measuring ${label} for ${SECONDS}s ...`);
    const p = await runCondition(useWorker);
    const fi = p.frameInterval;
    const valid = fi.median < 500 && p.poseFoundRatio > 0.5;
    results.push({ label, p, valid });
    console.log(
      `  ${label}: ${hz(fi.median).toFixed(1)} FPS median, ` +
        `inference ${p.inference.median.toFixed(1)}ms, ` +
        `body ${(p.poseFoundRatio * 100).toFixed(0)}%` +
        (valid ? "" : "   <-- INVALID")
    );
  }
}

await browser.close();

console.log("\n======================= A/B SUMMARY =======================");
for (const { label, p, valid } of results) {
  const fi = p.frameInterval;
  console.log(
    `${valid ? " ok " : "VOID"} ${label.padEnd(12)} ` +
      `${hz(fi.median).toFixed(1).padStart(5)} FPS med  ` +
      `p95gap ${hz(fi.p95).toFixed(1).padStart(5)} FPS  ` +
      `infer ${p.inference.median.toFixed(1).padStart(6)}ms  ` +
      `body ${(p.poseFoundRatio * 100).toFixed(0)}%  n=${fi.count}`
  );
}

const ok = results.filter((r) => r.valid);
const med = (label) => {
  const xs = ok.filter((r) => r.label === label).map((r) => hz(r.p.frameInterval.median));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const mainFps = med("main-thread");
const workerFps = med("worker");

console.log("===========================================================");
if (mainFps === null || workerFps === null) {
  console.log(
    "No verdict: at least one condition had no valid run.\n" +
      "Re-run with someone standing in frame and the window left alone."
  );
} else {
  const delta = workerFps - mainFps;
  console.log(
    `main-thread ${mainFps.toFixed(1)} FPS vs worker ${workerFps.toFixed(1)} FPS ` +
      `=> worker is ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} FPS`
  );
  console.log(
    Math.abs(delta) < 1.5
      ? "Difference is within run-to-run noise on this machine — not a real win."
      : delta > 0
        ? "Worker helps."
        : "Worker HURTS. Keep inference on the main thread."
  );
}
