// Browser regression checks for the HUD and camera-driven onboarding.
// Run against Vite dev so the fixture can import the real React component.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5174";
const out = new URL("./out/ui-review/", import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL("../hud-refinement-fixture.html", out), `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fight HUD fixture</title></head>
<body><div id="root"></div><script type="module">
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { FightHud } from "/src/ui/FightHud.tsx";
import "/src/index.css";
import "/src/App.css";
import "/src/ui/presentation.css";

function Fixture() {
  const [waiting, wait] = useState(false);
  const state = new URLSearchParams(location.search).get("state");
  const live = state === "live";
  const h = React.createElement;
  const result = live ? null : { kind: "win", reason: "decision" };
  const hud = {
    round: 3, clock: live ? 19 : 0, phase: live ? "fighting" : "decision", result,
    player: { health: 64, stamina: .54, landed: 23 }, opponent: { health: 18, stamina: .28, landed: 17 },
    cards: { player: 29, opponent: 27 }, log: ["Counter landed", "Guard held"], range: 4,
    windup: live ? .65 : 0, count: null, getUp: null,
  };
  return h("main", { className: "app app-immersive" },
    h("div", { className: "stage", style: { background: "linear-gradient(#0b081928, #0b081974), url(/ui/venue.webp) center / cover" } },
      h(FightHud, { hud, rematch: live ? null : { waiting, opponentReady: false, onRematch: () => wait(true) } })));
}
createRoot(document.getElementById("root")).render(React.createElement(Fixture));
</script></body></html>`);

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--enable-unsafe-swiftshader"],
});

const portrait = { width: 390, height: 700 };
const landscape = { width: 844, height: 390 };
const button = (page, name) => page.getByRole("button", { name, exact: true });
const mode = (page, id) => page.locator(`[data-mode-id="${id}"]`);
const fixture = (state) => base + "/tools/out/hud-refinement-fixture.html?state=" + state;

async function shot(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + " overflows");
  await page.screenshot({ path: fileURLToPath(new URL(name + ".png", out)), animations: "disabled" });
  console.log("Saved " + name);
}

async function assertTouchable(locator) {
  const hit = await locator.evaluate((target) => {
    const box = target.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return box.height >= 44 && !!hit && target.contains(hit);
  });
  assert.ok(hit, "Expected an unoccluded touch target at least 44 px tall");
}

async function fixtureReview(viewport, name) {
  const page = await browser.newPage({ viewport, hasTouch: true, isMobile: true });
  try {
    await page.goto(fixture("live"));
    const cue = page.getByText("Incoming", { exact: true });
    await cue.waitFor();
    assert.ok(await cue.evaluate((el) => el.getBoundingClientRect().left > innerWidth / 2));
    await shot(page, name + "-incoming-cue");

    await page.goto(fixture("result"));
    const action = button(page, "Fight again");
    await action.waitFor();
    await assertTouchable(action);
    assert.equal(await page.getByRole("heading", { name: "You win", exact: true }).count(), 1);
    assert.match(await page.locator(".fh-scorecard").first().textContent(), /23\s*Landed29\s*Points/);
    await shot(page, name + "-result");
    await action.tap();
    assert.equal(await button(page, "Rematch requested").isDisabled(), true);
    assert.ok(await page.getByText("Waiting for your opponent.", { exact: true }).isVisible());
    console.log("Verified rematch tap and waiting state in " + name);
  } finally {
    await page.close();
  }
}

