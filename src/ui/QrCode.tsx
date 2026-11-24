import { useMemo } from "react";
import { qrMatrix, qrPath } from "../stage/stageModel";

/** A QR code as one SVG path, with the four-module quiet zone scanners need.
 *  Always dark on white: a themed QR code is one fewer camera can read. */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const path = useMemo(() => {
    const m = qrMatrix(text);
    return { d: qrPath(m), size: m.length };
  }, [text]);
  const q = 4;
  return (
    <svg
      className={className}
      viewBox={`${-q} ${-q} ${path.size + 2 * q} ${path.size + 2 * q}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={-q} y={-q} width={path.size + 2 * q} height={path.size + 2 * q} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
