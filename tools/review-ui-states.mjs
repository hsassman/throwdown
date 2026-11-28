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
    await page.keyboard.press("Tab");
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
      await button(page, "Switch camera to first person").waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("shadowbox.view")), "third");
      await page.keyboard.press("v");
      await camera.waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("shadowbox.view")), "first");
      assert.ok(await page.locator(".cam-inset").evaluate((element) => {
        const stage = element.closest(".stage").getBoundingClientRect();
        return element.getBoundingClientRect().bottom < stage.top + stage.height * 2 / 3;
      }), "First-person camera preview should stay above the gloves");
      await shot(page, "refined-phone-fight-camera");
    }
    console.log("Verified camera setup, live drill, recap, restart, career and venue selection in the game");
  } finally {
    await page.close();
  }
}

try {
  await fixtureReview(portrait, "refined-portrait-fight");
  await fixtureReview(landscape, "refined-landscape-fight");
  await fixtureReview({ width: 640, height: 320 }, "refined-compact-fight");
  await gameReview();
} finally {
  await browser.close();
}
