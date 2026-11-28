// End-to-end test of online play: the real .NET matchmaking server and two
// headless browsers, each pressing "Find a match".

import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const SERVER = process.env.SERVER_URL ?? "http://localhost:5160";
const OUT = "tools/out";
const TIMEOUT = 45000;
// No camera by default. This test is about matchmaking and the peer
// connection, not tracking, and two pages each running pose tracking under
// software rendering starve Chrome's network thread on a CI runner: ICE never
// even starts checking and the test fails for a reason that has nothing to do
// with what it tests (seen in CI: signalling completes, both sides have host
// and srflx candidates, and the ICE state never leaves "new"). The menu and
// the fight both work without a camera, so the browsers get none.
// SMOKE_CAMERA=1 brings back a small fake camera for a manual run.
const WITH_CAMERA = process.env.SMOKE_CAMERA === "1";
// ?firstrun=0: no first-run walkthrough over the menu, as the other tools do.
// ?demo: the stage preset's lighter rendering (no anti-aliasing, shadows or
// crowd, 1x resolution). Since the art pass, two full-quality scenes under
// software rendering on one CI runner starved both pages' main threads: the
// answer was created but reached the other page after the 20 s connect
// timeout (CI log: A stable, candidate gathering never finished, B never
// applied the answer). This also exercises ?demo on every run.
const QUERY =
  process.env.SMOKE_QUERY ??
  (WITH_CAMERA
    ? "?demo&firstrun=0&camW=160&camH=120&camFps=10&delegate=cpu"
    : "?demo&firstrun=0");

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || undefined,
  executablePath: process.env.PW_EXECUTABLE || undefined,
  headless: true,
  args: [
    ...(WITH_CAMERA
      ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
      : []),
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader",
    // Chrome hides local addresses behind random .local (mDNS) names, which
    // the other page has to resolve over multicast. CI runners have no mDNS
    // responder, so those candidates never resolve and ICE has nothing to try.
    // Real phones on a real network are unaffected; this only makes the two
    // pages on one runner able to see each other's address.
    "--disable-features=WebRtcHideLocalIpsWithMdns",
  ],
});

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const errors = [];
// Every RTCPeerConnection's states and candidates, per player, printed if the
// test fails - the difference between "matchmaking broke" and "the two pages
// could not reach each other" is otherwise invisible in a CI log.
const rtcLog = [];
const players = [];
async function openPlayer(label) {
  const context = await browser.newContext({
    permissions: WITH_CAMERA ? ["camera"] : [],
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  players.push({ label, page });
  await page.exposeFunction("__rtcLog", (msg) => rtcLog.push(`${label} ${msg}`));
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (cfg) {
      const pc = new Orig(cfg);
      const log = (m) => window.__rtcLog?.(m);
      log(`new pc ${JSON.stringify(cfg?.iceServers ?? [])}`);
      pc.addEventListener("icecandidate", (e) => log(`candidate ${e.candidate?.candidate ?? "(end)"}`));
      pc.addEventListener("iceconnectionstatechange", () => log(`ice ${pc.iceConnectionState}`));
      pc.addEventListener("connectionstatechange", () => log(`conn ${pc.connectionState}`));
      pc.addEventListener("signalingstatechange", () => log(`signal ${pc.signalingState}`));
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  page.on("pageerror", (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${label} console: ${m.text()}`);
  });
  // Straight to the Online screen by URL, so a menu redesign cannot break this test.
  await page.goto(BASE + "/" + (QUERY ? QUERY + "&" : "?") + "firstrun=0&mode=internet", { waitUntil: "networkidle" });
  await page.locator(".gate-btn").click();
  await page.waitForSelector(".vs", { timeout: TIMEOUT });
  return { page, context };
}

const findMatch = (page) => page.locator(".vs-btn", { hasText: "Find a match" }).click();
const headline = (page) => page.locator(".vs-head strong").first().textContent();
const connected = async (page) => {
  await page.waitForSelector(".vs-chip .vs-dot.vs-open", { timeout: TIMEOUT });
  return page.locator(".vs-chip-role").textContent();
};

try {
  // --- The server is up -----------------------------------------------------
  const health = await fetch(`${SERVER}/health`).then((r) => r.ok).catch(() => false);
  check("the matchmaking server answers /health", health, SERVER);

  // --- Two players find each other and connect --------------------------------
  const a = await openPlayer("A");
  const b = await openPlayer("B");

  await findMatch(a.page);
  await a.page.waitForFunction(
    () => document.querySelector(".vs-head strong")?.textContent?.includes("Finding an opponent"),
    undefined,
    { timeout: TIMEOUT }
  );
  check("the first player waits in the queue", true, await headline(a.page));

  await findMatch(b.page);
  const roleA = await connected(a.page);
  const roleB = await connected(b.page);
  check(
    "both players connect, one hosting and one joining",
    [roleA, roleB].sort().join("/") === "Guest/Host",
    `${roleA} / ${roleB}`
  );

  // The host runs the clock, so a clock ticking on both ends proves the fight
  // itself started and state is flowing, not just that a socket opened.
  // Polled rather than sampled twice: the HUD refreshes a few times a second
  // and a loaded runner can skip a fixed window, which made a two-sample
  // check flaky.
  const clockMoves = async (page) => {
    const first = await page.locator(".fh-clock").first().textContent({ timeout: TIMEOUT });
    await page.waitForFunction(
      (start) => {
        const now = document.querySelector(".fh-clock")?.textContent;
        return !!now && now !== start;
      },
      first,
      { timeout: 20000 }
    );
    return `${first} -> ${await page.locator(".fh-clock").first().textContent()}`;
  };
  const hostClock = await clockMoves(a.page).catch((e) => `stuck (${e.message.split("\n")[0]})`);
  const guestClock = await clockMoves(b.page).catch((e) => `stuck (${e.message.split("\n")[0]})`);
  check(
    "the fight clock runs on both ends",
    !hostClock.startsWith("stuck") && !guestClock.startsWith("stuck"),
    `${hostClock} / ${guestClock}`
  );

  await a.page.screenshot({ path: `${OUT}/online-a.png` });
  await b.page.screenshot({ path: `${OUT}/online-b.png` });

  // --- One leaves; the other is told and can search again ---------------------
  await a.context.close();
  await b.page.waitForSelector(".vs-btn:has-text('Find a match')", { timeout: TIMEOUT });
  check("the remaining player is offered Find a match again", true);

  // --- A player who leaves the queue is not matched with anyone ---------------
  // C queues and leaves; D then queues. D must end up waiting, not paired with
  // C's dead connection. The server can hear of C's closed page after D has
  // joined; D is then told its opponent left and goes back into the queue.
  const c = await openPlayer("C");
  await findMatch(c.page);
  await c.page.waitForFunction(
    () => document.querySelector(".vs-head strong")?.textContent?.includes("Finding an opponent"),
    undefined,
    { timeout: TIMEOUT }
  );
  await c.context.close();
  const d = await openPlayer("D");
  await findMatch(d.page);
  // Wait until D is really in the queue (the hub connection can take a few
  // seconds on a loaded runner), then give a stale pairing time to happen.
  await d.page.waitForFunction(
    () => document.querySelector(".vs-head strong")?.textContent?.includes("Finding an opponent"),
    undefined,
    { timeout: TIMEOUT }
  );
  await d.page.waitForTimeout(4000);
  const dHead = await headline(d.page);
  check("a player who left the queue is not matched", /Finding an opponent/.test(dHead ?? ""), dHead ?? "");
  await d.context.close();

  // --- A player whose opponent left can search again --------------------------
  await findMatch(b.page);
  await b.page.waitForFunction(
    () => document.querySelector(".vs-head strong")?.textContent?.includes("Finding an opponent"),
    undefined,
    { timeout: TIMEOUT }
  );
  check("a player whose opponent left can search again", true, await headline(b.page));
  await b.context.close();
} catch (err) {
  console.log(`  FAIL  threw: ${err.message.split("\n")[0]}`);
  failures += 1;
}

if (failures > 0) {
  console.log("\n--- what each player's screen said ---");
  for (const { label, page } of players) {
    const text = await page
      .evaluate(() => document.querySelector(".vs")?.innerText ?? "(no panel)")
      .catch(() => "(page closed)");
    console.log(`  ${label}: ${text.replace(/\s+/g, " ")}`);
    await page.screenshot({ path: `${OUT}/fail-${label}.png` }).catch(() => {});
  }
  console.log("\n--- WebRTC log ---");
  for (const line of rtcLog) console.log(`  ${line}`);
}

// Same filter as smoke-shell.mjs, plus WebRTC/socket noise from the pages we
// close on purpose.
const real = errors.filter(
  (e) =>
    !/swiftshader|WebGL|GroupMarkerNotSet|Failed to load resource|WebSocket|connection was stopped|stun:|TensorFlow Lite XNNPACK/i.test(e)
);
check("no runtime errors", real.length === 0, real.slice(0, 5).join(" | "));

await browser.close();
console.log(failures === 0 ? "\nONLINE SMOKE OK" : `\nONLINE SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
