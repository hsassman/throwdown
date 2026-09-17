// Settings, as DATA. The screen is generated from this rather than hand-built,
// so adding an option is one entry here and nothing in the UI.
//
// The grouping follows the genre: tracking/input first (it is what breaks),
// gameplay second, then presentation, then accessibility as a first-class tab
// rather than three checkboxes buried in video.
//
// Everything that mirrors an existing tuning constant says so in its `note`,
// because the values in config/tuning.ts were measured or derived and a player
// dragging a slider past them should know they are leaving calibrated ground.

export type SettingKind = "toggle" | "choice" | "slider";

interface Base {
  id: string;
  label: string;
  note?: string;
  /** Not yet wired to anything. Shown, disabled, and honest about it. */
  pending?: boolean;
}

export interface ToggleSetting extends Base {
  kind: "toggle";
  value: boolean;
}

export interface ChoiceSetting extends Base {
  kind: "choice";
  value: string;
  options: { value: string; label: string }[];
}

export interface SliderSetting extends Base {
  kind: "slider";
  value: number;
  min: number;
  max: number;
  step: number;
  /** Rendered after the number. */
  unit?: string;
}

export type Setting = ToggleSetting | ChoiceSetting | SliderSetting;

export interface SettingsTab {
  id: string;
  label: string;
  settings: Setting[];
}

export function defaultSettings(): SettingsTab[] {
  return [
    {
      id: "tracking",
      label: "Camera & Tracking",
      settings: [
        {
          kind: "choice",
          id: "delegate",
          label: "Inference backend",
          value: "auto",
          options: [
            { value: "auto", label: "Auto (GPU, CPU fallback)" },
            { value: "gpu", label: "Force GPU" },
            { value: "cpu", label: "Force CPU" },
          ],
          note: "GPU vs CPU has never actually been measured on this machine. Auto is the shipped default.",
        },
        {
          kind: "choice",
          id: "model",
          label: "Pose model",
          value: "lite",
          options: [
            { value: "lite", label: "Lite — fastest" },
            { value: "full", label: "Full — better landmarks" },
            { value: "heavy", label: "Heavy — slowest" },
          ],
          note: "Lite caps at about 28 FPS here. Step up only if landmark quality is the limit, not frame rate.",
        },
        {
          kind: "choice",
          id: "capture",
          label: "Capture resolution",
          value: "640x480",
          options: [
            { value: "320x240", label: "320 x 240" },
            { value: "640x480", label: "640 x 480" },
            { value: "1280x720", label: "1280 x 720" },
          ],
        },
        {
          kind: "slider",
          id: "captureFps",
          label: "Capture frame rate",
          value: 60,
          min: 30,
          max: 60,
          step: 30,
          unit: "fps",
          note: "Inference waits for a whole camera frame, so capture rate sets the ceiling on pose rate.",
        },
        {
          kind: "toggle",
          id: "overlay",
          label: "Show skeleton overlay",
          value: true,
        },
        {
          kind: "toggle",
          id: "mirror",
          label: "Mirror camera preview",
          value: true,
          note: "Preview only. Never changes which hand drives which arm.",
        },
      ],
    },
    {
      id: "gameplay",
      label: "Gameplay",
      settings: [
        {
          kind: "choice",
          id: "view",
          label: "Camera view",
          value: "behind",
          options: [
            { value: "behind", label: "Behind — standard fighting view" },
            { value: "facing", label: "Facing — mirror view" },
          ],
          note: "This also sets which of your arms drives which of the character's. The two cannot be changed apart.",
        },
        {
          kind: "slider",
          id: "reach",
          label: "Punch sensitivity",
          value: 0.95,
          min: 0.7,
          max: 1.2,
          step: 0.05,
          note: "How far you must extend for a strike to land. Lower is more forgiving. 0.95 is the tuned default.",
        },
        {
          kind: "slider",
          id: "damageScale",
          label: "Damage scale",
          value: 1,
          min: 0.25,
          max: 2,
          step: 0.25,
          unit: "x",
        },
        {
          kind: "toggle",
          id: "fouls",
          label: "Enforce low blows",
          value: true,
          note: "Strikes below the belt score nothing and cost a point.",
        },
        {
          kind: "toggle",
          id: "autoRecentre",
          label: "Auto-recentre",
          value: true,
          note: "Re-anchors the character on where you are standing if you drift.",
        },
      ],
    },
    {
      id: "video",
      label: "Video",
      settings: [
        {
          kind: "choice",
          id: "quality",
          label: "Render quality",
          value: "auto",
          options: [
            { value: "low", label: "Low" },
            { value: "auto", label: "Adaptive" },
            { value: "high", label: "High" },
          ],
          note: "The 3D view competes with pose inference for the same GPU. Adaptive drops resolution under load.",
        },
        { kind: "toggle", id: "shadows", label: "Shadows", value: true },
        {
          kind: "toggle",
          id: "atmosphere",
          label: "Arena haze",
          value: true,
          note: "Fog that makes the far side of the cage fall into darkness.",
        },
        {
          kind: "slider",
          id: "exposure",
          label: "Exposure",
          value: 1.15,
          min: 0.6,
          max: 1.8,
          step: 0.05,
        },
      ],
    },
    {
      id: "audio",
      label: "Audio",
      settings: [
        {
          kind: "slider",
          id: "master",
          label: "Master",
          value: 80,
          min: 0,
          max: 100,
          step: 5,
          unit: "%",
          pending: true,
        },
        {
          kind: "slider",
          id: "sfx",
          label: "Impacts",
          value: 90,
          min: 0,
          max: 100,
          step: 5,
          unit: "%",
          pending: true,
        },
        {
          kind: "slider",
          id: "crowd",
          label: "Crowd",
          value: 60,
          min: 0,
          max: 100,
          step: 5,
          unit: "%",
          pending: true,
        },
        {
          kind: "slider",
          id: "music",
          label: "Music",
          value: 50,
          min: 0,
          max: 100,
          step: 5,
          unit: "%",
          pending: true,
        },
      ],
    },
    {
      id: "access",
      label: "Accessibility",
      settings: [
        {
          kind: "toggle",
          id: "reducedMotion",
          label: "Reduced motion",
          value: false,
          note: "Stops camera drift and menu transitions. Follows your system setting by default.",
        },
        {
          kind: "toggle",
          id: "highContrast",
          label: "High contrast UI",
          value: false,
        },
        {
          kind: "choice",
          id: "textSize",
          label: "Interface text size",
          value: "normal",
          options: [
            { value: "normal", label: "Normal" },
            { value: "large", label: "Large" },
            { value: "xlarge", label: "Extra large" },
          ],
        },
        {
          kind: "toggle",
          id: "seatedMode",
          label: "Seated play",
          value: false,
          note: "Measures everything from the shoulders up, so the legs never need to be in frame.",
        },
        {
          kind: "toggle",
          id: "oneArm",
          label: "Single-arm mode",
          value: false,
          note: "Resolves strikes from one arm only. The other is never required to be tracked.",
        },
        {
          kind: "toggle",
          id: "flashReduction",
          label: "Reduce impact flashes",
          value: false,
        },
        {
          kind: "toggle",
          id: "captions",
          label: "Captions",
          value: false,
          pending: true,
        },
      ],
    },
  ];
}