async function gameReview() {
  const page = await browser.newPage({ viewport: portrait, isMobile: true, hasTouch: true, permissions: ["camera"] });
  page.setDefaultTimeout(25000);
  try {
    await page.goto(base + "/?firstrun=1");
    await button(page, "Enable camera").tap();
    const dialog = page.getByRole("dialog", { name: "Step back" });
    await dialog.waitFor({ timeout: 55000 });
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await page.locator(".shell").getAttribute("inert"), "");
    assert.equal(await dialog.locator('[aria-current="step"]').textContent(), "1Frame");
    const setupPreview = dialog.getByRole("button", { name: "Camera preview", exact: true });
    await page.keyboard.press("Tab");
    if (await setupPreview.count()) {
      assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Camera preview");
      await page.keyboard.press("Space");
      assert.equal(await setupPreview.getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".cam-coach.cam-skeleton").count(), 0);
      await shot(page, "refined-phone-setup-preview");
      await page.keyboard.press("Space");
      assert.equal(await setupPreview.getAttribute("aria-pressed"), "false");
      await page.keyboard.press("Shift+Tab");
    }
    assert.match(await page.locator(":focus").textContent(), /Skip setup/);
    await shot(page, "refined-phone-onboarding");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await mode(page, "dummy").tap();
    await page.locator(".stage .boxer-model canvas").waitFor();
    await page.locator(".stage .thud-target-label").waitFor();
    assert.ok(await page.locator(".stage .thud-target").evaluate((el) => {
      const stage = el.closest(".stage").getBoundingClientRect();
      return el.getBoundingClientRect().bottom < stage.top + stage.height / 2;
    }));
    await shot(page, "refined-phone-training");
    const resultsLink = page.getByRole("link", { name: "Round complete View results" });
    await resultsLink.waitFor({ timeout: 75000 });
    await assertTouchable(resultsLink);
    await resultsLink.tap();
    const recap = page.getByRole("region", { name: "Training results" });
    await recap.waitFor();
    assert.match(await recap.textContent(), /Round score0%0\/12 landed/);
    assert.ok(await page.evaluate(() => document.activeElement?.id === "training-results"));
    await shot(page, "refined-phone-training-results");
    await button(page, "Go again").tap();
    await page.locator(".stage .thud-target-label").waitFor();

    await button(page, "Main menu").tap();
    await mode(page, "career").tap();
    const roster = page.getByRole("list", { name: "Career ladder" });
    await roster.waitFor();
    assert.equal(await roster.getByRole("listitem").count(), 4);
    assert.match(await roster.locator('[aria-current="step"]').textContent(), /The Tune-Up/);
    await roster.scrollIntoViewIfNeeded();
    await shot(page, "refined-phone-career");
    await button(page, "Main menu").tap();

    await mode(page, "stages").tap();
    const ring = button(page, "The Ring");
    await ring.tap();
    assert.equal(await ring.getAttribute("aria-pressed"), "true");
    await page.locator(".arena-view canvas").waitFor();
    assert.ok(await page.getByText("Drag the arena to rotate the preview").isVisible());
    await shot(page, "refined-phone-venue");
    await button(page, "Main menu").tap();

    await mode(page, "cpu").tap();
    await page.locator(".fh-clock").waitFor();
    const camera = button(page, "Switch camera to third person");
    if (await camera.count()) {
      await assertTouchable(camera);
      await camera.tap();
      const switchToFirst = button(page, "Switch camera to first person");
      await switchToFirst.waitFor();
      await page.goto(base + "/?firstrun=0");
      await button(page, "Enable camera").tap();
      await mode(page, "cpu").tap();
      await switchToFirst.waitFor();
      await page.keyboard.press("v");
      await camera.waitFor();
      assert.ok(await page.locator(".cam-inset").evaluate((element) => {
        const stage = element.closest(".stage").getBoundingClientRect();
        return element.getBoundingClientRect().bottom < stage.top + stage.height * 2 / 3;
      }), "First-person camera preview should stay above the gloves");
      const previewSwitch = button(page, "Show my camera");
      if (await previewSwitch.count()) {
        await assertTouchable(previewSwitch);
        await previewSwitch.tap();
        const hidePreview = button(page, "Hide my camera, show only the skeleton");
        await hidePreview.waitFor();
        assert.equal(await hidePreview.getAttribute("aria-pressed"), "true");
        await hidePreview.tap();
        await previewSwitch.waitFor();
      }
      await shot(page, "refined-phone-fight-camera");
    }
    console.log("Verified camera setup, live drill, recap, restart, career and venue selection in the game");
  } finally {
    await page.close();
  }
}

async function friendReview() {
  const settings = { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true };
  const host = await browser.newPage({ ...settings, permissions: ["camera", "clipboard-read", "clipboard-write"] });
  const guest = await browser.newPage({ ...settings, permissions: ["camera"] });
  await guest.addInitScript(() => {
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: () => Promise.reject(new Error("Clipboard unavailable in this test")),
      });
    }
  });
  try {
    async function openInvite(page) {
      await page.goto(base + "/?firstrun=0");
      await button(page, "Enable camera").tap();
      await mode(page, "lan").tap();
      await button(page, "Host a fight").waitFor();
    }
    await openInvite(host);
    await openInvite(guest);
    const join = button(guest, "Join with a code");
    const invite = guest.getByLabel("Their host code");
    assert.equal(await join.isDisabled(), true);
    assert.equal(await invite.getAttribute("autocapitalize"), "none");
    assert.ok((await invite.boundingBox()).y < (await join.boundingBox()).y);
    await shot(guest, "refined-friend-match-join");

    await host.bringToFront();
    await host.getByLabel("Their host code").fill("old-host-code-to-clear-123");
    await button(host, "Host a fight").tap();
    const outgoing = host.locator(".vs-code textarea");
    await outgoing.waitFor();
    assert.equal(await host.getByLabel("Your friend's reply code").inputValue(), "");
    const hostCode = await outgoing.inputValue();
    const copy = button(host, "Copy code");
    await copy.scrollIntoViewIfNeeded();
    await assertTouchable(copy);
    await copy.tap();
    await host.getByText("Code copied.", { exact: true }).waitFor();
    assert.equal(await host.evaluate(() => navigator.clipboard.readText()), hostCode);
    await shot(host, "refined-friend-match-host");

    await guest.bringToFront();
    await invite.fill(hostCode);
    await join.tap();
    const reply = guest.locator(".vs-code textarea");
    await reply.waitFor();
    const replyCode = await reply.inputValue();
    await button(guest, "Copy code").tap();
    await guest.getByText("Code selected.", { exact: false }).waitFor();
    assert.ok(await reply.evaluate((field) => (
      document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === field.value.length
    )));
    await shot(guest, "refined-friend-match-reply");

    await host.bringToFront();
    await host.getByLabel("Your friend's reply code").fill(replyCode);
    await button(host, "Start the fight").tap();
    await host.locator(".vs-chip").waitFor();
    await guest.locator(".vs-chip").waitFor();
    await assertTouchable(button(host, "Leave"));
    await shot(host, "refined-friend-match-connected");
    console.log("Verified touch invite, clipboard copy, selection fallback and local peer connection");
  } finally {
    await host.close();
    await guest.close();
  }
}

try {
  await fixtureReview(portrait, "refined-portrait-fight");
  await fixtureReview(landscape, "refined-landscape-fight");
  await fixtureReview({ width: 640, height: 320 }, "refined-compact-fight");
  await gameReview();
  await friendReview();
} finally {
  await browser.close();
}
