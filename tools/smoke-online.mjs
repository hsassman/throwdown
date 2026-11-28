// End-to-end test of online play: the real .NET matchmaking server and
// headless browsers pressing "Find a match", and Play a Friend by room code.

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

// A browser per player. Two software-rendered pages in one browser share its
// GPU and network processes, and on a two-core CI runner that starved both:
// the offer and answer crossed, yet ICE never started checking inside the
// connect timeout (seen in CI annotations: A stable, B still have-local-offer).
const launchOptions = {
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
};
const browsers = [];

let failures = 0;
/** In GitHub Actions, also as an annotation: those show on the commit without a login, the log does not. */
function annotate(level, title, text) {
  if (!process.env.GITHUB_ACTIONS) return;
  const esc = (v) => String(v).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::${level} title=${esc(title).replace(/[:,]/g, " ")}::${esc(text)}`);
}
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) {
    failures += 1;
    annotate("error", name, detail || "failed");
  }
}

const errors = [];
// Every RTCPeerConnection's states and candidates, per player, printed if the
// test fails - the difference between "matchmaking broke" and "the two pages
// could not reach each other" is otherwise invisible in a CI log.
const rtcLog = [];
const players = [];
async function openPlayer(label, params = "mode=internet") {
  const browser = await chromium.launch(launchOptions);
  browsers.push(browser);
  const context = await browser.newContext({
    permissions: WITH_CAMERA ? ["camera"] : [],
    // Small: every pixel is drawn in software on CI.
    viewport: { width: 960, height: 600 },
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
  // Straight to the screen by URL, so a menu redesign cannot break this test.
  await page.goto(BASE + "/" + (QUERY ? QUERY + "&" : "?") + "firstrun=0&" + params, { waitUntil: "networkidle" });
  await page.locator(".gate-btn").click();
  // A join link stops at the camera choice first.
  if (params.startsWith("join=")) await page.locator('[data-view="view-first"]').click({ timeout: TIMEOUT });
  await page.waitForSelector(".vs", { timeout: TIMEOUT });
  return { page, context };
}

const findMatch = (page) => page.locator(".vs-btn", { hasText: "Find a match" }).click();
const hostRoom = async (page) => {
  await page.locator(".vs-btn", { hasText: "Host a fight" }).click();
  await page.waitForFunction(() => /^[A-HJ-NP-Z2-9]{4}$/.test(document.querySelector(".room-code")?.textContent ?? ""), undefined, { timeout: TIMEOUT });
  return page.locator(".room-code").textContent();
};
const joinRoom = async (page, code) => {
  await page.locator(".room-input").fill(code);
  await page.locator(".vs-btn", { hasText: /^Join$/ }).click();
};
const roomSays = (page, pattern) =>
  page.waitForFunction((source) => [...document.querySelectorAll(".vs-room .vs-detail")]
    .map((el) => el.textContent ?? "").find((text) => new RegExp(source).test(text)) ?? "", pattern.source, { timeout: TIMEOUT })
    .then((h) => h.jsonValue()).catch(() => "(never said)");
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

  // --- Play a Friend: the host gets a code, the friend types it ---------------
  const host = await openPlayer("H", "mode=lan");
  const code = await hostRoom(host.page);
  check("hosting shows a four-character code", /^[A-HJ-NP-Z2-9]{4}$/.test(code ?? ""), code ?? "");
  check("and a QR code", await host.page.waitForSelector(".room-qr svg path", { timeout: TIMEOUT }).then(() => true, () => false));
  const friend = await openPlayer("F", "mode=lan");
  await joinRoom(friend.page, code.toLowerCase());
  const roleHost = await connected(host.page);
  const roleFriend = await connected(friend.page);
  check("the friend joins with the code, and whoever hosted hosts", roleHost === "Host" && roleFriend === "Guest", `${roleHost} / ${roleFriend}`);
  const roomClocks = [await clockMoves(host.page).catch((e) => `stuck (${e.message.split("\n")[0]})`),
    await clockMoves(friend.page).catch((e) => `stuck (${e.message.split("\n")[0]})`)];
  check("the friends' fight clock runs on both ends", roomClocks.every((c) => !c.startsWith("stuck")), roomClocks.join(" / "));
  await host.page.screenshot({ path: `${OUT}/room-host.png` });
  await friend.context.close();
  await host.context.close();

  // --- The QR code: a link that joins the room --------------------------------
  const qrHost = await openPlayer("Q", "mode=lan");
  const qrCode = await hostRoom(qrHost.page);
  const scanner = await openPlayer("S", `join=${qrCode}`);
  const qrRoles = [await connected(qrHost.page), await connected(scanner.page)];
  check("opening the QR code's link joins the fight", qrRoles.join("/") === "Host/Guest", qrRoles.join(" / "));
  await scanner.context.close();
  await qrHost.context.close();

  // --- A wrong code, and a cancelled room -------------------------------------
  const gone = await openPlayer("X", "mode=lan");
  const goneCode = await hostRoom(gone.page);
  await gone.page.locator(".vs-btn", { hasText: "Cancel" }).click();
  const late = await openPlayer("L", "mode=lan");
  await joinRoom(late.page, goneCode);
  const lateSays = await roomSays(late.page, /No fight with that code/);
  check("a cancelled room's code no longer joins", /No fight with that code/.test(lateSays), lateSays);
  await gone.context.close();
  await late.context.close();

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
  annotate("error", "threw", err.message.split("\n").slice(0, 4).join("\n"));
}

if (failures > 0) {
  console.log("\n--- what each player's screen said ---");
  const screens = [];
  for (const { label, page } of players) {
    const text = await page
      .evaluate(() => document.querySelector(".vs")?.innerText ?? "(no panel)")
      .catch(() => "(page closed)");
    screens.push(`${label}: ${text.replace(/\s+/g, " ")}`);
    console.log(`  ${screens.at(-1)}`);
    await page.screenshot({ path: `${OUT}/fail-${label}.png` }).catch(() => {});
  }
  console.log("\n--- WebRTC log ---");
  for (const line of rtcLog) console.log(`  ${line}`);
  annotate("warning", "screens", screens.join("\n"));
  annotate("warning", "WebRTC states", rtcLog.filter((l) => !/candidate/.test(l)).slice(-60).join("\n"));
}

// Same filter as smoke-shell.mjs, plus WebRTC/socket noise from the pages we
// close on purpose.
const real = errors.filter(
  (e) =>
    !/swiftshader|WebGL|GroupMarkerNotSet|Failed to load resource|WebSocket|connection was stopped|stun:|TensorFlow Lite XNNPACK/i.test(e)
);
check("no runtime errors", real.length === 0, real.slice(0, 5).join(" | "));

await Promise.all(browsers.map((b) => b.close()));
console.log(failures === 0 ? "\nONLINE SMOKE OK" : `\nONLINE SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
