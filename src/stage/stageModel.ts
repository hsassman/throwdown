// Pure helpers for the projector page (StagePage.tsx), kept separate so they
// can be unit-tested without a DOM.
import qrcode from "qrcode-generator";

/**
 * The link the QR code points at: the game itself, without ?stage. An
 * explicit ?url= wins, for when the projector machine opens the page from a
 * different address than the audience should use (e.g. localhost on the
 * laptop, the Vercel domain for phones).
 */
export function playUrl(href: string): string {
  const url = new URL(href);
  const override = url.searchParams.get("url");
  if (override) {
    try {
      const o = new URL(override);
      if (o.protocol === "https:" || o.protocol === "http:") return o.toString();
    } catch {
      // Not a URL: fall through to the page's own address.
    }
  }
  url.searchParams.delete("stage");
  url.searchParams.delete("url");
  url.hash = "";
  return url.toString();
}

/** The QR code as rows of dark/light modules. Error correction M: readable
 *  from the back of a room even with some glare on the projector. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** One SVG path for every dark module, so the browser draws a single shape
 *  rather than hundreds of rects. */
export function qrPath(matrix: boolean[][]): string {
  let d = "";
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c} ${r}h1v1h-1z`;
    })
  );
  return d;
}
