// End-to-end check of the phone camera link (src/sensor/), with two headless
// browsers standing in for the laptop and the phone, both fed the fake player
// as their camera. Two browsers, not two tabs: a background tab is throttled,
// and the "phone" would stream at 2 fps.
//
// Pairs them the way a person would - the "phone" opens the link decoded
// from the laptop's QR code, and the laptop is given the phone's reply decoded
// from the phone's QR code - so both QR codes are proven readable, not just
// the connection. Then streams for a while and prints the link numbers.
//
// Usage (needs npm run build && npm run preview, and tools/out/fake-high.y4m):
//   node tools/smoke-phonecam.mjs [seconds]
//
// Both tabs share one machine and one clock, so the delay here is the floor
// (tracking + data channel, no Wi-Fi). Real numbers need a real phone.
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import jsQR from "jsqr";
import { decodePng } from "./png.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";
const SECONDS = Number(process.argv[2] ?? 15);
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exit(1);
};

async function readQr(locator) {
  const img = decodePng(await locator.screenshot());
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.width * img.height; i++, j += img.channels) {
    rgba[i * 4] = img.data[j];
    rgba[i * 4 + 1] = img.data[j + 1];
    rgba[i * 4 + 2] = img.data[j + 2];
    rgba[i * 4 + 3] = 255;
  }
  return jsQR(rgba, img.width, img.height)?.data ?? null;
}

const launch = () =>
  chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--use-angle=d3d11",
      `--use-file-for-fake-video-capture=${resolve("tools/out/fake-high.y4m")}`,
    ],
  });
const laptopBrowser = await launch();
const phoneBrowser = await launch();
const laptop = await (
  await laptopBrowser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } })
).newPage();
laptop.on("pageerror", (e) => console.log("[laptop pageerror]", e.message));
await laptop.goto(`${BASE}/?firstrun=0`, { waitUntil: "networkidle" });
await laptop.locator(".gate-btn").click();
await laptop.waitForSelector(".shell");
await laptop.getByRole("button", { name: "Settings", exact: true }).click();
await laptop.locator(".shell-row").filter({ hasText: "Phone Camera" }).last().click();
await laptop.getByRole("button", { name: "Connect a phone" }).click();
const offerQr = laptop.getByRole("img", { name: "QR code for the phone" });
await offerQr.waitFor({ timeout: 15000 });
const offerUrl = await readQr(offerQr);
if (!offerUrl?.includes("?sensor#c1~o~")) fail(`laptop QR did not decode to a sensor link: ${offerUrl}`);
console.log("laptop QR ->", offerUrl.length, "chars");

const phone = await (
  await phoneBrowser.newContext({ permissions: ["camera"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
).newPage();
phone.on("pageerror", (e) => console.log("[phone pageerror]", e.message));
await phone.goto(offerUrl, { waitUntil: "networkidle" });
await phone.getByRole("button", { name: "Start camera" }).click();
const replyQr = phone.getByRole("img", { name: "Reply code for the laptop" });
await replyQr.waitFor({ timeout: 30000 });
const reply = await readQr(replyQr);
if (!reply?.startsWith("c1~a~")) fail(`phone QR did not decode to a reply code: ${reply}`);
console.log("phone QR ->", reply.length, "chars");

await laptop.getByPlaceholder("c1~a~…").fill(reply);
await laptop.getByRole("button", { name: "Connect", exact: true }).click();
await laptop.getByText("Phone connected").waitFor({ timeout: 15000 });
// The phone has to load its pose model before it has anything to send;
// the measurement starts at the first frame, not at the connection.
await laptop.waitForFunction(() => (window.__shadowboxSensor?.()?.received ?? 0) > 0, null, { timeout: 90000 });
const before = (await laptop.evaluate(() => window.__shadowboxSensor?.())).received;
console.log("connected; streaming for", SECONDS, "s");

await laptop.waitForTimeout(SECONDS * 1000);
const s = await laptop.evaluate(() => window.__shadowboxSensor?.());
console.log(JSON.stringify(s, null, 1));
await laptop.screenshot({ path: "tools/out/phonecam-laptop.png" });
await phone.screenshot({ path: "tools/out/phonecam-phone.png" });
if (!s || s.received - before < SECONDS * 5) fail(`too few frames arrived: ${s ? s.received - before : 0} in ${SECONDS} s`);
if (s.ageP50 === null) fail("no clock sync");
console.log("PHONECAM OK");
await laptopBrowser.close();
await phoneBrowser.close();
