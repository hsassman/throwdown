import { useState } from "react";
import {
  DEFAULT_APPEARANCE, FIGHTER_OPTIONS, type FighterAppearance,
} from "../menu/fighterAppearance";
import "./fighterPanel.css";

const LABELS = {
  skin: "Skin tone", hair: "Hairstyle", colour: "Kit colour", finish: "Kit material",
} as const;
type Field = keyof FighterAppearance;

export function FighterPanel({ appearance, onChange, onSave }: {
  appearance: FighterAppearance;
  onChange: (appearance: FighterAppearance) => void;
  onSave: () => boolean;
}) {
  const [notice, setNotice] = useState("");
  const change = (next: FighterAppearance) => {
    onChange(next);
    setNotice("");
  };
  return (
    <section className="fighter-panel" aria-label="Fighter appearance">
      {(Object.keys(LABELS) as Field[]).map(field => (
        <fieldset key={field}>
          <legend>{LABELS[field]}</legend>
          <div className="fighter-options">
            {FIGHTER_OPTIONS[field].map(option => (
              <label key={option.id} className="fighter-option">
                <input
                  type="radio"
                  name={field}
                  value={option.id}
                  checked={appearance[field] === option.id}
                  onChange={() => change({ ...appearance, [field]: option.id })}
                />
                {"colour" in option && <span className="fighter-swatch" style={{ backgroundColor: option.colour }} />}
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="fighter-actions">
        <button type="button" className="fighter-save" onClick={() => setNotice(
          onSave() ? "Fighter saved on this device." : "Fighter applied for this session. Browser storage is unavailable."
        )}>Save fighter</button>
        <button type="button" className="fighter-reset" onClick={() => change(DEFAULT_APPEARANCE)}>Reset</button>
      </div>
      {notice && <p className="fighter-notice" role="status">{notice}</p>}
    </section>
  );
}
