import type { SystemReport } from "../diag/systemMonitor";
import { isMeasured } from "../pose/trackingMonitor";
import "./systemPanel.css";

// The aggregate view: pose tracking, frame delivery, strike resolution and
// the drill, in one glance.
//
// TrackingPanel already answers "is the camera signal good" in detail. This
// answers a different question - "is the whole pipeline keeping up" - and
// each section here is a one-line summary, not a re-statement of what
// TrackingPanel already shows in full. A section that has not reported
// anything yet is shown as idle, not as failing; see systemMonitor.ts on why
// that distinction matters.

function grade(score: number): "good" | "fair" | "poor" {
  return score >= 0.75 ? "good" : score >= 0.45 ? "fair" : "poor";
}

interface Props {
  reportRef: React.RefObject<SystemReport | null>;
}

export function SystemPanel({ reportRef }: Props) {
  const report = reportRef.current;

  if (!report) {
    return (
      <div className="spanel">
        <div className="spanel-title">System</div>
        <p className="muted small">Warming up...</p>
      </div>
    );
  }

  return (
    <div className="spanel">
      <div className="spanel-title">
        System
        {report.score !== null && (
          <span className={`spanel-badge spanel-${grade(report.score)}`}>
            {Math.round(report.score * 100)}
          </span>
        )}
      </div>

      <ul className="spanel-sections">
        <li>
          <span className="spanel-name">Pose</span>
          {report.tracking && isMeasured(report.tracking) ? (
            <span className={`spanel-value spanel-${grade(report.tracking.score)}`}>
              {Math.round(report.tracking.score * 100)} · {report.tracking.hz.toFixed(1)} Hz
            </span>
          ) : (
            <span className="spanel-value spanel-idle">not measured yet</span>
          )}
        </li>

        <li>
          <span className="spanel-name">Frame</span>
          {report.frame ? (
            <span className={`spanel-value spanel-${grade(report.frame.score)}`}>
              {report.frame.hz.toFixed(1)} Hz · {report.frame.inferenceMs.toFixed(0)}ms infer
            </span>
          ) : (
            <span className="spanel-value spanel-idle">not measured yet</span>
          )}
        </li>

        <li>
          <span className="spanel-name">Strikes</span>
          {report.strike ? (
            <span className="spanel-value">
              {report.strike.resolved} in window
              {report.strike.fouls > 0 && ` · ${report.strike.fouls} foul${report.strike.fouls === 1 ? "" : "s"}`}
              {report.strike.sinceLastMs !== null &&
                ` · last ${(report.strike.sinceLastMs / 1000).toFixed(1)}s ago`}
            </span>
          ) : (
            <span className="spanel-value spanel-idle">none yet</span>
          )}
        </li>

        <li>
          <span className="spanel-name">Drill</span>
          {report.drill ? (
            <span className="spanel-value">
              {report.drill.landed}/{report.drill.presented} landed · streak{" "}
              {report.drill.streak}
            </span>
          ) : (
            <span className="spanel-value spanel-idle">not running</span>
          )}
        </li>
      </ul>

      {report.advice.length > 0 && (
        <ul className="spanel-advice">
          {report.advice.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
