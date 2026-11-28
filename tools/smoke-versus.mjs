// Two browsers, one Play a Friend fight, both cameras the fake player.
// Checks the host sees the guest's defence, the guest sees the host's fight
// events, and a rematch restarts both ends.
//
// Usage (needs npm run build && npm run preview):
//   BASE_URL=http://localhost:4173 node tools/smoke-versus.mjs [seconds]
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const SECONDS = Number(process.argv[2] ?? 25);
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-angle=d3d11",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--use-file-for-fake-video-capture=${resolve(process.env.VIDEO ?? "tools/out/fake-player.y4m")}`,
  ],
});

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

async function open(label) {
  const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  await page.goto(`${BASE}/?firstrun=0&demo&mode=lan`, { waitUntil: "networkidle" });
  await page.locator(".gate-btn").click();
  await page.waitForFunction(() => !!window.__shadowboxPose?.(), null, { timeout: 90000 });
  return page;
}

const debug = (page) => page.evaluate(() => window.__shadowboxDebug());
const waitFor = async (page, fn, arg, timeout = 30000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });

try {
  const host = await open("host");
  const guest = await open("guest");

  await host.evaluate(() => window.__shadowboxNet.host());
  await waitFor(host, () => (window.__shadowboxDebug().code?.length ?? 0) > 50);
  const offer = (await debug(host)).code;
  await guest.evaluate((c) => window.__shadowboxNet.join(c), offer);
  await waitFor(guest, () => (window.__shadowboxDebug().code?.length ?? 0) > 50);
  const answer = (await debug(guest)).code;
  await host.evaluate((c) => window.__shadowboxNet.complete(c), answer);

  await waitFor(host, () => window.__shadowboxDebug().netOpen);
  await waitFor(guest, () => window.__shadowboxDebug().netOpen);
  const roles = [(await debug(host)).role, (await debug(guest)).role];
  check("the two browsers connect as host and guest", roles[0] === "host" && roles[1] === "guest", roles.join(" / "));

  await waitFor(guest, () => !!window.__shadowboxDebug().hud);
  await host.waitForTimeout(SECONDS * 1000);

  const h = await debug(host);
  const g = await debug(guest);
  check("the host receives the guest's defence", !!h.remoteDefence, JSON.stringify(h.remoteDefence));
  check("the guest's clock follows the host's", Math.abs((h.hud?.clock ?? 0) - (g.hud?.clock ?? 99)) < 1.5, `${h.hud?.clock} / ${g.hud?.clock}`);
  check("the guest sees the host's fight events", (g.hud?.log?.length ?? 0) > 0, g.hud?.log?.[0] ?? "empty");
  // Sampled a moment apart, so one punch may be in flight.
  const near = (a, b) => Math.abs((a ?? 0) - (b ?? 99)) <= 1;
  check(
    "both ends agree on punches landed",
    near(h.hud?.player.landed, g.hud?.opponent.landed) && near(h.hud?.opponent.landed, g.hud?.player.landed),
    `host ${h.hud?.player.landed}-${h.hud?.opponent.landed}, guest ${g.hud?.player.landed}-${g.hud?.opponent.landed}`
  );
  console.log("host log:", h.hud?.log?.slice(0, 4));
  console.log("guest log:", g.hud?.log?.slice(0, 4));

  const before = h.hud?.clock ?? 0;
  await host.evaluate(() => window.__shadowboxNet.rematch());
  await waitFor(guest, () => window.__shadowboxDebug().rematch.remote);
  check("a rematch request reaches the other end", true);
  await guest.evaluate(() => window.__shadowboxNet.rematch());
  await waitFor(host, (b) => (window.__shadowboxDebug().hud?.clock ?? 0) > b + 2, before, 15000).catch(() => {});
  const after = await debug(host);
  check("both asking restarts the fight", (after.hud?.clock ?? 0) > before + 2 && after.hud?.player.landed === 0, `${before} -> ${after.hud?.clock}`);
  check("and the requests are cleared", !after.rematch.local && !after.rematch.remote);
} catch (e) {
  console.log("FAIL  run aborted:", e.message);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
