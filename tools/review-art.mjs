import { chromium } from 'playwright-core';
import { mkdir, readdir } from 'node:fs/promises';

await mkdir('tools/out', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['camera'] });
  await page.addInitScript(() => localStorage.setItem('shadowbox.firstRun.v1', 'done'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(process.env.BASE_URL ?? 'http://localhost:4174');
  await page.screenshot({ path: 'tools/out/art-entry-desktop.png' });
  await page.locator('.gate-btn').click();
  await page.locator('.shell-detail-art').waitFor();
  await page.evaluate(async () => {
    await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
    await document.fonts.ready;
  });
  await page.screenshot({ path: 'tools/out/art-menu-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'tools/out/art-menu-phone.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const overlap = await page.evaluate(() => {
    const detail = document.querySelector('.shell-detail').getBoundingClientRect();
    const list = document.querySelector('.shell-list-wrap').getBoundingClientRect();
    return detail.bottom > list.top;
  });
  if (overflow || overlap || errors.length) throw new Error(JSON.stringify({ overflow, overlap, errors }));
  // Verify every generated runtime image loads, and the decal has clear margins.
  const artNames = (await readdir('public/art')).filter(file => file.endsWith('.webp')).map(file => file.slice(0, -5));
  const assets = await page.evaluate(async names => {
    const result = {};
    for (const name of names) {
      const img = new Image(); img.src = `/art/${name}.webp`; await img.decode();
      result[name] = `${img.width}x${img.height}`;
      if (name === 'blood' || name === 'crowd-ringside') {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        if (ctx.getImageData(0, 0, 1, 1).data[3] !== 0) throw new Error(`${name} corner is opaque`);
      }
    }
    return result;
  }, artNames);
  console.log('Decoded generated artwork and verified cutout alpha and phone menu fit.', assets);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.shell-row').filter({ hasText: 'Dummy Work' }).first().click();
  await page.locator('.thud-target-label').waitFor({ timeout: 45000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tools/out/art-training-room.png' });
  await page.locator('.back-btn').click();
  await page.locator('.shell-row').filter({ hasText: 'Career' }).first().click();
  await page.locator('.cpanel-art').waitFor();
  await page.locator('.cpanel-art').evaluate(img => img.decode());
  await page.screenshot({ path: 'tools/out/art-career.png' });
  await page.locator('.back-btn').click();
  await page.locator('.shell-row').filter({ hasText: 'Stages' }).first().click();
  const venueCards = page.locator('.stage-btn');
  await venueCards.first().waitFor();
  await venueCards.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  for (const title of ['The Ring', 'The Cage']) {
    const card = venueCards.filter({ hasText: title });
    await card.click();
    if (await card.getAttribute('aria-pressed') !== 'true') throw new Error(`Venue selection failed: ${title}`);
  }
  await page.screenshot({ path: 'tools/out/art-venues-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  const cardsFit = await venueCards.evaluateAll(cards => cards.length === 2 && cards.every(card => {
    const box = card.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
  }));
  if (!cardsFit) throw new Error('Venue cards extend past the phone viewport');
  await page.screenshot({ path: 'tools/out/art-venues-phone.png' });
  await page.locator('.back-btn').click();
  const openFighter = async () => {
    await page.getByRole('menuitem', { name: /Your Fighter/ }).click();
    await page.getByRole('img', { name: /3D fighter preview/ }).waitFor();
  };
  const choose = name => page.locator('.fighter-option').getByText(name, { exact: true }).click();
  await openFighter();
  await choose('Deep brown');
  await choose('Curled crop');
  await choose('Brass');
  await choose('Matte leather and ribbed fabric');
  await page.getByRole('button', { name: 'Save fighter' }).click();
  await page.getByText('Fighter saved on this device.').waitFor();
  await page.getByRole('img', { name: /3D fighter preview/ }).waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('shadowbox.fighter.v1')));
  if (saved.skin !== 'deep' || saved.hair !== 'crop' || saved.colour !== 'gold' || saved.finish !== 'matte') {
    throw new Error('Fighter appearance was not saved');
  }
  await page.screenshot({ path: 'tools/out/art-fighter-phone.png', fullPage: true });
  await choose('Shaved');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.gate-btn').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFighter();
  if (!await page.getByRole('radio', { name: 'Curled crop' }).isChecked()) {
    throw new Error('Saved hairstyle was not restored after leaving and reloading');
  }
  await page.screenshot({ path: 'tools/out/art-fighter-desktop.png' });
  if (errors.length) throw new Error(JSON.stringify(errors));
  console.log('Art review passed, including character and venue rendering and phone venue fit.');
} finally { await browser.close(); }
