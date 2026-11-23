// Captures a burst of screenshots from a live CPU fight, with the fake player
// (tools/fake-player.mjs) as the camera, so changes to how the fight looks can
// be reviewed frame by frame instead of described.
//
// Usage (needs npm run build && npm run preview):
//   node tools/fight-burst.mjs ["Fight the CPU"]   # menu row to open
//   ORBIT=420 node tools/fight-burst.mjs           # drag the camera round first
// Writes tools/out/burst/f00.png ... f23.png (git-ignored).
//
// Screenshots are slow, so frames land ~0.3-0.5s apart: good for framing,
// overlap and HUD layout, not for judging a single punch's motion.
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
mkdirSync("tools/out/burst", { recursive: true });
const b = await chromium.launch({ channel: "chrome", headless: true, args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11",
  `--use-file-for-fake-video-capture=${resolve("tools/out/fake-player.y4m")}`] });
const c = await b.newContext({ permissions: ["camera"], viewport: { width: 960, height: 540 } });
const p = await c.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
await p.goto((process.env.BASE_URL ?? "http://localhost:4173") + "/?firstrun=0", { waitUntil: "networkidle" });
await p.locator(".gate-btn").click();
await p.waitForFunction(() => !!window.__shadowboxPose?.(), null, { timeout: 90000 });
await p.locator(".shell-row").filter({ hasText: process.argv[2] ?? "Fight the CPU" }).first().click();
await p.waitForTimeout(7000);
if (process.env.ORBIT) { await p.mouse.move(480, 300); await p.mouse.down(); await p.mouse.move(480 + Number(process.env.ORBIT), 300, { steps: 20 }); await p.mouse.up(); await p.waitForTimeout(500); }
for (let i = 0; i < 24; i++) {
  await p.screenshot({ path: `tools/out/burst/f${String(i).padStart(2, "0")}.png` });
  await p.waitForTimeout(60);
}
await b.close();
