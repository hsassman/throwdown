import { STAGES } from "../menu/shellModel";
import type { StageId } from "../render/ArenaView";
import "./venuePicker.css";

const VENUES = STAGES.filter((venue) => venue.id === "ring" || venue.id === "octagon");

export function VenuePicker({ stage, onSelect }: { stage: StageId; onSelect: (stage: StageId) => void }) {
  return (
    <div className="stage-picker" role="group" aria-label="Venue">
      <p className="stage-picker-hint">Drag the arena to rotate the preview</p>
      {VENUES.map((venue) => {
        const selected = stage === venue.id;
        return (
          <button key={venue.id} type="button" className="stage-btn"
            aria-label={venue.title} aria-pressed={selected} onClick={() => onSelect(venue.id as StageId)}>
            <img src={venue.id === "ring" ? "/ui/venue.webp" : "/ui/cage.webp"} alt="" />
            <span className="stage-btn-copy">
              {selected && <span className="stage-btn-current" aria-hidden="true">Selected</span>}
              <strong>{venue.title}</strong>
              <span>{venue.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
