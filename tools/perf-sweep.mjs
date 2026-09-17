// Sweeps the capture/inference settings that plausibly affect pose frame rate
// and reports a ranked table, so the best configuration for THIS machine is
// measured rather than guessed.
//
// STAND IN FRAME OF THE WEBCAM FOR THE WHOLE RUN. With no body present
// BlazePose runs its whole-image detector every frame instead of the cheaper
// tracking path, which times a different code path entirely. Each condition
// reports its body-found ratio; treat any row below ~0.8 as not comparable.
//
// Conditions are interleaved rather than run in blocks, because inference cost
// on this laptop drifts with background load (36ms to 51ms observed for the
// same code path) and a block layout would attribute that drift to whichever
// setting happened to run during it.
//
// Usage:
//   npm run build && npx vite preview --port 4173
//   node tools/perf-sweep.mjs [secondsPerCondition]

import { chromium } from "playwright-core";

const BASE = process.env.MEASURE_BASE ?? "http://localhost:4173/";
const SECONDS = Number(process.argv[2] ?? 20);
const REPEATS = Number(process.env.REPEATS ?? 2);

/**
 * The levers worth testing, and why each is here:
 *  - camFps: capture frame granularity. The dominant term in the measured
 *    15 FPS — see CAMERA_CONFIG.frameRate for the quantization arithmetic.
 *  - camW/camH: does NOT change inference cost (the model rescales to
 *    256x256), but lower resolutions are often what unlock a camera's 60 FPS
 *    modes at all.
 *  - delegate: GPU vs CPU was never measured head to head on this hardware.
 */
const CONDITIONS = [
  { name: "30fps 640x480 gpu", q: "camFps=30&camW=640&camH=480&delegate=gpu" },
  { name: "60fps 640x480 gpu", q: "camFps=60&camW=640&camH=480&delegate=gpu" },
  { name: "60fps 320x240 gpu", q: "camFps=60&camW=320&camH=240&delegate=gpu" },
  { name: "60fps 640x480 cpu", q: "camFps=60&camW=640&camH=480&delegate=cpu" },
  { name: "60fps 320x240 cpu", q: "camFps=60&camW=320&camH=240&delegate=cpu" },

  // --- Phase 3: the pipeline changes, each isolated ---------------------
  //
  // Ordered so each row differs from the baseline in exactly ONE way. The
  // whole point of this file is that the project does not get to claim a gain
  // it has not measured, and a sweep where two things change at once cannot
  // attribute the difference to either.
  //
  // `pipeline=0` restores the old "re-arm the video callback AFTER inference"
  // ordering. That ordering is what pinned the pose rate to the camera's frame
  // grid, and the prediction is that turning it off drops the rate back to
  // roughly one whole camera frame per inference. If it does not, the
  // quantisation model in the risk log is wrong and should be corrected.
  {
    name: "baseline: no pipelining (old behaviour)",
    q: "camFps=60&camW=640&camH=480&delegate=gpu&pipeline=0&roi=0&constraints=0&predict=0",
  },
  {
    name: "pipelining only",
    q: "camFps=60&camW=640&camH=480&delegate=gpu&roi=0&constraints=0&predict=0",
  },
  {
    name: "pipelining + roi crop",
    q: "camFps=60&camW=640&camH=480&delegate=gpu&constraints=0&predict=0",
  },
  {
    name: "roi crop only (no pipelining)",
    q: "camFps=60&camW=640&camH=480&delegate=gpu&pipeline=0&constraints=0&predict=0",
  },
  {
    name: "everything on",
    q: "camFps=60&camW=640&camH=480&delegate=gpu",
  },
  {
    name: "everything on, cpu delegate",
    q: "camFps=60&camW=640&camH=480&delegate=cpu",
  },
];

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

