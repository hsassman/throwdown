// Captures the documentation screenshots into docs/images (WebP), with the
// fake player as the camera. Needs npm run build && npm run preview, and
// tools/out/fake-high.y4m from tools/fake-player.mjs.
//   BASE_URL=http://localhost:4173 node tools/screenshots.mjs
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const OUT = "docs/images";
const TMP = "tools/out/shots";
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=d3d11", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(process.env.VIDEO ?? "tools/out/fake-high.y4m")}`],
});

const shots = [
  ["gate", "desktop", "", { gate: true }],
  ["menu", "desktop", ""],
  ["menu", "phone", ""],
  ["settings", "phone", "", { settings: true }],
  ["fight-first-person", "desktop", "&mode=cpu", { wait: 9000 }],
  ["fight-first-person", "phone", "&mode=cpu", { wait: 9000 }],
  ["fight-third-person", "desktop", "&mode=cpu&view=third", { wait: 9000 }],
  ["training", "desktop", "&mode=dummy", { wait: 8000 }],
  ["career", "desktop", "&mode=career", { wait: 6000 }],
  ["fighter", "desktop", "&mode=fighter", { wait: 5000 }],
  ["fighter", "phone", "&mode=fighter", { wait: 5000 }],
  ["venue", "desktop", "&mode=stages", { wait: 5000 }],
  ["play-a-friend", "phone", "&mode=lan", { wait: 3000 }],
  ["online", "desktop", "&mode=internet", { wait: 3000 }],
  ["camera-check", "desktop", "&mode=tracking", { wait: 5000 }],
];

const only = process.env.ONLY?.split(",");
for (const [name, form, query, opt = {}] of shots) {
  if (only && !only.includes(name)) continue;
  const phone = form === "phone";
  const context = await browser.newContext({
    permissions: ["camera"],
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 720 },
    deviceScaleFactor: phone ? 2 : 1,
    isMobile: phone,
    hasTouch: phone,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?firstrun=0${query}`, { waitUntil: "networkidle" });
  if (!opt.gate) {
    await page.locator(".gate-btn").click();
    await page.waitForFunction(() => !!window.__shadowboxPose?.(), null, { timeout: 90000 }).catch(() => {});
    if (opt.settings) await page.locator(".shell-settings").last().click();
    await page.waitForTimeout(opt.wait ?? 2500);
  } else {
    await page.waitForTimeout(3000);
  }
  const png = `${TMP}/${name}-${form}.png`;
  await page.screenshot({ path: png });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", png, ...(phone ? ["-vf", "scale=390:-1"] : []), "-quality", "82", `${OUT}/${name}-${form}.webp`]);
  console.log(`${OUT}/${name}-${form}.webp`);
  await context.close();
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
