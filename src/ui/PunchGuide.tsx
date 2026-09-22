import type { PunchType, Stance } from "../perception/punchTypes";
import { leadHand } from "../perception/punchTypes";

// Visual guide showing what each punch should look like and the path the fist
// travels.
//
// This exists for measurement validity, not decoration. The confusion matrix
// compares the punch the player was asked for against the punch the classifier
// reported - so if the player's idea of a hook differs from the classifier's,
// the matrix measures that disagreement rather than the classifier. Showing
// the intended trajectory keeps the labels honest.
//
// The diagram is drawn mirrored, matching the webcam preview: the player sees
// themselves as in a mirror, so their lead hand appears on the same side of
// the diagram as it does on screen.

interface Props {
  type: PunchType;
  stance: Stance;
  compact?: boolean;
}

/** Which side of the mirrored diagram a hand appears on. */
function sideOf(hand: "left" | "right"): "viewerLeft" | "viewerRight" {
  // In a mirrored view your left hand appears on the left of the image.
  return hand === "left" ? "viewerLeft" : "viewerRight";
}

// Figure geometry, in the 0-200 viewBox. Everything below is authored for a
// left-handed punch and mirrored around x=100 for the right, so the two sides
// can never drift out of sync.
const FIG = {
  headY: 38,
  headR: 18,
  shoulderY: 72,
  shoulderX: 62, // left shoulder (viewer left)
  elbowX: 58,
  elbowY: 100,
  fistX: 78,
  fistY: 50,
  hipY: 142,
  hipX: 76,
  footY: 186,
};

interface Trajectory {
  /** Svg path for the fist's travel. */
  path: string;
  /** Where the punch ends, for the impact marker. */
  end: { x: number; y: number };
  /** Radius of the end marker - larger reads as "closer to camera". */
  endRadius: number;
  start: { x: number; y: number };
  cues: string[];
}

function trajectoryFor(type: PunchType, stance: Stance): Trajectory {
  const lead = leadHand(stance);
  const rear = lead === "left" ? "right" : "left";
  const hand = type === "jab" || type === "hook" ? lead : rear;
  const onLeft = sideOf(hand) === "viewerLeft";

  /** Mirror an x coordinate for a right-handed punch. */
  const mx = (x: number) => (onLeft ? x : 200 - x);
  const pt = (x: number, y: number) => ({ x: mx(x), y });

  if (type === "hook") {
    // Swings outward, then sweeps horizontally across the body past the
    // midline. The wide bulge is the whole point - a hook that travels
    // forward instead of across will be classified as a straight punch.
    const start = pt(FIG.fistX, FIG.fistY);
    const end = pt(136, 74);
    return {
      start,
      end,
      endRadius: 12,
      path:
        `M ${mx(FIG.fistX)} ${FIG.fistY} ` +
        `C ${mx(38)} 60, ${mx(46)} 112, ${mx(100)} 104 ` +
        `S ${mx(132)} 90, ${mx(136)} 74`,
      cues: [
        "Elbow bent ~90°, held level with the fist",
        "Swing ACROSS your body horizontally, not forward",
        "Turn your hips and shoulder into it",
      ],
    };
  }

  if (type === "uppercut") {
    // Drops toward the ribs then drives vertically upward.
    const start = pt(88, 124);
    const end = pt(110, 38);
    return {
      start,
      end,
      endRadius: 12,
      path:
        `M ${mx(88)} 124 C ${mx(98)} 102, ${mx(104)} 74, ${mx(110)} 38`,
      cues: [
        "Start low - fist down near your ribs",
        "Drive straight UP, palm toward you",
        "Finish at chin height: vertical, not forward",
      ],
    };
  }

  // Jab and cross travel toward the camera, which barely displaces the fist
  // in a frontal view - it mostly grows larger. The short arrow plus the much
  // larger dashed end marker encodes that, since "punch forward" is the least
  // intuitive thing to convey on a flat diagram.
  const start = pt(FIG.fistX, FIG.fistY);
  const end = pt(64, 84);
  return {
    start,
    end,
    endRadius: 20,
    path: `M ${mx(FIG.fistX)} ${FIG.fistY} L ${mx(66)} 80`,
    cues:
      type === "jab"
        ? [
            "Lead hand, straight out toward the camera",
            "Almost no sideways travel - it comes at the lens",
            "Snap it straight back to guard",
          ]
        : [
            "Rear hand, straight out toward the camera",
            "Rotate your rear hip and shoulder through it",
            "Travels forward, not across your body",
          ],
  };
}

