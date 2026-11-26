// What the game offers, as one flat list.
//
// The previous menu was a fighting-game tile grid with nested screens. That
// shape suits a d-pad and a confirm button. This game's primary input is a
// hand in the air, which changes the arithmetic: a camera cursor is noisy and
// tiring to hold, so big targets in one axis beat a dense grid in two; every
// confirm costs almost a second of dwell (see pointerModel.ts), so four nested
// screens is four seconds of holding your arm up before the game starts; and a
// row can carry a title, a blurb and a status badge where a tile carries a
// word.
//
// So: one flat list, tall rows, no nesting, everything one confirm away.
//
// The honesty rule. Every entry declares what it actually is. Nothing is
// presented as playable that is not, and nothing built is hidden.
// `availability` is required rather than optional, and anything locked needs a
// `lockedReason` - a dead row with no explanation is the most annoying thing a
// menu can contain. shellModel.test.ts enforces both.

export type Availability =
  /** Built, tested, reachable now. */
  | "ready"
  /** Reachable, and it will be rough. Say so rather than hiding it. */
  | "preview"
  /** Deliberately not built. Shown so the shape of the game is legible. */
  | "locked";

export type ShellCategory = "train" | "fight" | "online" | "tools";

export interface ShellItem {
  id: string;
  title: string;
  /** One line, shown on the row itself. */
  blurb: string;
  /** A paragraph, shown in the detail panel when focused. */
  detail: string;
  availability: Availability;
  category: ShellCategory;
  /** Required on anything locked. */
  lockedReason?: string;
}

export const CATEGORY_LABEL: Record<ShellCategory, string> = {
  train: "Train",
  fight: "Fight",
  online: "Online",
  tools: "Camera tools",
};

/**
 * The modes.
 *
 * Ordered by what a player most likely wants, not by how finished it is.
 * Training is first because it is the mode that actually works end to end and
 * it is where a new player learns the reach the game expects.
 */
export const SHELL_ITEMS: ShellItem[] = [
  {
    id: "dummy",
    title: "Dummy Work",
    blurb: "Hit the lit targets before time runs out.",
    detail: "Your score combines accuracy, power and timing. Later rounds give you more practice on the targets you miss.",
    availability: "ready",
    category: "train",
  },
  {
    id: "freeplay",
    title: "Free Work",
    blurb: "Warm up on the dummy at your own pace.",
    detail: "Use the dummy to find your range. There are no timed targets or scores.",
    availability: "ready",
    category: "train",
  },
  {
    id: "fighter",
    title: "Your Fighter",
    blurb: "Change your fighter’s appearance and kit.",
    detail: "Choose a skin tone, hairstyle, kit colour and material. Save your choices for the next fight or training session.",
    availability: "ready",
    category: "fight",
  },
  {
    id: "cpu",
    title: "Fight the CPU",
    blurb: "Box against a computer opponent.",
    detail: "Fight a scored bout. Watch for the opponent to draw back before they punch.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "fps",
    title: "FPS Mode",
    blurb: "Fight the CPU from behind your own eyes.",
    detail:
      "The same bout as Fight the CPU, seen from just behind your fighter's head. Your fighter is see-through, so the opponent is always in view through your own gloves and body.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "stages",
    title: "Stages",
    blurb: "Choose the ring or the cage.",
    detail: "Drag to look around. Your selected venue is used for the next bout.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "local",
    title: "Two Players, One Room",
    blurb: "Box with a friend using one camera.",
    detail: "To box with a friend on two devices, choose Same Network.",
    availability: "locked",
    category: "fight",
    lockedReason: "Same-screen play is unavailable.",
  },
  {
    id: "lan",
    title: "Same Network",
    blurb: "Box with a friend on the same network.",
    detail: "Send a host code and paste your friend’s reply to start. The guest may see a slight delay. Your friend receives your fighter’s movements.",
    availability: "preview",
    category: "online",
  },
  {
    id: "internet",
    title: "Online",
    blurb: "Find an opponent over the internet.",
    detail: "Matchmaking needs a game server. Some networks may prevent the fight from connecting. Your opponent receives your fighter’s movements.",
    availability: "preview",
    category: "online",
  },
  {
    id: "career",
    title: "Career",
    blurb: "Face four opponents in order.",
    detail: "Win to advance. A draw or loss means a rematch. Your record is saved on this device.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "tracking",
    title: "Tracking",
    blurb: "Check what the camera can see.",
    detail: "See which parts of your body the camera is losing and get tips to fix your setup.",
    availability: "ready",
    category: "tools",
  },
  {
    id: "phonecam",
    title: "Phone Camera",
    blurb: "Connect your phone as a second camera.",
    detail: "Scan a code with your phone and place it to your side. For now this measures the connection and does not change the fight. Your phone sends your movements, never video.",
    availability: "preview",
    category: "tools",
  },
  {
    id: "punchlab",
    title: "Punch Lab",
    blurb: "Try the experimental punch reader.",
    detail: "It identifies jabs, crosses, hooks and uppercuts. It recognised 19% in testing. Fight scoring is separate.",
    availability: "preview",
    category: "tools",
  },
];

/** The stages. A separate list because a stage is a place, not a mode. */
export interface StageItem {
  id: string;
  title: string;
  blurb: string;
  availability: Availability;
  lockedReason?: string;
}

export const STAGES: StageItem[] = [
  {
    id: "octagon",
    title: "The Cage",
    blurb: "Regulation octagon - 30 feet across the flats.",
    availability: "preview",
  },
  {
    id: "ring",
    title: "The Ring",
    blurb: "Roped boxing ring, four corner posts.",
    availability: "preview",
  },
  {
    id: "gym",
    title: "The Gym",
    blurb: "Bare floor. No venue.",
    availability: "ready",
  },
];

export const ITEM_BY_ID: ReadonlyMap<string, ShellItem> = new Map(
  SHELL_ITEMS.map((i) => [i.id, i])
);

/** Items grouped in display order, categories preserved. */
export function grouped(): { category: ShellCategory; items: ShellItem[] }[] {
  const order: ShellCategory[] = ["train", "fight", "online", "tools"];
  return order
    .map((category) => ({
      category,
      items: SHELL_ITEMS.filter((i) => i.category === category),
    }))
    .filter((g) => g.items.length > 0);
}

/** Whether an item can actually be entered. */
export function isPlayable(item: ShellItem): boolean {
  return item.availability !== "locked";
}
