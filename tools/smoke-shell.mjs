// Smoke-tests the menu shell and the dummy training screen.
//
// This exists because the unit tests prove the geometry and the state machines
// and prove nothing at all about whether the app runs. Every visual failure
// this project has had would have survived a green test suite - a mesh that
// renders as nothing, a screen that throws on mount, a lazy chunk that fails
// to resolve. Those are all caught here and nowhere else.
//
//   npm run preview           (in one terminal)
//
// `npm run smoke` Builds first. The preview server serves dist/, so without
// that step a run silently tests the previous build - three camera changes in
// a row appeared to do nothing before this was noticed.
//   node tools/smoke-shell.mjs
//
// A fake camera device is supplied, so MediaPipe gets a real video stream with
// no person in it. That is enough to prove the pipeline starts; it cannot
// prove the tracking is any good.

import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { colourCount, decodePng, differenceRatio, meanLuma } from "./png.mjs";

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

// Waits are generous on purpose. Everything here runs under SwiftShader with
// an 8 MB model and a pose model competing for the same CPU, and a second
// browser once the networked fight starts. A tight timeout in that environment
// fails on machine load rather than on the code, which is worse than useless -
// three runs in a row once failed at three different points with nothing
// broken.
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const step = (msg) => console.log(`  ${msg}`);
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
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

  // --- Every row is reachable, including the ones below the fold ---
  //
  // The list is taller than a laptop viewport and `.shell` clips its overflow,
  // so the bottom rows used to be invisible with nothing to suggest they were
  // there. This checks the column really scrolls and that the keyboard can
  // actually walk to the last row rather than stopping at the fade.
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector(".shell-list-wrap");
    if (!el) return null;
    return { scroll: el.scrollHeight, client: el.clientHeight };
  });
  check(
    "the menu list scrolls rather than clipping its last rows",
    scrollable !== null && scrollable.scroll > scrollable.client,
    JSON.stringify(scrollable)
  );

  const lastRowVisible = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll(".shell-row")];
    const last = rows[rows.length - 1];
    if (!last) return null;
    last.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 120));
    const wrap = document.querySelector(".shell-list-wrap").getBoundingClientRect();
    const r = last.getBoundingClientRect();
    return { title: last.textContent.trim().slice(0, 24), inside: r.top >= wrap.top - 2 && r.bottom <= wrap.bottom + 2 };
  });
  check(
    "the last row can be brought into view",
    lastRowVisible !== null && lastRowVisible.inside,
    JSON.stringify(lastRowVisible)
  );

  // --- Every input method is advertised, not just the camera ---
  const inputs = await page.evaluate(
    () => document.querySelector(".shell-inputs")?.textContent ?? ""
  );
  check(
    "the menu names keyboard, mouse and camera",
    /move/.test(inputs) && /Mouse/.test(inputs) && /Camera/.test(inputs),
    inputs.slice(0, 120)
  );

  await page.screenshot({ path: `${OUT}/shell-menu.png` });
  step(`saved ${OUT}/shell-menu.png`);

  // --- Locked row explains itself rather than doing nothing ---
  await locked.first().click();
  await page.waitForTimeout(250);
  const reject = await page.locator(".shell-detail-reject").count();
  check("pressing a locked row explains why", reject === 1);

  // --- The camera must survive navigation ---
  //
  // The regression test for this file. The camera is attached to the <video>
  // element exactly once; if navigating remounts that element, the ref points
  // at a fresh one with no stream and the picture freezes while the camera
  // light stays on. There is no error anywhere - it just stops.
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
  await page.waitForSelector(".thud", { timeout: 45000 });
  check("training HUD mounts", true);

  // The 3D view has to actually produce a canvas with pixels in it.
  await page.waitForSelector("canvas", { timeout: 45000 });
  await page.waitForTimeout(4000);
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    return { w: c.width, h: c.height };
  });
  check("3D canvas exists and has size", !!canvas && canvas.w > 0 && canvas.h > 0, JSON.stringify(canvas));

  // A drill that never lights a target is the whole feature failing silently.
  //
  // Polled, not sampled once. There is a deliberate rest gap between one
  // target clearing and the next lighting, during which nothing is lit and the
  // label reads "-". A single sample lands in that gap often enough to make
  // the check flaky - which it did, and the drill was fine.
  let litText = "-";
  const seen = [];
  for (let i = 0; i < 30 && litText === "-"; i++) {
    litText = ((await page.locator(".thud-target-label").textContent()) ?? "").trim();
    if (litText && litText !== "-") seen.push(litText);
    else await page.waitForTimeout(200);
  }
  check("a target lights", seen.length > 0, `saw "${seen[0] ?? ""}"`);

  // And the drill must keep moving. One target stuck on screen forever would
  // pass the check above and still be completely broken.
  const presentedAt = async () => {
    const line = (await page.locator(".thud-line").textContent()) ?? "";
    return Number(line.match(/\d+\/(\d+)/)?.[1] ?? 0);
  };
  //
  // Polled with a generous budget rather than waiting one target-cycle. In
  // headless software GL, MediaPipe inference spikes to several seconds and
  // starves the animation frame the drill runs on, so a window sized for the
  // real frame rate is flaky here. It is the advance that matters, not how
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
  await page.waitForSelector(".tpanel", { timeout: 45000 });
  const tp = await page.evaluate(() => ({
    score: document.querySelector(".tpanel-score-value")?.textContent,
    metrics: document.querySelectorAll(".tpanel-metrics li").length,
    facts: document.querySelectorAll(".tpanel-facts dd").length,
  }));
  // Headless has a camera but no person in it, so the honest state here is
  // "not measured yet" rather than a score. Both are valid; a panel showing
  // neither would mean the screen is dead.
  const waiting = tp.score === "-";
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
  // The aggregate system panel sits below it - it polls its own monitor on
  // an interval, so give it a moment to produce its first report.
  await page.waitForSelector(".spanel", { timeout: 45000 });
  await page.waitForTimeout(600);
  const sp = await page.evaluate(() => ({
    sections: document.querySelectorAll(".spanel-sections li").length,
    text: document.querySelector(".spanel")?.textContent ?? "",
  }));
  check(
    "system panel shows all four sections",
    sp.sections === 4,
    JSON.stringify(sp)
  );
  check(
    "frame delivery reports a real number, not stuck warming up",
    /Hz/.test(sp.text),
    sp.text.slice(0, 200)
  );

  await page.screenshot({ path: `${OUT}/shell-tracking.png` });
  step(`saved ${OUT}/shell-tracking.png`);
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Free work ---
  await rows.filter({ hasText: "Free Work" }).first().click();
  await page.waitForSelector(".thud", { timeout: 45000 });
  await page.waitForTimeout(1500);
  const freeLit = await page.locator(".thud-target-label").count();
  check("free work shows no scored target", freeLit === 0);

  // One visit to the dummy is one round. `stop` is reachable from several
  // places - the screen changing, the round ending, the mode being disabled -
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
  // The opponent is the one part of the game that runs on its own clock with
  // nobody in front of the camera, so headless is a genuine test of it rather
  // than a stand-in: the CPU circles, closes range and throws whether or not a
  // player is there. What cannot be checked here is the player landing a
  // punch, which needs a body in frame.
  await rows.filter({ hasText: "Fight the CPU" }).first().click();
  await page.waitForSelector(".fight-hud", { timeout: 45000 });

  const firstClock = await page.locator(".fh-clock").textContent();
  // Long enough for a contender to get through a tempo gap and a telegraph.
  await page.waitForTimeout(4000);
  const laterClock = await page.locator(".fh-clock").textContent();
  check(
    "the round clock is running",
    firstClock !== laterClock,
    `${firstClock} -> ${laterClock}`
  );

  // The opponent has to actually do something. Polled rather than sampled: a
  // telegraph is a few hundred milliseconds inside a tempo of one to two
  // seconds, so a single read would miss it far more often than not - the
  // same flake that made the drill assertions unreliable.
  //
  // The window is deliberately generous - 15s, not the 6s it started at. With
  // nobody in front of the camera the CPU is often out of range and has to
  // close it before it will throw at all, so how soon the first telegraph
  // arrives depends on its footwork, and its footwork is driven by a seeded
  // generator. Anything that changes how many random numbers get drawn earlier
  // in the fight shifts that timeline wholesale: wiring the player's guard did
  // exactly that, and this check started failing intermittently despite the
  // opponent behaving perfectly. What is being asserted is "the opponent
  // telegraphs", not "it telegraphs inside six seconds".
  let sawWindup = false;
  for (let i = 0; i < 150 && !sawWindup; i++) {
    sawWindup = (await page.locator(".fh-windup").count()) > 0;
    if (!sawWindup) await page.waitForTimeout(100);
  }
  check("the opponent telegraphs a punch", sawWindup);

  // And the player takes damage from it, which is the end-to-end path: CPU
  // decides -> sim applies -> HUD reports. A fight where the health bar never
  // moves is a fight the opponent is not really in.
  let hurt = false;
  for (let i = 0; i < 80 && !hurt; i++) {
    // Read off the ARIA meter rather than the inline style. It is the value
    // the screen reader is given, so checking it verifies the accessible
    // readout and the bar at once - and a bar that animated while the meter
    // stayed at 100 would be a real defect this would catch.
    const now = await page
      .locator('[aria-label="You health"]')
      .getAttribute("aria-valuenow");
    hurt = Number(now) < 100;
    if (!hurt) await page.waitForTimeout(150);
  }
  check("the player takes damage from the opponent", hurt);

  // --- The fight is the whole screen, and the telemetry is put away ---
  //
  // The developer diagnostics used to render on every screen, which made a
  // wall of monospace perf numbers the most prominent thing on screen during
  // a fight. They are one keypress away instead.
  const immersive = await page.evaluate(() => ({
    hud: document.querySelectorAll(".hud").length,
    panel: document.querySelectorAll(".panel").length,
    floatHead: document.querySelectorAll(".screen-head-float").length,
    back: document.querySelectorAll(".back-btn").length,
  }));
  check(
    "a fight hides the developer diagnostics",
    immersive.hud === 0 && immersive.panel === 0,
    JSON.stringify(immersive)
  );
  check(
    "and still offers a way back without the keyboard",
    immersive.floatHead === 1 && immersive.back === 1,
    JSON.stringify(immersive)
  );

  await page.keyboard.press("`");
  await page.waitForTimeout(200);
  const toggled = await page.evaluate(() => document.querySelectorAll(".hud").length);
  check("backtick brings the diagnostics back", toggled === 1, String(toggled));
  await page.keyboard.press("`");
  await page.waitForTimeout(200);

  await page.screenshot({ path: `${OUT}/shell-fight.png` });
  step(`saved ${OUT}/shell-fight.png`);

  // --- The fight happens somewhere ---------------------------------------
  //
  // Pixels, not the DOM. The arena is WebGL geometry and nothing about it is
  // visible to a selector, which is exactly why it went unnoticed that fights
  // were being staged in an empty dark room while a fully modelled, fully lit
  // octagon sat one screen away in the venue picker. `ArenaView` built one;
  // the fight scene never did.
  const shot = decodePng(await page.screenshot());
  // The canvas the fighters stand on fills the lower-left of the frame. In the
  // empty room that region was the background colour, luma about 14.
  const floorLuma = meanLuma(shot, 60, 640, 160, 160);
  check(
    "the fight is staged in the arena, not in an empty room",
    floorLuma > 45,
    `floor luma ${floorLuma.toFixed(1)}`
  );
  // And it is a lit, modelled scene rather than a few flat fills - the other
  // way a render can "work" and show nothing.
  const colours = colourCount(shot, 0, 120, 1440, 760);
  check("the fight scene is lit and modelled", colours > 200, `${colours} colours`);

  // --- Mouse navigation: orbiting the fight camera -------------------------
  //
  // The third input this game claims to support, and the one nothing checked.
  // It also exercises the camera director's handover: the director holds the
  // camera during a cut and gives it back afterwards, and a handover that
  // failed to re-enable the controls would leave a drag doing nothing at all.
  const stageBox = await page.locator("canvas").first().boundingBox();
  const ox = stageBox.x + stageBox.width / 2;
  const oy = stageBox.y + stageBox.height / 2;
  await page.mouse.move(ox, oy);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(ox - i * 8, oy - i);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const orbited = decodePng(await page.screenshot());
  const moved = differenceRatio(shot, orbited);
  check(
    "the fight camera orbits with the mouse",
    moved > 0.15,
    `${(moved * 100).toFixed(1)}% of the frame changed`
  );
  await page.screenshot({ path: `${OUT}/shell-fight-orbit.png` });
  step(`saved ${OUT}/shell-fight-orbit.png`);

  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Career ---
  await rows.filter({ hasText: "Career" }).first().click();
  await page.waitForSelector(".fight-hud", { timeout: 45000 });
  await page.waitForSelector(".cpanel", { timeout: 10000 });
  const careerText = await page.locator(".cpanel").textContent();
  check(
    "career panel shows a clean record and the first rung",
    /0W/.test(careerText ?? "") && /The Tune-Up/.test(careerText ?? ""),
    careerText?.slice(0, 200)
  );
  await page.screenshot({ path: `${OUT}/shell-career.png` });
  step(`saved ${OUT}/shell-career.png`);
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Same Network: two real browsers, one fight ------------------------
  //
  // The only check in this file that opens a second page, and it has to.
  // Everything about the network layer is a statement about two machines
  // agreeing, and a single page can prove none of it - a protocol that
  // round-trips perfectly in a unit test still fails if the host forgets to
  // create the data channel before the offer, or if both ends make one.
  //
  // The codes are ferried between the pages here, in Node, which is exactly
  // the job the two players do by pasting them to each other. No signalling
  // server exists and none is being stood up for the test.
  const guest = await context.newPage();
  const guestErrors = [];
  guest.on("pageerror", (e) => guestErrors.push(`pageerror: ${e.message}`));
  guest.on("console", (m) => {
    if (m.type() === "error") guestErrors.push(`console: ${m.text()}`);
  });
  try {
    await guest.goto(BASE + "/", { waitUntil: "networkidle" });
    await guest.locator(".gate-btn").click();
    await guest.waitForSelector(".shell", { timeout: 45000 });

    const openLan = async (pg) => {
      await pg.locator(".shell-row").filter({ hasText: "Same Network" }).first().click();
      await pg.waitForSelector(".vs", { timeout: 45000 });
    };
    await openLan(page);
    await openLan(guest);
    check(
      "same-network play is reachable rather than locked",
      (await page.locator(".vs").count()) === 1
    );

    // 1. The host makes a code.
    await page.locator(".vs-btn", { hasText: "Host a fight" }).click();
    await page.waitForFunction(
      () => (document.querySelector(".vs-code textarea")?.value?.length ?? 0) > 50,
      undefined,
      { timeout: 45000 }
    );
    const hostCode = await page.locator(".vs-code textarea").inputValue();
    check("the host produces a code to send", hostCode.length > 100, `${hostCode.length} chars`);

    // 2. The guest joins with it and produces a reply.
    await guest.locator(".vs-field textarea").fill(hostCode);
    await guest.locator(".vs-btn", { hasText: "Join with a code" }).click();
    await guest.waitForFunction(
      () => (document.querySelector(".vs-code textarea")?.value?.length ?? 0) > 50,
      undefined,
      { timeout: 45000 }
    );
    const replyCode = await guest.locator(".vs-code textarea").inputValue();
    check("the guest replies with a code", replyCode.length > 100, `${replyCode.length} chars`);

    // 3. The host takes the reply, and the connection completes.
    await page.locator(".vs-field textarea").fill(replyCode);
    await page.locator(".vs-btn", { hasText: "Start the fight" }).click();

    // Once connected the codes have done their job and the panel gives way to
    // a floating chip, so the fight gets the whole width - which is also what
    // proves the handover happened rather than the panel simply changing text.
    const connected = async (pg) => {
      await pg.waitForSelector(".vs-chip .vs-dot.vs-open", { timeout: 45000 });
      return pg.locator(".vs-chip-role").textContent();
    };
    const hostState = await connected(page);
    const guestState = await connected(guest);
    check(
      "the two browsers connect to each other",
      hostState === "Host" && guestState === "Guest",
      `${hostState} / ${guestState}`
    );
    check(
      "and the connection panel gets out of the way",
      (await page.locator(".vs").count()) === 0 &&
        (await page.locator(".app-immersive").count()) === 1
    );

    // 4. Round-trip timing proves messages are flowing both ways - the state
    //    light only proves the channel opened.
    await page.waitForSelector(".vs-ping", { timeout: 15000 });
    await guest.waitForSelector(".vs-ping", { timeout: 15000 });
    const ping = await page.locator(".vs-ping").textContent();
    const guestPing = await guest.locator(".vs-ping").textContent();
    check(
      "messages round-trip between them",
      /\d+ ms/.test(ping ?? "") && /\d+ ms/.test(guestPing ?? ""),
      `${ping} / ${guestPing}`
    );
    // Both ends must report a real round trip. Before the hello carried a
    // `ping` flag, the only hello a peer ever saw was the other end's own
    // scheduled one, so the figure on screen was the time until their next
    // ping - the host read 75 ms and the guest 1051 ms in the same session.
    const ms = (t) => Number.parseInt(t ?? "", 10);
    check(
      "and the latency is a round trip, not the ping interval",
      ms(ping) < 400 && ms(guestPing) < 400,
      `${ping} / ${guestPing}`
    );

    // 5. And the fight itself starts, on both ends. The host owns the clock;
    //    the guest is shown the host's, so a running clock on the guest is
    //    proof the authoritative state is crossing the link.
    await page.waitForSelector(".fight-hud", { timeout: 45000 });
    await guest.waitForSelector(".fight-hud", { timeout: 45000 });
    //
    // Polled, not sampled after a fixed wait. The simulation clamps its own
    // delta to 0.1 s a frame so that a backgrounded tab cannot advance the
    // round by thirty seconds at once - which means that below 10 FPS the
    // fight runs in slow motion rather than skipping. Two pages each carrying
    // a pose model and a WebGL context through SwiftShader are comfortably
    // below that, so a 2.5-second wait sometimes caught less than one second
    // of round clock and read as the link having failed.
    const first = await guest.locator(".fh-clock").textContent();
    let later = first;
    for (let i = 0; i < 40 && later === first; i++) {
      await guest.waitForTimeout(400);
      later = await guest.locator(".fh-clock").textContent();
    }
    check(
      "the guest is shown the host's round clock",
      first !== later,
      `${first} -> ${later}`
    );

    await page.screenshot({ path: `${OUT}/versus-host.png` });
    await guest.screenshot({ path: `${OUT}/versus-guest.png` });
    step(`saved ${OUT}/versus-host.png and ${OUT}/versus-guest.png`);

    // --- What happens when the other fighter walks away --------------------
    //
    // The half of a network feature nobody builds until it bites. The guest
    // used to keep its role after the host closed, so the panel went on
    // offering "send this reply code back to the host" for a host that no
    // longer existed, with no way back short of leaving the screen.
    await page.locator(".vs-chip-leave").click();
    await guest.waitForSelector(".vs", { timeout: 15000 });
    const told = await guest.locator(".vs-detail").first().textContent();
    check(
      "the guest is told when the host leaves",
      /left|disconnect/i.test(told ?? ""),
      told ?? "nothing"
    );
    check(
      "and can start another fight straight away",
      (await guest.locator(".vs-btn", { hasText: "Host a fight" }).count()) === 1
    );
    check("no runtime errors on the guest", guestErrors.length === 0, guestErrors[0] ?? "");
  } finally {
    await guest.close();
  }
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Stages ---
  await rows.filter({ hasText: "Stages" }).first().click();
  await page.waitForSelector(".arena-view canvas", { timeout: 45000 });
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
  await page.locator(".back-btn").click();
  await page.waitForSelector(".shell", { timeout: 10000 });

  // --- Every screen can be entered and left, by keyboard and by mouse ------
  //
  // The individual screens are checked above; this checks the thing between
  // them. A mode that opens but cannot be left is a dead end, and a menu that
  // works with the mouse but not the keyboard is only advertised as working
  // with both. Escape especially: a camera-driven UI needs a guaranteed way
  // out that does not depend on the camera, because a player who cannot be
  // seen is exactly the player who needs to leave.
  const playable = await page.evaluate(() =>
    [...document.querySelectorAll(".shell-row")]
      .filter((r) => r.getAttribute("data-locked") !== "true")
      .map((r) => r.querySelector(".shell-row-title")?.textContent ?? "")
  );
  check("there are playable rows to walk", playable.length >= 5, `${playable.length}`);

  let entered = 0;
  let escaped = 0;
  for (const title of playable) {
    await page.locator(".shell-row").filter({ hasText: title }).first().click();
    // Every mode puts a back button on screen, wherever it sits.
    await page.waitForSelector(".back-btn", { timeout: 30000 });
    entered += 1;
    await page.keyboard.press("Escape");
    await page.waitForSelector(".shell", { timeout: 15000 });
    escaped += 1;
  }
  check(
    "every playable row opens with the mouse",
    entered === playable.length,
    `${entered}/${playable.length}`
  );
  check(
    "and every one of them closes with Escape",
    escaped === playable.length,
    `${escaped}/${playable.length}`
  );

  // The same trip on the keyboard alone, which is the half a mouse test
  // cannot cover: focus has to move and Enter has to activate what is focused.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const focused = await page.evaluate(
    () =>
      document.querySelector('.shell-row[data-focused="true"] .shell-row-title')
        ?.textContent ?? ""
  );
  await page.keyboard.press("Enter");
  await page.waitForSelector(".back-btn", { timeout: 30000 });
  const opened = await page.locator(".screen-title").textContent();
  check(
    "the keyboard opens the row it says is focused",
    opened === focused,
    `focused "${focused}" -> opened "${opened}"`
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".shell", { timeout: 15000 });
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
