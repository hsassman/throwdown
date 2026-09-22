// Automated Milestone 0 measurement run.
//
// Drives the real installed Chrome against the dev server using the real
// webcam, auto-accepting the camera permission so a run can be scripted.
//
// How to read the output - two things decide whether a run is valid:
//
//  1. "body found in X% of frames". BlazePose runs an expensive whole-image
//     detector while no body is acquired, and a cheaper tracking path once one
//     is. A run at a low ratio is timing the wrong code path - for a
//     representative gameplay number you want this near 100%, i.e. someone
//     actually standing in frame.
//
//  2. Frame intervals clustered near ~1000ms mean Chrome throttled
//     requestAnimationFrame because the window was backgrounded/occluded. The
//     launch flags below disable that, but if it reappears the run is void.
//
// Even a clean run here measures a person *standing still*. Sustained throwing
// of punches is a different (higher) load, so treat this as a baseline rather
// than the final Milestone 1 figure.
//
// Usage: node tools/measure-pose.mjs [durationSeconds]

import { chromium } from "playwright-core";

const URL = process.env.MEASURE_URL ?? "http://localhost:5174/";
const DURATION_S = Number(process.argv[2] ?? 25);

const browser = await chromium.launch({
  channel: "chrome",
  headless: false, // GPU delegate needs a real compositor; headless skews this.
  args: [
    "--use-fake-ui-for-media-stream", // auto-accept the camera permission
    "--autoplay-policy=no-user-gesture-required",
    // Chrome throttles requestAnimationFrame to ~1 Hz in a backgrounded or
    // occluded window. Without these, an unattended measurement run reports
    // ~1 FPS that reflects the throttle, not the pose pipeline.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // On Windows specifically, Chrome computes native window occlusion and
    // throttles windows it believes are covered - which is what kept pinning
    // unattended runs to exactly 1 Hz even with the flags above set.
    "--disable-features=CalculateNativeWinOcclusion",
  ],
});

const context = await browser.newContext({ permissions: ["camera"] });
const page = await context.newPage();

page.on("console", (msg) => {
  const t = msg.text();
  if (/error|warn|fail|delegate/i.test(t)) console.log(`  [browser] ${t}`);
});
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

console.log(`Opening ${URL} ...`);
await page.goto(URL, { waitUntil: "domcontentloaded" });
// An unfocused/backgrounded window gets its requestAnimationFrame throttled to
// ~1 Hz by Chrome, which shows up as multi-hundred-ms stalls that have nothing
// to do with inference cost. Keep the window foregrounded for the whole run.
await page.bringToFront();

await page.getByRole("button", { name: /enable camera/i }).click();

// Wait for the landmarker to finish loading (model + WASM come off disk).
await page.waitForFunction(
  () => {
    const f = window.__shadowboxPerf;
    return typeof f === "function" && f().poseStatus === "ready";
  },
  { timeout: 90_000 }
);
console.log("Pose landmarker ready. Warming up ...");

// Discard the first few seconds: WASM/GPU warm-up and shader compilation make
// early frames unrepresentative of steady state.
await page.waitForTimeout(6000);
await page.evaluate(() => {
  document.querySelector(".hud-row button")?.click();
});

// Keep a requestAnimationFrame loop alive for the duration of the run.
// requestVideoFrameCallback only fires when frames are actually being sent to
// the compositor; on an idle, unattended page Chrome can stop compositing and
// rVFC collapses to ~1 Hz, which is a measurement artifact rather than a real
// pipeline limit. A live rAF loop keeps the page compositing - and matches
// real gameplay, where the render loop is always running anyway.
await page.evaluate(() => {
  const tick = () => {
    (window.__keepaliveFrames ??= 0);
    window.__keepaliveFrames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Chrome throttles a window it considers occluded, and no combination of
// launch flags reliably prevented that on this machine. Repeatedly raising the
// window is the only thing that did. This briefly steals focus - that's the
// cost of getting a real number rather than a throttled fiction.
console.log(`Measuring for ${DURATION_S}s (window will hold focus) ...`);
const raiseUntil = Date.now() + DURATION_S * 1000;
while (Date.now() < raiseUntil) {
  await page.bringToFront();
  await page.waitForTimeout(2000);
}

const perf = await page.evaluate(() => ({
  ...window.__shadowboxPerf(),
  visibility: document.visibilityState,
  focused: document.hasFocus(),
  keepaliveFrames: window.__keepaliveFrames ?? 0,
}));

console.log(
  `keepalive rAF ticks : ${perf.keepaliveFrames} (~${(
    perf.keepaliveFrames / DURATION_S
  ).toFixed(0)} Hz)`
);

console.log(
  `page visibility=${perf.visibility} focused=${perf.focused}` +
    (perf.visibility !== "visible" || !perf.focused
      ? "   <-- WARNING: rAF may have been throttled; numbers unreliable"
      : "")
);

const hz = (ms) => (ms > 0 ? 1000 / ms : 0);
const fi = perf.frameInterval;

console.log("\n==================== MEASURED (live webcam) ====================");
console.log(`delegate            : ${perf.delegate}`);
console.log(`inference runs on   : ${perf.mode}`);
console.log(
  `camera granted      : ${perf.camera?.width}x${perf.camera?.height} @ ${perf.camera?.frameRate}fps`
);
console.log(`cpu threads         : ${perf.hardwareConcurrency}`);
console.log(`samples             : ${fi.count}`);
console.log(
  `body found in       : ${(perf.poseFoundRatio * 100).toFixed(0)}% of frames` +
    (perf.poseFoundRatio < 0.5 ? "   <-- DETECTION path, not gameplay path" : "")
);
console.log("--- pose sample rate (from frame intervals) ---");
console.log(`median              : ${hz(fi.median).toFixed(1)} FPS`);
console.log(`mean                : ${hz(fi.mean).toFixed(1)} FPS`);
console.log(
  `worst 5% (p95 gap)  : ${hz(fi.p95).toFixed(1)} FPS   <- the figure that decides dropped punches`
);
console.log(`best                : ${hz(fi.min).toFixed(1)} FPS`);
console.log("--- raw frame interval (ms) ---");
console.log(
  `med ${fi.median.toFixed(1)}  mean ${fi.mean.toFixed(1)}  p5 ${fi.p5.toFixed(
    1
  )}  p95 ${fi.p95.toFixed(1)}  min ${fi.min.toFixed(1)}  max ${fi.max.toFixed(1)}`
);
console.log("--- inference cost (ms per detectForVideo) ---");
const inf = perf.inference;
console.log(
  `med ${inf.median.toFixed(1)}  mean ${inf.mean.toFixed(
    1
  )}  p95 ${inf.p95.toFixed(1)}  max ${inf.max.toFixed(1)}`
);
console.log("===============================================================");

const throttled = fi.median > 500;
if (throttled) {
  console.log(
    "\n*** RUN VOID: frame intervals ~1s => rAF was throttled. Discard. ***"
  );
} else if (perf.poseFoundRatio < 0.5) {
  console.log(
    "\n*** CAUTION: body rarely detected => this timed the detection path,\n" +
      "    not the gameplay tracking path. Re-run with someone in frame. ***"
  );
} else {
  console.log("\nRun looks valid: body tracked, no rAF throttling detected.");
}

console.log("\nJSON:\n" + JSON.stringify(perf, null, 2));

await browser.close();
