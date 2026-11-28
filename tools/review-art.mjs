// Capture and validate the React UI in the installed Chrome browser.
// Start Vite or the built preview, then set BASE_URL to its local address.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";

const base = process.env.BASE_URL ?? "http://localhost:4173";
const out = new URL("./out/ui-review/", import.meta.url);
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-unsafe-swiftshader"],
});

async function shot(page, name, selector) {
  if (selector) await page.locator(selector).first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + " overflows");
  await page.screenshot({ path: fileURLToPath(new URL(name + ".png", out)), animations: "disabled", timeout: 25000 });
  console.log("Saved " + name);
}

const heading = (page) => page.getByRole("heading", { name: "Play", exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const settings = (page) => button(page, "Settings").click();
const mode = (page, id) => page.locator(`[data-mode-id="${id}"]`);
async function openHome(context, name) {
  await context.addInitScript(() => localStorage.setItem("shadowbox.firstRun.v1", "done"));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  if (name) await shot(page, name + "-intro", ".gate-btn");
  await button(page, "Enable camera").click();
  await heading(page).waitFor();
  return { page, errors };
}

async function review(view, name) {
  const context = await browser.newContext({ ...view, permissions: ["camera"] });
  context.setDefaultTimeout(25000);
  try {
    const { page, errors } = await openHome(context, name);
    await shot(page, name + "-home");
    const scroll = page.locator(".shell-list-wrap");
    assert.ok(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight));
    assert.equal(await page.locator(".mode-tile-featured").count(), 3);
    assert.ok(await page.locator(".mode-tile-featured").evaluateAll((tiles) => {
      const viewport = document.querySelector(".shell-list-wrap").getBoundingClientRect();
      return tiles.every((tile) => tile.getBoundingClientRect().bottom <= viewport.bottom + 1);
    }), name + " primary modes are cut off");

    const card = page.locator(".mode-tile-featured .shell-row").nth(1);
    await card.evaluate((el) => Promise.all(el.parentElement.getAnimations().map((animation) => animation.finished)));
    await page.mouse.move(0, 0);
    const cardGeometry = () => card.evaluate((el) => {
      const art = el.querySelector(".mode-image");
      const title = el.querySelector(".shell-row-title");
      const list = el.closest(".shell-list-wrap");
      return [el, art, title, list].map((part) => part.getBoundingClientRect().toJSON());
    });
    assert.equal(await card.locator(".mode-image").evaluate((art) => getComputedStyle(art).transform), "none");
    const restingCard = await cardGeometry();
    if (view.hasTouch) await card.evaluate((el) => el.focus({ preventScroll: true }));
    else await card.hover();
    assert.equal(await card.getAttribute("data-focused"), "true");
    assert.equal(await card.locator(".mode-image").evaluate((art) => (
      getComputedStyle(art).transform === "none" && art.getAnimations().length === 0
    )), true);
    assert.deepEqual(await cardGeometry(), restingCard, name + " card moved when highlighted");

    await settings(page);
    const reduced = page.getByRole("button", { name: /Reduce UI motion/ });
    const contrast = page.getByRole("button", { name: /High contrast/ });
    await reduced.click();
    await contrast.click();
    assert.equal(await reduced.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("html").getAttribute("data-ui-contrast"), "");
    await shot(page, name + "-settings");
    await button(page, "Close settings").click();
    assert.equal(await page.locator(".shell-hero-art").evaluate((el) => getComputedStyle(el).animationName), "none");
    await page.reload();
    await button(page, "Enable camera").click();
    assert.equal(await page.locator("html").getAttribute("data-ui-reduced"), "");
    await settings(page);
    await reduced.click();
    await contrast.click();
    await page.keyboard.press("Escape");
    await heading(page).waitFor();
    const keyboardTargets = await page.locator(".shell-row").evaluateAll(
      (cards) => cards.map((card) => card.dataset.modeId)
    );
    if (await mode(page, "tracking").count()) keyboardTargets.push("tracking");
    for (const target of [...keyboardTargets, "Settings", keyboardTargets[0]]) {
      await page.keyboard.press("ArrowRight");
      const active = await page.locator(":focus").evaluate(
        (element) => element.dataset.modeId ?? element.getAttribute("aria-label")
      );
      assert.equal(active, target);
    }

    if (await mode(page, "local").count()) {
      await mode(page, "local").click();
      await page.getByRole("alert").filter({ hasText: "Same-screen play is unavailable." }).waitFor();
    }
    await scroll.evaluate((el) => { el.scrollTop = 0; });
    let hasPhoneCamera = false;
    const screens = [
      ["dummy", ".thud-score", "training"],
      ["freeplay", ".thud-profile", "free-work", false, true],
      ["cpu", ".fh-clock", "fight"],
      ["fps", ".fh-clock", "first-person", false, true],
      ["fighter", ".fighter-panel", "fighter"],
      ["stages", ".stage-picker", "venues"],
      ["career", ".cpanel", "career"],
      ["lan", ".vs", "network"],
      ["internet", ".vs", "online"],
      ["tracking", ".tpanel", "tracking", true],
      ["phonecam", ".vs", "phone-camera", true, true],
      ["punchlab", ".harness", "punch-lab", true, true],
    ];
    for (const [id, selector, slug, utility, optional] of screens) {
      const target = mode(page, id);
      const openTools = utility && (await target.count()) === 0;
      if (openTools) await settings(page);
      if (optional && (await target.count()) === 0) {
        if (openTools) await button(page, "Close settings").click();
        continue;
      }
      if (id === "phonecam") hasPhoneCamera = true;
      await target.click();
      if (["fight", "first-person", "training", "free-work", "career", "fighter"].includes(slug)) {
        await page.locator(".boxer-model canvas").waitFor();
        await page.waitForTimeout(550);
      }
      if (slug === "fight" || slug === "first-person") {
        assert.ok(await page.locator(".app-immersive .stage").evaluate(
          (stage) => stage.getBoundingClientRect().height >= innerHeight - 1
        ), name + " fight stage does not fill the viewport");
      }
      await shot(page, name + "-" + slug, selector);
      await button(page, "Main menu").click();
      await heading(page).waitFor();
    }
    assert.deepEqual(errors, []);
    return hasPhoneCamera;
  } finally {
    await context.close();
  }
}

try {
  const hasPhoneCamera = await review({ viewport: { width: 1440, height: 900 } }, "desktop");
  await review(devices["iPhone 13"], "phone");

  const firstRun = await browser.newPage({ viewport: { width: 390, height: 744 }, permissions: ["camera"] });
  await firstRun.goto(base);
  await button(firstRun, "Enable camera").click();
  await shot(firstRun, "phone-onboarding", ".firstrun");
  await firstRun.keyboard.press("Escape");
  assert.equal(await firstRun.locator(".firstrun").count(), 0);
  await firstRun.close();

  const narrowPhone = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", permissions: ["camera"] });
  const { page: narrow } = await openHome(narrowPhone);
  await shot(narrow, "narrow-phone-home");
  assert.equal(await narrow.locator(".shell-hero-art").evaluate((el) => getComputedStyle(el).animationName), "none");
  if (hasPhoneCamera) {
    await narrow.goto(base + "/?sensor");
    await shot(narrow, "phone-sensor", ".sensor");
  }
  await narrow.goto(base + "/?stage");
  await shot(narrow, "phone-stage", ".stagepage-qr");
  await narrowPhone.close();

  const landscape = await browser.newContext({ viewport: { width: 844, height: 390 }, permissions: ["camera"], isMobile: true, hasTouch: true });
  const { page } = await openHome(landscape);
  await shot(page, "landscape-home");
  assert.ok(await mode(page, "cpu").evaluate(
    (tile) => tile.getBoundingClientRect().bottom <= document.querySelector(".shell-list-wrap").getBoundingClientRect().bottom
  ));
  await mode(page, "cpu").tap();
  await page.locator(".app-immersive .boxer-model canvas").waitFor();
  const clock = await page.locator(".fh-centre").boundingBox();
  const meters = await page.locator(".fh-left").boundingBox();
  assert.ok(clock && meters && clock.y + clock.height < meters.y + 3, "Landscape clock overlaps the meters");
  await shot(page, "landscape-fight", ".fh-clock");
  await landscape.close();
} finally {
  await browser.close();
}
