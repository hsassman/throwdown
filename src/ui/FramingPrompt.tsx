import { FRAMING_ADVICE, type FramingIssue } from "../perception/framingCheck";
import "./framingPrompt.css";

/**
 * The framing coach's prompt: one short instruction in the bottom-left corner,
 * small enough not to cover the fight. It says what to do rather than what is
 * wrong.
 */
export function FramingPrompt({ issue }: { issue: FramingIssue | null }) {
  if (!issue) return null;
  return (
    <div className="framing-prompt" role="status" aria-live="polite">
      {FRAMING_ADVICE[issue]}
    </div>
  );
}
