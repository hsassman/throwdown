import { useEffect, useRef, useState } from "react";
import { isMeasured, type TrackingReport } from "../pose/trackingMonitor";
import type { BodyMotion } from "../perception/bodyMotion";
import { MONITOR_CONFIG } from "../config/tuning";
import "./trackingPanel.css";

// The standing assessment of the camera signal, made visible.
// The monitor runs continuously whatever the player is doing, and it already
// decides how hard to filter and how far to predict. Two things follow from
// that, and they are the whole argument for showing it:
//
//   The player needs to be able to see it. "The game feels laggy" and "my
//   webcam is delivering 11 frames a second in a dark room" are the same
//   experience, and only one of them is fixable - by the player, in about
//   thirty seconds, by turning a light on. A score with no explanation would
//   leave them blaming the game.
//
//   The auto-tuner needs to be auditable. It is adjusting the pipeline
//   underneath the player without being asked. Something that quietly changes
//   how the game responds must be able to say what it changed and why, or it
//   is indistinguishable from the game being inconsistent.
// Polled, not subscribed
//
// The report is produced on every pose sample (~15/s). Pushing each one into
// React state would re-render this panel fifteen times a second to move a
// number a human reads once. It is sampled on an interval instead, off a ref.

const POLL_MS = 400;

/**
 * Each metric in its own units.
 *
 * A bare number is close to useless here - 0.0043 means nothing without
 * knowing it is torso units of frame-to-frame shake, and a player reading
 * "rate 14.9" needs the Hz to know whether that is good.
 */
function formatMetric(name: string, value: number): string {
  switch (name) {
    case "rate":
      return `${value.toFixed(1)} Hz`;
    case "dropout":
    case "limbs":
      return `${(value * 100).toFixed(1)}%`;
    case "jitter":
      return value.toFixed(4);
    default:
      return value.toFixed(3);
  }
}

interface Props {
  reportRef: React.RefObject<TrackingReport | null>;
}

export function TrackingPanel({ reportRef }: Props) {
  const [report, setReport] = useState<TrackingReport | null>(null);
  const timer = useRef(0);

  useEffect(() => {
    const id = window.setInterval(() => setReport(reportRef.current), POLL_MS);
    timer.current = id;
    return () => window.clearInterval(id);
  }, [reportRef]);

  if (!report) {
    return <p className="muted small">Waiting for the camera...</p>;
  }

  // "No signal yet" and "a terrible signal" are the same score and completely
  // different facts. Without this the panel greeted anyone who opened it
  // before stepping into frame with a red 0 marked "Poor", which blames the
  // player's webcam for the player not being in front of it.
  if (!isMeasured(report)) {
    return (
      <div className="tpanel">
        <div className="tpanel-score" data-grade="waiting">
          <div className="tpanel-score-value">-</div>
          <div className="tpanel-score-label">
            Tracking quality
            <span>Not measured yet</span>
          </div>
        </div>
        <p className="tpanel-note">
          Step into frame so your head, shoulders and hips are visible. The
          assessment needs {MONITOR_CONFIG.minSamples} samples and has{" "}
          {report.samples}.
        </p>
      </div>
    );
  }

  const grade =
    report.score >= 0.75 ? "good" : report.score >= 0.45 ? "fair" : "poor";

  return (
    <div className="tpanel">
      <div className="tpanel-score" data-grade={grade}>
        <div className="tpanel-score-value">{Math.round(report.score * 100)}</div>
        <div className="tpanel-score-label">
          Tracking quality
          <span>
            {grade === "good"
              ? "Good signal"
              : grade === "fair"
                ? "Usable, not great"
                : "Poor - see below"}
          </span>
        </div>
      </div>

      {/* Every metric, always - including the healthy ones. Showing only
          problems means a player with a perfect signal sees an empty panel and
          cannot tell it from a broken one. */}
      <ul className="tpanel-metrics">
        {report.metrics.map((m) => (
          <li key={m.name}>
            <span className="tpanel-metric-name">{m.name}</span>
            <span className="tpanel-metric-bar">
              <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, m.score))})` }} />
            </span>
            <span className="tpanel-metric-value">{formatMetric(m.name, m.value)}</span>
          </li>
        ))}
      </ul>

      <dl className="tpanel-facts">
        <div>
          <dt>Pose rate</dt>
          <dd>{report.hz.toFixed(1)} Hz</dd>
        </div>
        <div>
          <dt>Dropout</dt>
          <dd>{(report.dropout * 100).toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Jitter</dt>
          <dd>{report.jitter.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Limb drift</dt>
          <dd>{(report.limbVariance * 100).toFixed(1)}%</dd>
        </div>
      </dl>

      {report.worstLandmark && report.worstLandmark.dropout > 0.02 && (
        // Named, not aggregated. "12% dropout" hides "the right wrist is
        // invisible half the time", and only the second is actionable.
        <p className="tpanel-worst">
          Weakest landmark: <strong>{report.worstLandmark.key}</strong>, missing{" "}
          {(report.worstLandmark.dropout * 100).toFixed(0)}% of frames.
        </p>
      )}

      {report.advice.length > 0 ? (
        <ul className="tpanel-advice">
          {report.advice.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      ) : (
        <p className="tpanel-ok">Nothing to fix. The signal is healthy.</p>
      )}

      <p className="tpanel-note">
        Measured over the last {report.samples} samples. Smoothing and
        prediction are adjusted automatically from this; nothing that decides
        whether a punch landed is.
      </p>
    </div>
  );
}

/**
 * The whole-body channels, live.
 *
 * Shown wherever the character is on screen, because these are the numbers a
 * player can verify with their own body in about two seconds - step forward
 * and `depth` should rise, crouch and `crouch` should fill, blade and `turn`
 * should open. A channel that is silently dead is otherwise indistinguishable
 * from one the player is not moving enough to trigger.
 */
export function BodyChannels({ body }: { body: BodyMotion }) {
  if (!body.tracked) {
    return <p className="muted small">Body not tracked - step into frame.</p>;
  }
  const rows: { label: string; value: number; unit: string; range: number }[] = [
    { label: "Slip", value: body.lateral, unit: "torso", range: 0.7 },
    { label: "Rise", value: body.vertical, unit: "torso", range: 0.7 },
    { label: "Step", value: body.depth, unit: "torso", range: 0.8 },
    { label: "Turn", value: (body.turn * 180) / Math.PI, unit: "deg", range: 50 },
    { label: "Crouch", value: body.crouch, unit: "", range: 1 },
  ];
  return (
    <div className="tpanel bchan">
      <div className="bchan-title">Body channels</div>
      <ul className="bchan-list">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="bchan-name">{r.label}</span>
            {/* A CENTRED bar, because four of these five are signed and a
                left-anchored bar cannot show a negative at all. */}
            <span className="bchan-bar">
              <i
                style={{
                  transform: `scaleX(${Math.min(1, Math.abs(r.value) / r.range)})`,
                  transformOrigin: r.value < 0 ? "right center" : "left center",
                  left: r.value < 0 ? 0 : "50%",
                  right: r.value < 0 ? "50%" : 0,
                }}
              />
            </span>
            <span className="bchan-value">
              {r.value >= 0 ? "+" : ""}
              {r.value.toFixed(r.unit === "deg" ? 0 : 2)}
              {r.unit ? ` ${r.unit}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