/** Applies a stepper press to one setting, returning the new value. */
export function stepSetting(setting: Setting, delta: -1 | 1): Setting {
  switch (setting.kind) {
    case "toggle":
      return { ...setting, value: !setting.value };
    case "slider": {
      // Rounded against the step to kill floating-point drift — without it,
      // 0.95 - 0.05 + 0.05 stops equalling 0.95 and the label grows a tail of
      // nines after a few presses.
      const raw = setting.value + delta * setting.step;
      const snapped = Math.round(raw / setting.step) * setting.step;
      const clamped = Math.min(setting.max, Math.max(setting.min, snapped));
      return { ...setting, value: Number(clamped.toFixed(4)) };
    }
    case "choice": {
      const i = setting.options.findIndex((o) => o.value === setting.value);
      const next =
        (((i === -1 ? 0 : i) + delta) % setting.options.length +
          setting.options.length) %
        setting.options.length;
      return { ...setting, value: setting.options[next].value };
    }
  }
}

export function formatSetting(setting: Setting): string {
  switch (setting.kind) {
    case "toggle":
      return setting.value ? "On" : "Off";
    case "slider":
      return `${setting.value}${setting.unit ? ` ${setting.unit}` : ""}`;
    case "choice":
      return (
        setting.options.find((o) => o.value === setting.value)?.label ??
        setting.value
      );
  }
}