async function runCondition(cond) {
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.goto(`${BASE}?${cond.q}`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.getByRole("button", { name: /enable camera/i }).click();
  await page.waitForFunction(
    () => window.__shadowboxPerf?.().poseStatus === "ready",
    { timeout: 120_000 }
  );

  // Keep rAF alive and the window frontmost; a throttled tab invalidates the
  // whole measurement.
  await page.evaluate(() => {
    const tick = () => requestAnimationFrame(tick);
    requestAnimationFrame(tick);
  });

  // Warm up (WASM init, shader compilation) before resetting the counters.
  await page.waitForTimeout(6000);
  await page.evaluate(() => document.querySelector(".hud-row button")?.click());

  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await page.bringToFront();
    await page.waitForTimeout(2000);
  }

  const perf = await page.evaluate(() => window.__shadowboxPerf());
  await context.close();
  return perf;
}

const results = new Map(CONDITIONS.map((c) => [c.name, []]));

for (let r = 0; r < REPEATS; r++) {
  for (const cond of CONDITIONS) {
    process.stdout.write(`pass ${r + 1}: ${cond.name} ... `);
    try {
      const perf = await runCondition(cond);
      results.get(cond.name).push(perf);
      const fps = perf.frameInterval ? 1000 / perf.frameInterval.median : 0;
      // Report the pipeline quality numbers alongside the rate, so a run
      // records whether ROI and the constraint solver were actually ENGAGED
      // rather than merely requested by a flag. A sweep row claiming a gain
      // from a feature that silently failed to activate is worse than no data.
      const zoom = perf.pipeline?.roi?.active
        ? `roi ${perf.pipeline.roi.magnification.toFixed(2)}x`
        : "roi off";
      const limb = perf.pipeline?.skeleton?.attempted
        ? `limb ${(perf.pipeline.skeleton.meanError * 1000).toFixed(1)}->${(
            perf.pipeline.skeleton.meanErrorAfter * 1000
          ).toFixed(1)}mpx`
        : "constraints off";
      const lag = perf.pipeline?.predictor?.latencyMs
        ? `lag ${perf.pipeline.predictor.latencyMs.toFixed(0)}ms`
        : "";
      console.log(
        `${fps.toFixed(1)} FPS (inference ${perf.inference?.median?.toFixed(1) ?? "?"}ms, ` +
          `body ${(perf.poseFoundRatio * 100).toFixed(0)}%, ${zoom}, ${limb}${
            lag ? ", " + lag : ""
          })`
      );
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }
}

console.log("\n=== SUMMARY (median of passes) ===");
const rows = [];
for (const [name, runs] of results) {
  if (runs.length === 0) continue;
  const fps = median(runs.map((p) => 1000 / p.frameInterval.median));
  const inf = median(runs.map((p) => p.inference.median));
  const found = median(runs.map((p) => p.poseFoundRatio));
  const cam = runs[0].camera;
  rows.push({ name, fps, inf, found, cam });
}
rows.sort((a, b) => b.fps - a.fps);

console.log(
  "condition".padEnd(22) +
    "pose FPS".padStart(10) +
    "inference".padStart(12) +
    "body".padStart(7) +
    "  granted camera"
);
for (const r of rows) {
  console.log(
    r.name.padEnd(22) +
      r.fps.toFixed(1).padStart(10) +
      `${r.inf.toFixed(1)}ms`.padStart(12) +
      `${(r.found * 100).toFixed(0)}%`.padStart(7) +
      `  ${r.cam?.width}x${r.cam?.height}@${Math.round(r.cam?.frameRate ?? 0)}`
  );
}

const low = rows.filter((r) => r.found < 0.8);
if (low.length > 0) {
  console.log(
    `\nWARNING: ${low.map((r) => r.name).join(", ")} saw a body in under 80% of ` +
      `frames. Those rows timed BlazePose's detection path, not its tracking ` +
      `path, and are not comparable. Re-run standing in frame.`
  );
}
if (rows.length > 0) {
  console.log(
    `\nCeiling check: the best achievable rate is 1/inference. At ` +
      `${rows[0].inf.toFixed(1)}ms that is ${(1000 / rows[0].inf).toFixed(1)} FPS, ` +
      `regardless of capture settings.`
  );
}

await browser.close();

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
