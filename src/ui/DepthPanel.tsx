import { useEffect, useRef } from "react";
import { armForward, backgroundOf, chestPoint, type DepthFrame } from "../depth/depthMath";
import type { DepthStatus } from "../depth/useDepthMap";
import "./depthPanel.css";

/**
 * The live depth map, false-coloured near-warm / far-cool, with the chest
 * reference and wrists marked and how far each fist is in front of the chest.
 *
 * Normalised per frame between the background and the nearest point, because
 * the model's output has no fixed scale (see depthMath.ts) - colour shows the
 * shape of the scene, not distances in metres.
 */
export function DepthPanel({
  status,
  frameRef,
}: {
  status: DepthStatus;
  frameRef: React.RefObject<DepthFrame | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status.state !== "ready") return;
    let raf = 0;
    let drawn: DepthFrame | null = null;
    let image: ImageData | null = null;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const frame = frameRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!frame || !canvas || !ctx || frame === drawn) return;
      drawn = frame;
      const { size, map } = frame;
      if (canvas.width !== size) {
        canvas.width = size;
        canvas.height = size;
        image = null;
      }
      image ??= ctx.createImageData(size, size);
      const lo = backgroundOf(map);
      let hi = lo;
      for (let i = 0; i < map.length; i++) if (map[i] > hi) hi = map[i];
      const span = hi - lo || 1;
      const px = image.data;
      for (let i = 0; i < map.length; i++) {
        const [r, g, b] = heat((map[i] - lo) / span);
        const o = i * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = b;
        px[o + 3] = 255;
      }
      // The camera image is unmirrored and the player sees a mirror, so flip
      // to match the inset and their own sense of left and right.
      ctx.putImageData(image, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = "copy";
      ctx.translate(size, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();

      // The pose from the frame's own capture instant, not the live one.
      const pose = frame.pose;
      if (pose) {
        const mark = (k: { x: number; y: number; confidence: number } | undefined, colour: string) => {
          if (!k || k.confidence < 0.5) return;
          const u = ((k.x * frame.videoW - frame.crop.x) / frame.crop.w) * size;
          const v = ((k.y * frame.videoH - frame.crop.y) / frame.crop.h) * size;
          ctx.fillStyle = colour;
          ctx.beginPath();
          ctx.arc(size - u, v, size / 60, 0, Math.PI * 2);
          ctx.fill();
        };
        mark(chestPoint(pose) ?? undefined, "#fff");
        mark(pose.leftWrist, "#ffd84a");
        mark(pose.rightWrist, "#ffd84a");
        const fmt = (v: number | null) => (v === null ? "--" : v.toFixed(2));
        if (readoutRef.current) {
          readoutRef.current.textContent =
            `fist forward  L ${fmt(armForward(frame, pose, "left"))}  R ${fmt(armForward(frame, pose, "right"))}` +
            `  ·  ${frame.inferenceMs.toFixed(0)} ms`;
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [status.state, frameRef]);

  return (
    <div className="depth-panel" aria-label="Depth map">
      <div className="depth-title">
        Depth
        <span className="depth-sub">
          {status.state === "ready"
            ? `${status.backend === "webgpu" ? "WebGPU" : "CPU"} · ${status.variant.replace(/^model_|\.onnx$/g, "")}`
            : status.state === "loading"
              ? status.total > 0
                ? `downloading model ${Math.round((status.loaded / status.total) * 100)}%`
                : "loading model..."
              : status.state === "error"
                ? "unavailable"
                : ""}
        </span>
      </div>
      {status.state === "error" ? (
        <div className="depth-error">{status.message}</div>
      ) : (
        <canvas ref={canvasRef} className="depth-canvas" width={1} height={1} />
      )}
      <div ref={readoutRef} className="depth-readout" />
      <div className="depth-hint">D to hide</div>
    </div>
  );
}

/** Near-warm, far-cool ramp: black, deep blue, cyan, yellow, red. */
function heat(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const stops: [number, number, number, number][] = [
    [0, 8, 10, 30],
    [0.3, 20, 60, 160],
    [0.55, 30, 190, 210],
    [0.8, 250, 220, 60],
    [1, 240, 60, 40],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t1, r1, g1, b1] = stops[i];
    const [t0, r0, g0, b0] = stops[i - 1];
    if (x <= t1) {
      const u = (x - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u];
    }
  }
  return [240, 60, 40];
}
