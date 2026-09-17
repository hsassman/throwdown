// Smoke-tests the menu shell and the dummy training screen.
//
// This exists because the unit tests prove the geometry and the state machines
// and prove nothing at all about whether the app RUNS. Every visual failure
// this project has had would have survived a green test suite — a mesh that
// renders as nothing, a screen that throws on mount, a lazy chunk that fails
// to resolve. Those are all caught here and nowhere else.
//
//   npm run preview           (in one terminal)
//
// `npm run smoke` BUILDS first. The preview server serves dist/, so without
// that step a run silently tests the previous build — three camera changes in
// a row appeared to do nothing before this was noticed.
//   node tools/smoke-shell.mjs
//
// A fake camera device is supplied, so MediaPipe gets a real video stream with
// no person in it. That is enough to prove the pipeline starts; it cannot
// prove the tracking is any good.

import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const OUT = "tools/out";

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader",
  ],
});
const context = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const step = (msg) => console.log(`  ${msg}`);
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

try {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });

  // --- Gate ---
  const gate = page.locator(".gate-btn");
  check("camera gate renders", (await gate.count()) === 1);
  await gate.click();

  // --- Menu shell ---
  await page.waitForSelector(".shell", { timeout: 15000 });
  const rows = page.locator(".shell-row");
  const rowCount = await rows.count();
  check("menu shell renders rows", rowCount >= 8, `${rowCount} rows`);

  const badges = await page.locator(".shell-badge").allTextContents();
  check(
    "menu states availability honestly",
    badges.includes("Ready") && badges.includes("Not built"),
    badges.join(", ")
  );

  const locked = page.locator('.shell-row[data-locked="true"]');
  check("locked rows are marked", (await locked.count()) > 0);

  // The focused row and the detail panel must never disagree. This is the
  // classic two-sources-of-truth bug (a hoverIndex for the mouse, a focusIndex
  // for the keyboard) and it is invisible until a player activates one thing
  // while reading about another.
  const sync = async () => {
    return page.evaluate(() => {
      const row = document.querySelector('.shell-row[data-focused="true"]');
      return {
        focused: row?.querySelector(".shell-row-title")?.textContent ?? null,
        detail: document.querySelector(".shell-detail-title")?.textContent ?? null,
        focusedCount: document.querySelectorAll('.shell-row[data-focused="true"]').length,
      };
    });
  };
  let s0 = await sync();
  check("exactly one row is focused", s0.focusedCount === 1, JSON.stringify(s0));
  check("focused row matches the detail panel", s0.focused === s0.detail, JSON.stringify(s0));

  // And it must stay true after moving with the keyboard.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  s0 = await sync();
  check("still in sync after keyboard movement", s0.focused === s0.detail, JSON.stringify(s0));

  await page.screenshot({ path: `${OUT}/shell-menu.png` });
  step(`saved ${OUT}/shell-menu.png`);

  // --- Locked row explains itself rather than doing nothing ---
  await locked.first().click();
  await page.waitForTimeout(250);
  const reject = await page.locator(".shell-detail-reject").count();
  check("pressing a locked row explains why", reject === 1);

  // --- The camera must survive navigation ---
  //
  // THE regression test for this file. The camera is attached to the <video>
  // element exactly once; if navigating remounts that element, the ref points
  // at a fresh one with no stream and the picture freezes while the camera
  // light stays on. There is no error anywhere — it just stops.
  //
  // Identity is tagged rather than inferred: a marker is written onto the
  // element now, and checked again after navigating. A different element means
  // React replaced it, which is the fault itself.
  const camState = async () => {
    return page.evaluate(() => {
      const v = document.querySelector("video");
      if (!v) return { present: false };
      const w = window;
      w.__camMark = w.__camMark || 0;
      const had = v.dataset.smokeMark ?? null;
      if (!had) {
        w.__camMark += 1;
        v.dataset.smokeMark = String(w.__camMark);
      }
      return {
        present: true,
        mark: v.dataset.smokeMark,
        fresh: !had,
        hasStream: !!v.srcObject,
        readyState: v.readyState,
        time: v.currentTime,
        paused: v.paused,
      };
    });
  };

  const advanced = async (from) => {
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(250);
      const c = await camState();
      if (c.time > from) return c;
    }
    return camState();
  };

  // Polled: getUserMedia is async, so the first sample can legitimately land
  // before the stream has arrived. That is a race in this script, not a fault.
  let camMenu = await camState();
  for (let i = 0; i < 40 && !camMenu.hasStream; i++) {
    await page.waitForTimeout(250);
    camMenu = await camState();
  }
  check("camera is attached in the menu", camMenu.hasStream === true, JSON.stringify(camMenu));
  const camMenuLive = await advanced(camMenu.time);
  check("camera is PLAYING in the menu", camMenuLive.time > camMenu.time, JSON.stringify(camMenuLive));

  // --- Dummy training ---
  const dummyRow = rows.filter({ hasText: "Dummy Work" }).first();
  await dummyRow.click();
  await page.waitForSelector(".thud", { timeout: 20000 });
  check("training HUD mounts", true);

  // The 3D view has to actually produce a canvas with pixels in it.
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForTimeout(4000);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    return { w: c.width, h: c.height };
  });
  check("3D canvas exists and has size", !!canvas && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));

  // A drill that never lights a target is the whole feature failing silently.
  //
  // POLLED, not sampled once. There is a deliberate rest gap between one
  // target clearing and the next lighting, during which nothing is lit and the
  // label reads "—". A single sample lands in that gap often enough to make
  // the check flaky — which it did, and the drill was fine.
  let litText = "—";
  const seen = [];
  for (let i = 0; i < 30 && litText === "—"; i++) {
    litText = ((await page.locator(".thud-target-label").textContent()) ?? "").trim();
    if (litText && litText !== "—") seen.push(litText);
    else await page.waitForTimeout(200);
  }
  check("a target lights", seen.length > 0, `saw "${seen[0] ?? ""}"`);

  // And the drill must keep MOVING. One target stuck on screen forever would
  // pass the check above and still be completely broken.
  const presentedAt = async () => {
    const line = (await page.locator(".thud-line").textContent()) ?? "";
    return Number(line.match(/\d+\/(\d+)/)?.[1] ?? 0);
  };
  //
  // POLLED with a generous budget rather than waiting one target-cycle. In
  // headless software GL, MediaPipe inference spikes to several seconds and
  // starves the animation frame the drill runs on, so a window sized for the
  // real frame rate is flaky here. It is the ADVANCE that matters, not how
  // quickly it happens.
  const before = await presentedAt();
  let after = before;
  for (let i = 0; i < 40 && after <= before; i++) {
    await page.waitForTimeout(500);
    after = await presentedAt();
  }
  check("the drill advances through targets", after > before, `${before} -> ${after}`);

  await page.screenshot({ path: `${OUT}/shell-dummy.png` });
  step(`saved ${OUT}/shell-dummy.png`);

  const camInMode = await camState();
  check(
    "the SAME video element survives navigation",
    camInMode.fresh === false && camInMode.mark === camMenu.mark,
    JSON.stringify(camInMode)
  );
  check("camera still attached inside a mode", camInMode.hasStream === true, JSON.stringify(camInMode));
  const camModeLive = await advanced(camInMode.time);
  check(
    "camera still PLAYING inside a mode",
    camModeLive.time > camInMode.time,
    JSON.stringify(camModeLive)
  );

  // --- Back out ---
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });
  check("back returns to the menu", true);

  const camBack = await camState();
  check(
    "still the same element after returning to the menu",
    camBack.fresh === false && camBack.mark === camMenu.mark,
    JSON.stringify(camBack)
  );
  const camBackLive = await advanced(camBack.time);
  check(
    "camera still PLAYING after returning",
    camBackLive.time > camBack.time,
    JSON.stringify(camBackLive)
  );

  // --- Tracking diagnostics ---
  //
  // This screen is badged "Ready" in the menu, so it has to actually show
  // something. It is also the only place the auto-tuner is auditable: it
  // changes how the game responds without being asked, so it must be able to
  // say what it changed.
  await rows.filter({ hasText: "Tracking" }).first().click();
  await page.waitForSelector(".tpanel", { timeout: 20000 });
  const tp = await page.evaluate(() => ({
    score: document.querySelector(".tpanel-score-value")?.textContent,
    metrics: document.querySelectorAll(".tpanel-metrics li").length,
    facts: document.querySelectorAll(".tpanel-facts dd").length,
  }));
  // Headless has a camera but no PERSON in it, so the honest state here is
  // "not measured yet" rather than a score. Both are valid; a panel showing
  // neither would mean the screen is dead.
  const waiting = tp.score === "—";
  check(
    "tracking panel reports a real state",
    waiting || (/^\d+$/.test(tp.score ?? "") && tp.metrics >= 4 && tp.facts === 4),
    JSON.stringify(tp)
  );
  if (waiting) {
    const note = (await page.locator(".tpanel-note").textContent()) ?? "";
    check(
      "and explains what it needs rather than blaming the camera",
      /step into frame/i.test(note),
      note.trim().slice(0, 80)
    );
  }
  await page.screenshot({ path: `${OUT}/shell-tracking.png` });
  step(`saved ${OUT}/shell-tracking.png`);
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Free work ---
  await rows.filter({ hasText: "Free Work" }).first().click();
  await page.waitForSelector(".thud", { timeout: 20000 });
  await page.waitForTimeout(1500);
  const freeLit = await page.locator(".thud-target-label").count();
  check("free work shows no scored target", freeLit === 0);

  // One visit to the dummy is ONE round. `stop` is reachable from several
  // places — the screen changing, the round ending, the mode being disabled —
  // and more than one fires on a single navigation. Without a guard each call
  // banked another round, and a single visit logged three.
  const profileText = (await page.locator(".thud-profile").textContent()) ?? "";
  const rounds = Number(profileText.match(/(\d+) rounds/)?.[1] ?? -1);
  check("one visit logs exactly one round", rounds === 1, `"${profileText.trim()}"`);
  await page.screenshot({ path: `${OUT}/shell-freework.png` });
  step(`saved ${OUT}/shell-freework.png`);
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Player vs CPU ---
  //
  // The opponent is the one part of the game that runs on its OWN clock with
  // nobody in front of the camera, so headless is a genuine test of it rather
  // than a stand-in: the AI circles, closes range and throws whether or not a
  // player is there. What cannot be checked here is the player landing a
  // punch, which needs a body in frame.
  await rows.filter({ hasText: "Fight the CPU" }).first().click();
  await page.waitForSelector(".fight-hud", { timeout: 20000 });

  const firstClock = await page.locator(".fh-clock").textContent();
  // Long enough for a contender to get through a tempo gap and a telegraph.
  await page.waitForTimeout(4000);
  const laterClock = await page.locator(".fh-clock").textContent();
  check(
    "the round clock is running",
    firstClock !== laterClock,
    `${firstClock} -> ${laterClock}`
  );

  // The opponent has to actually DO something. Polled rather than sampled: a
  // telegraph is a few hundred milliseconds inside a tempo of one to two
  // seconds, so a single read would miss it far more often than not — the
  // same flake that made the drill assertions unreliable.
  let sawWindup = false;
  for (let i = 0; i < 60 && !sawWindup; i++) {
    sawWindup = (await page.locator(".fh-windup").count()) > 0;
    if (!sawWindup) await page.waitForTimeout(100);
  }
  check("the opponent telegraphs a punch", sawWindup);

  // And the player takes damage from it, which is the end-to-end path: AI
  // decides -> sim applies -> HUD reports. A fight where the health bar never
  // moves is a fight the opponent is not really in.
  let hurt = false;
  for (let i = 0; i < 80 && !hurt; i++) {
    // Read off the ARIA meter rather than the inline style. It is the value
    // the screen reader is given, so checking it verifies the accessible
    // readout and the bar at once — and a bar that animated while the meter
    // stayed at 100 would be a real defect this would catch.
    const now = await page
      .locator('[aria-label="You health"]')
      .getAttribute("aria-valuenow");
    hurt = Number(now) < 100;
    if (!hurt) await page.waitForTimeout(150);
  }
  check("the player takes damage from the opponent", hurt);

  await page.screenshot({ path: `${OUT}/shell-fight.png` });
  step(`saved ${OUT}/shell-fight.png`);
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Stages ---
  await rows.filter({ hasText: "Stages" }).first().click();
  await page.waitForSelector(".arena-view canvas", { timeout: 20000 });
  check(
    "both venues are offered",
    (await page.locator(".stage-btn").count()) === 2
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/stage-octagon.png` });
  step(`saved ${OUT}/stage-octagon.png`);

  await page.locator(".stage-btn", { hasText: "The Ring" }).click();
  await page.waitForTimeout(1500);
  check(
    "switching venue rebuilds the scene",
    (await page.locator('.arena-view[aria-label*="Boxing ring"]').count()) === 1
  );
  await page.screenshot({ path: `${OUT}/stage-ring.png` });
  step(`saved ${OUT}/stage-ring.png`);
} catch (err) {
  console.log(`  FAIL  threw: ${err.message}`);
  failures += 1;
}

// WebGL warnings from the software rasteriser are expected in headless and are
// not a defect in the app.
const real = errors.filter(
  (e) => !/swiftshader|WebGL|GroupMarkerNotSet|Failed to load resource/i.test(e)
);
check("no runtime errors", real.length === 0, real.slice(0, 5).join(" | "));

await browser.close();
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
