import { useEffect, useState } from "react";
import type { ClassifierDiagnostics } from "../perception/punchClassifier";
import { PERCEPTION_CONFIG as C } from "../config/tuning";

// Why punches are being rejected, answerable in a 60-second session rather than
// another five-minute measured run. The "peak seen" row is the key one: it
// reports the highest value each signal reached regardless of detection, so a
// peak stuck below its gate means the gate is unreachable, not merely strict.

interface Props {
  diagnosticsRef: React.RefObject<ClassifierDiagnostics | null>;
  onReset: () => void;
}

export function DetectionDiagnostics({ diagnosticsRef, onReset }: Props) {
  const [d, setD] = useState<ClassifierDiagnostics | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      const cur = diagnosticsRef.current;
      setD((prev) => {
        // Skip the update when no punch has been attempted since last poll.
        // Cloning and setting state unconditionally re-rendered this panel and
        // its tables four times a second while nothing was happening, on a
        // main thread already short of time for pose inference.
        if (!cur) return prev === null ? prev : null;
        if (
          prev &&
          prev.launches === cur.launches &&
          prev.detections === cur.detections &&
          prev.rejections === cur.rejections
        ) {
          return prev;
        }
        return { ...cur, recent: [...cur.recent] };
      });
    }, 250);
    return () => clearInterval(id);
  }, [diagnosticsRef]);

  if (!d) return null;

  const attempts = d.detections + d.rejections;
  const rate = attempts > 0 ? (d.detections / attempts) * 100 : 0;

  const gate = (label: string, seen: number, need: number, unit = "") => {
    const reachable = seen >= need;
    return (
      <tr>
        <td className={reachable ? "muted" : "bad"}>{reachable ? "ok" : "LOW"}</td>
        <td className="muted">{label}</td>
        <td>
          {seen.toFixed(2)}
          {unit} / {need}
          {unit}
        </td>
      </tr>
    );
  };

  return (
    <div className="dodge">
      <div className="dodge-head">
        <span>detection diagnostics</span>
        <button className="mini" onClick={onReset}>
          reset
        </button>
      </div>

      <div className="muted small">
        launched {d.launches} · detected {d.detections} · rejected {d.rejections}
        {attempts > 0 ? ` · ${rate.toFixed(0)}% pass` : ""}
      </div>

      <div className="hud-label" style={{ marginTop: "0.5rem" }}>
        peak values seen vs gate
      </div>
      <div className="muted small">
        Excursion is how far the fist travels from its calibrated guard. If
        these stay below the gate while you punch hard, the threshold is
        unreachable rather than strict. The excursion gate shown is the
        EFFECTIVE one — it rises above the configured {C.minPunchExcursion} when
        your measured guard jitter demands it.
      </div>
      <table className="features">
        <tbody>
          {gate("L excursion", d.peakSeen.left.excursion, d.excursionGate.left)}
          {gate("R excursion", d.peakSeen.right.excursion, d.excursionGate.right)}
          {/* Mean, not instantaneous peak: minMeanSpeed gates the mean, and the
              peak clears it almost always, which would mask a real failure. */}
          {gate("L mean speed", d.peakSeen.left.meanSpeed, C.minMeanSpeed)}
          {gate("R mean speed", d.peakSeen.right.meanSpeed, C.minMeanSpeed)}
        </tbody>
      </table>

      {Object.keys(d.byReason).length > 0 && (
        <>
          <div className="hud-label">rejections by gate</div>
          <table className="features">
            <tbody>
              {Object.entries(d.byReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => (
                  <tr key={reason}>
                    <td className="bad">{n}</td>
                    <td className="muted" colSpan={2}>
                      {reason}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}

      {d.recent.length > 0 && (
        <>
          <div className="hud-label">most recent rejections</div>
          <div className="log">
            {d.recent.map((r, i) => (
              <div key={`${r.at}-${i}`} className="log-row">
                <span className="log-type">{r.hand}</span>
                <span className="muted">{r.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