const HAND_LABEL: Record<PunchType, string> = {
  jab: "lead hand",
  cross: "rear hand",
  hook: "lead hand",
  uppercut: "rear hand",
};

export function PunchGuide({ type, stance, compact = false }: Props) {
  const t = trajectoryFor(type, stance);
  const lead = leadHand(stance);
  const hand = type === "jab" || type === "hook" ? lead : lead === "left" ? "right" : "left";

  return (
    <div className={`guide ${compact ? "guide-compact" : ""}`}>
      <svg viewBox="0 0 200 200" className="guide-svg" aria-hidden="true">
        <defs>
          <marker
            id={`arrow-${type}`}
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ade80" />
          </marker>
        </defs>

        {/* Body, drawn faintly - a reference frame, not the subject. Arms are
            drawn as upper arm + forearm so the guard position (elbows down,
            fists up by the cheeks) is unambiguous. */}
        <g stroke="#3d4c63" strokeWidth="3.5" fill="none" strokeLinecap="round">
          <circle cx="100" cy={FIG.headY} r={FIG.headR} />
          <line x1="100" y1={FIG.headY + FIG.headR} x2="100" y2={FIG.shoulderY} />
          <line
            x1={FIG.shoulderX}
            y1={FIG.shoulderY}
            x2={200 - FIG.shoulderX}
            y2={FIG.shoulderY}
          />
          <line x1="100" y1={FIG.shoulderY} x2="100" y2={FIG.hipY} />
          <line x1={FIG.hipX} y1={FIG.hipY} x2={200 - FIG.hipX} y2={FIG.hipY} />
          <line x1={FIG.hipX} y1={FIG.hipY} x2={FIG.hipX - 8} y2={FIG.footY} />
          <line
            x1={200 - FIG.hipX}
            y1={FIG.hipY}
            x2={200 - FIG.hipX + 8}
            y2={FIG.footY}
          />
          {/* Arms: shoulder -> elbow -> fist, both sides. */}
          <polyline
            points={`${FIG.shoulderX},${FIG.shoulderY} ${FIG.elbowX},${FIG.elbowY} ${FIG.fistX},${FIG.fistY}`}
          />
          <polyline
            points={`${200 - FIG.shoulderX},${FIG.shoulderY} ${200 - FIG.elbowX},${FIG.elbowY} ${200 - FIG.fistX},${FIG.fistY}`}
          />
        </g>

        {/* Both fists at guard, so the starting position is unambiguous. */}
        <circle cx={FIG.fistX} cy={FIG.fistY} r="8" fill="#2f3a4d" />
        <circle cx={200 - FIG.fistX} cy={FIG.fistY} r="8" fill="#2f3a4d" />

        {/* The travel path. */}
        <path
          d={t.path}
          stroke="#4ade80"
          strokeWidth="4.5"
          fill="none"
          strokeLinecap="round"
          markerEnd={`url(#arrow-${type})`}
        />

        {/* Start and end of the throwing fist. The end marker is deliberately
            much larger for straight punches: thrown at the lens the fist grows
            in frame rather than moving across it, which is the single least
            intuitive thing about punching at a webcam. */}
        <circle cx={t.start.x} cy={t.start.y} r="8" fill="#4ade80" opacity="0.55" />
        <circle
          cx={t.end.x}
          cy={t.end.y}
          r={t.endRadius}
          fill="none"
          stroke="#4ade80"
          strokeWidth="2.5"
          strokeDasharray="5 4"
        />
      </svg>

      {!compact && (
        <div className="guide-text">
          <div className="guide-hand">
            {HAND_LABEL[type]} ({hand})
          </div>
          <ul className="guide-cues">
            {t.cues.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {compact && <div className="guide-caption">{type}</div>}
    </div>
  );
}

/** All four punches side by side, as a pre-run reference. */
export function PunchGuideGrid({ stance }: { stance: Stance }) {
  const types: PunchType[] = ["jab", "cross", "hook", "uppercut"];
  return (
    <div className="guide-grid">
      {types.map((t) => (
        <PunchGuide key={t} type={t} stance={stance} compact />
      ))}
    </div>
  );
}
