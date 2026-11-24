import { chromium } from 'playwright-core';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const sourceDir = 'assets/generated-art';
const allNames = (await readdir(sourceDir))
  .filter(file => file.endsWith('.png') && file !== 'crowd-ringside-b.png')
  .map(file => file.slice(0, -4));
const names = process.argv.length > 2 ? process.argv.slice(2) : allNames;
const detailMaps = ['skin-grain', 'hair-grain', 'glove-grain', 'shorts-weave', 'corner-vinyl',
  'kit-matte', 'kit-ribbed', 'hair-crop'];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const name of names) {
    const source = await readFile(`${sourceDir}/${name}.png`);
    const secondRow = name === 'crowd-ringside' ? await readFile(`${sourceDir}/crowd-ringside-b.png`) : null;
    const limit = detailMaps.includes(name) || name === 'blood' ? 512 :
      ['canvas', 'leather', 'concrete', 'rubber', 'steel', 'oxblood', 'brick', 'cage-mat', 'crowd-ringside'].includes(name) ? 1024 : 1600;
    const result = await page.evaluate(async ({ data, extra, limit }) => {
      const decode = async url => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      };
      const img = await decode(data);
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, limit / img.width);
      const rowHeight = Math.round(img.height * ratio);
      canvas.width = Math.round(img.width * ratio);
      canvas.height = rowHeight * (extra ? 2 : 1);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, rowHeight);
      if (extra) ctx.drawImage(await decode(extra), 0, rowHeight, canvas.width, rowHeight);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) transparent++;
      return { url: canvas.toDataURL('image/webp', 0.86), width: canvas.width, height: canvas.height, transparent };
    }, {
      data: `data:image/png;base64,${source.toString('base64')}`,
      extra: secondRow && `data:image/png;base64,${secondRow.toString('base64')}`,
      limit,
    });
    await writeFile(`public/art/${name}.webp`, Buffer.from(result.url.split(',')[1], 'base64'));
    console.log(name, result.width, result.height, 'alpha pixels:', result.transparent);
    if ((name === 'blood' || name === 'crowd-ringside') && result.transparent === 0) {
      throw new Error(`${name} must have real transparency`);
    }
  }
} finally { await browser.close(); }
