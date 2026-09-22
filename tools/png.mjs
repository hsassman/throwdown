// A minimal PNG reader, so the smoke test can assert on PIXELS.
//
// Why this exists: every visual failure this project has had would have
// survived a green unit suite — a mesh that renders as nothing, an arena built
// into the wrong scene, a fighter lit from behind and reading as a silhouette.
// The smoke test could already prove the app RUNS. This lets it prove
// something is actually THERE.
//
// Handles exactly what Playwright's page.screenshot() produces: 8-bit RGB or
// RGBA, non-interlaced, one IHDR and one or more IDAT chunks. Anything else
// throws rather than guessing, because a reader that silently mis-decodes
// would make every assertion built on it meaningless.

import { inflateSync } from "node:zlib";

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");

  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colourType = data[9];
      const interlace = data[12];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (interlace !== 0) throw new Error("interlaced PNG");
      if (colourType === 2) channels = 3;
      else if (colourType === 6) channels = 4;
      else throw new Error(`unsupported colour type ${colourType}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Un-filter. Each scanline is prefixed with its filter type and is decoded
  // against the line above it, so this has to run in order.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? dst[i - channels] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= channels ? up[i - channels] : 0;
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          // Paeth.
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`unknown filter ${filter}`);
      }
      dst[i] = v & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/** Mean luma of a rectangle, 0-255. The cheapest honest answer to "is there
 *  anything there". */
export function meanLuma(img, x, y, w, h) {
  let sum = 0;
  let n = 0;
  for (let j = y; j < Math.min(y + h, img.height); j++) {
    for (let i = x; i < Math.min(x + w, img.width); i++) {
      const o = j * img.width * img.channels + i * img.channels;
      sum += 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** How many DISTINCT colours a rectangle holds, quantised to 5 bits per
 *  channel. A flat background scores 1; anything modelled and lit scores many.
 *  Catches "it rendered, but it rendered nothing". */
export function colourCount(img, x, y, w, h) {
  const seen = new Set();
  for (let j = y; j < Math.min(y + h, img.height); j++) {
    for (let i = x; i < Math.min(x + w, img.width); i++) {
      const o = j * img.width * img.channels + i * img.channels;
      seen.add(
        ((img.data[o] >> 3) << 10) | ((img.data[o + 1] >> 3) << 5) | (img.data[o + 2] >> 3)
      );
    }
  }
  return seen.size;
}

/** Fraction of pixels that differ between two same-sized images, 0-1. Used to
 *  prove the camera actually moved rather than that a drag was accepted. */
export function differenceRatio(a, b, threshold = 12) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) {
    const oa = p * a.channels;
    const ob = p * b.channels;
    const d =
      Math.abs(a.data[oa] - b.data[ob]) +
      Math.abs(a.data[oa + 1] - b.data[ob + 1]) +
      Math.abs(a.data[oa + 2] - b.data[ob + 2]);
    if (d > threshold) changed++;
  }
  return changed / n;
}
