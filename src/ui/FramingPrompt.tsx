import { FRAMING_ADVICE, type FramingIssue } from "../perception/framingCheck";
import "./framingPrompt.css";

/**
 * The framing coach's prompt: one instruction, large, at the top of the view.
 * Read from across a room, by someone mid-punch, so it is short and says what
 * to do rather than what is wrong.
 */
export function FramingPrompt({ issue }: { issue: FramingIssue | null }) {
  if (!issue) return null;
  return (
    <div className="framing-prompt" role="status" aria-live="polite">
      {FRAMING_ADVICE[issue]}
    </div>
  );
}
