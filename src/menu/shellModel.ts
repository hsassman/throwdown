// What the game offers, as one flat list. Big targets, one confirm to enter
// anything: the main input is a hand held in the air.

export type Availability = "ready" | "preview" | "locked";

export type ShellCategory = "fight" | "online" | "train" | "tools";

export interface ShellItem {
  id: string;
  title: string;
  /** One line, shown on the card. */
  blurb: string;
  /** Shown when focused. */
  detail: string;
  availability: Availability;
  category: ShellCategory;
  lockedReason?: string;
}

export const CATEGORY_LABEL: Record<ShellCategory, string> = {
  fight: "Fight",
  online: "Online",
  train: "Train",
  tools: "Settings",
};

export const SHELL_ITEMS: ShellItem[] = [
  {
    id: "cpu",
    title: "Fight",
    blurb: "Three rounds against a CPU opponent.",
    detail: "A scored bout in first person. Watch for the opponent drawing back before they punch. Press V for the third-person camera.",
    availability: "ready",
    category: "fight",
  },
  {
    id: "career",
    title: "Career",
    blurb: "Work through four opponents in order.",
    detail: "Win to advance. A draw or loss means a rematch. Your record is saved on this device.",
    availability: "ready",
    category: "fight",
  },
  {
    id: "fighter",
    title: "Your Fighter",
    blurb: "Change your fighter's look and kit.",
    detail: "Choose skin tone, hair, kit colour and material. Saved for every fight and training session.",
    availability: "ready",
    category: "fight",
  },
  {
    id: "stages",
    title: "Venue",
    blurb: "Choose the ring or the cage.",
    detail: "Drag to look around. The venue you pick is used for every fight.",
    availability: "ready",
    category: "fight",
  },
  {
    id: "internet",
    title: "Online",
    blurb: "Find an opponent over the internet.",
    detail: "Matchmaking pairs you with the next player in the queue. Some networks may prevent the fight from connecting. Your opponent receives your movements, never your video.",
    availability: "preview",
    category: "online",
  },
  {
    id: "lan",
    title: "Play a Friend",
    blurb: "Private match with a friend, by code.",
    detail: "Send your host code and paste your friend's reply. Works best on the same network. The guest may see a slight delay. Your friend receives your movements, never your video.",
    availability: "preview",
    category: "online",
  },
  {
    id: "dummy",
    title: "Training",
    blurb: "Hit the lit targets before time runs out.",
    detail: "Your score combines accuracy, power and timing. Later rounds give you more practice on the targets you miss.",
    availability: "ready",
    category: "train",
  },
  {
    id: "tracking",
    title: "Camera Check",
    blurb: "See what the camera can see.",
    detail: "Shows which parts of your body the camera is losing, with tips to fix your setup.",
    availability: "ready",
    category: "tools",
  },
];

/** A stage is a place, not a mode. */
export interface StageItem {
  id: string;
  title: string;
  blurb: string;
  availability: Availability;
  lockedReason?: string;
}

export const STAGES: StageItem[] = [
  { id: "octagon", title: "The Cage", blurb: "Regulation octagon, 30 feet across the flats.", availability: "ready" },
  { id: "ring", title: "The Ring", blurb: "Roped boxing ring, four corner posts.", availability: "ready" },
  { id: "gym", title: "The Gym", blurb: "Bare floor. No venue.", availability: "ready" },
];

export const ITEM_BY_ID: ReadonlyMap<string, ShellItem> = new Map(SHELL_ITEMS.map((i) => [i.id, i]));

const ORDER: ShellCategory[] = ["fight", "online", "train", "tools"];

/** Items grouped in display order. */
export function grouped(): { category: ShellCategory; items: ShellItem[] }[] {
  return ORDER.map((category) => ({ category, items: SHELL_ITEMS.filter((i) => i.category === category) })).filter(
    (g) => g.items.length > 0
  );
}

export function isPlayable(item: ShellItem): boolean {
  return item.availability !== "locked";
}
