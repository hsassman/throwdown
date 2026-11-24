export const FIGHTER_OPTIONS = {
  skin: [
    { id: "warm", label: "Warm tan", colour: "#b98a6a" },
    { id: "fair", label: "Fair", colour: "#d1a58f" },
    { id: "olive", label: "Olive", colour: "#a77e56" },
    { id: "brown", label: "Brown", colour: "#865638" },
    { id: "deep", label: "Deep brown", colour: "#613e30" },
  ],
  hair: [
    { id: "buzz", label: "Buzz cut" },
    { id: "crop", label: "Curled crop" },
    { id: "shaved", label: "Shaved" },
  ],
  colour: [
    { id: "red", label: "Oxblood", colour: "#9d1f24" },
    { id: "blue", label: "Royal blue", colour: "#21569b" },
    { id: "gold", label: "Brass", colour: "#b27b29" },
    { id: "green", label: "Forest", colour: "#1f6955" },
    { id: "black", label: "Charcoal", colour: "#333b49" },
  ],
  finish: [
    { id: "classic", label: "Classic leather and satin" },
    { id: "matte", label: "Matte leather and ribbed fabric" },
  ],
} as const;

export type FighterAppearance = {
  [K in keyof typeof FIGHTER_OPTIONS]: (typeof FIGHTER_OPTIONS)[K][number]["id"];
};

export const DEFAULT_APPEARANCE: FighterAppearance = {
  skin: "warm", hair: "buzz", colour: "red", finish: "classic",
};

const key = "shadowbox.fighter.v1";

export function loadFighterAppearance(): FighterAppearance {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return {
      skin: readOption("skin", saved),
      hair: readOption("hair", saved),
      colour: readOption("colour", saved),
      finish: readOption("finish", saved),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function readOption<K extends keyof FighterAppearance>(field: K, saved: unknown): FighterAppearance[K] {
  if (typeof saved !== "object" || saved === null) return DEFAULT_APPEARANCE[field];
  const value = (saved as Record<string, unknown>)[field];
  return FIGHTER_OPTIONS[field].some(option => option.id === value)
    ? value as FighterAppearance[K]
    : DEFAULT_APPEARANCE[field];
}

export function saveFighterAppearance(appearance: FighterAppearance): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(appearance));
    return true;
  } catch {
    return false;
  }
}
