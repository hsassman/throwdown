// Captures a burst of screenshots from a live CPU fight, with the fake player
// (tools/fake-player.mjs) as the camera, so changes to how the fight looks can
// be reviewed frame by frame instead of described.
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
mkdirSync("tools/out/burst", { recursive: true });
const b = await chromium.launch({ channel: "chrome", headless: true, args: [
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11",
  `--use-file-for-fake-video-capture=${resolve(process.argv[3] ?? "tools/out/fake-player.y4m")}`] });
const [vw, vh] = (process.env.VIEWPORT ?? "960x540").split("x").map(Number);
const c = await b.newContext({ permissions: ["camera"], viewport: { width: vw, height: vh }, hasTouch: !!process.env.TOUCH });
const p = await c.newPage();
p.on("pageerror", (e) => console.log("[pageerror]", e.message));
await p.goto(`${process.env.BASE_URL ?? "http://localhost:4173"}/?firstrun=0&mode=${process.argv[2] ?? "cpu"}${process.env.QUERY ?? ""}`, { waitUntil: "networkidle" });
await p.locator(".gate-btn").click();
await p.waitForFunction(() => !!window.__shadowboxPose?.(), null, { timeout: 90000 });
await p.waitForTimeout(7000);
if (process.env.ORBIT) { await p.mouse.move(480, 300); await p.mouse.down(); await p.mouse.move(480 + Number(process.env.ORBIT), 300, { steps: 20 }); await p.mouse.up(); await p.waitForTimeout(500); }
for (let i = 0; i < 24; i++) {
  await p.screenshot({ path: `tools/out/burst/f${String(i).padStart(2, "0")}.png` });
  await p.waitForTimeout(60);
}
await b.close();
