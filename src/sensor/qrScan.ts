// Reads a QR code off the laptop's own webcam - how the phone's reply code
// gets back without a server or a keyboard.
//
// jsQR rather than the BarcodeDetector API: BarcodeDetector is not available
// in desktop Chrome on Windows, which is the laptop this has to work on. It
// is loaded on first use, so the game's bundle does not carry a QR decoder
// for a mode most players never open.

type JsQr = typeof import("jsqr").default;
let decoder: Promise<JsQr> | null = null;

export function loadQrDecoder(): Promise<JsQr> {
  decoder ??= import("jsqr").then((m) => m.default);
  return decoder;
}

/**
 * One attempt at reading a QR code from the video's current frame.
 *
 * The frame is the camera's own, not the mirrored preview: the preview is
 * flipped with CSS, and a mirrored QR code does not decode.
 */
export function scanFrame(jsQR: JsQr, video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < 2) return null;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  // A phone screen is light-on-dark or dark-on-light depending on theme;
  // trying both costs one extra pass only when the first finds nothing.
  return jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
