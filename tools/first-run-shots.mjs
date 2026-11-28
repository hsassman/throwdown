// Screenshots of the first-run walkthrough with the fake player as the
// camera, at a laptop size and a phone size, so its layout can be checked on
// both without a device.
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
mkdirSync("tools/out/firstrun", { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const SIZES = {
  laptop: { viewport: { width: 1280, height: 720 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const b = await chromium.launch({ channel: "chrome", headless: true, args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11",
  `--use-file-for-fake-video-capture=${resolve(process.env.FAKE_VIDEO ?? "tools/out/fake-high.y4m")}`] });
for (const [name, opts] of Object.entries(SIZES)) {
  const c = await b.newContext({ permissions: ["camera"], ...opts });
  const p = await c.newPage();
  p.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.screenshot({ path: `tools/out/firstrun/${name}-0-gate.png` });
  await p.locator(".gate-btn").click();
  await p.locator(".firstrun").waitFor({ timeout: 90000 });
  // One shot per step reached; the fake player stands framed, guards and
  // throws a jab-cross every 1.2 s, so it walks itself through.
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const title = (await p.locator(".firstrun-title").textContent().catch(() => null)) ?? "gone";
    if (!seen.includes(title)) {
      seen.push(title);
      console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s ${title}`);
      await p.screenshot({ path: `tools/out/firstrun/${name}-${seen.length}.png` });
    }
    if (title === "You're set" || title === "gone") break;
    await p.waitForTimeout(150);
  }
  await c.close();
}
await b.close();
