// What the game offers, as one flat list.
// WHY A LIST, AND NOT THE TILE GRID THIS REPLACES
//
// The previous menu was a fighting-game tile grid with nested screens
// (title -> main -> modes -> fighters -> setup). That shape is borrowed from
// games driven by a d-pad and a confirm button, where a grid is fast because
// the thumb moves in two axes at once.
//
// This game's primary input is a HAND IN THE AIR. That changes the arithmetic
// completely:
//
//   * A camera cursor is noisy and tiring to hold. Big targets in ONE axis are
//     far easier to hit than a dense grid in two.
//   * Every confirm costs almost a second of dwell (see pointerModel.ts), so
//     depth is expensive in a way it is not with a button. Four nested screens
//     is four seconds of holding your arm up before the game starts.
//   * A row can carry a title, a blurb and a status badge. A tile can carry a
//     word. When half the list is deliberately not built yet, the menu has to
//     be able to SAY so, and a grid has nowhere to put that.
//
// So: one flat list, tall rows, no nesting. Everything is one confirm away.
// THE HONESTY RULE — carried over from the menu this replaces
//
// Every entry declares what it actually is. Nothing is presented as playable
// that is not, and nothing that IS built is hidden. `availability` is a
// required field rather than an optional flag, and `lockedReason` is required
// in practice on anything locked — a dead row with no explanation is the most
// annoying thing a menu can contain.
//
// This project's own docs have already been bitten once by a status section
// claiming more than the code did. The menu is the most visible possible place
// for that to happen again, so `shellModel.test.ts` enforces it.

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
  tools: "Diagnostics",
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
    blurb: "Lit targets on a free-standing dummy. Scored on accuracy, power and timing.",
    detail:
      "A punching dummy lights one target at a time. Land on it before the window closes. Every punch is scored on how close to the mark it landed, how committed it was, and how fast you answered — and the results are kept, so the drill learns which targets you are weakest on and shows them more often.",
    availability: "ready",
    category: "train",
  },
  {
    id: "freeplay",
    title: "Free Work",
    blurb: "The dummy, no targets, no clock. Warm up and find your range.",
    detail:
      "The same dummy with nothing lit and nothing scored. Useful for checking your framing, finding the distance the game expects you to punch from, and warming up before a scored round.",
    availability: "ready",
    category: "train",
  },
  {
    id: "cpu",
    title: "Fight the CPU",
    blurb: "An opponent that circles, steps in, throws and slips.",
    detail:
      "A full fight against a computer opponent, scored on the ten-point must. It manages range, telegraphs every punch before it can hurt you, and slips or covers up when you throw. It cannot read your intent — it defends the side you have been going to, which is the same information a person in front of you would have.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "stages",
    title: "Stages",
    blurb: "Choose where you fight. Ring or octagon.",
    detail:
      "The venue. A roped boxing ring or a regulation octagon, both built to real measured dimensions rather than eyeballed proportions.",
    availability: "preview",
    category: "fight",
  },
  {
    id: "local",
    title: "Two Players, One Room",
    blurb: "Share a screen. Not built.",
    detail:
      "Two fighters on one machine. This needs a second tracked skeleton from a single camera, which is a different perception problem from the one this project has solved, not an extension of it.",
    availability: "locked",
    lockedReason: "Needs two-person tracking from one camera — not started.",
    category: "fight",
  },
  {
    id: "lan",
    title: "Same Network",
    blurb: "Fight someone on your network. Not built.",
    detail:
      "Peer-to-peer over the local network. This is the first multiplayer milestone in the plan, and it is deliberately gated behind the punch classifier clearing its accuracy bar — networking a detector that misses most punches would just distribute the problem.",
    availability: "locked",
    lockedReason: "Gated behind punch classification clearing Milestone 1.",
    category: "online",
  },
  {
    id: "internet",
    title: "Online",
    blurb: "Ranked fights over the internet. Not built.",
    detail:
      "Internet play with relay fallback. Explicitly after local-network play is validated and feels fair — building relay infrastructure before knowing whether the game is playable at all would be the wrong order.",
    availability: "locked",
    lockedReason: "Comes after same-network play is proven.",
    category: "online",
  },
  {
    id: "career",
    title: "Career",
    blurb: "A run of fights, with progression. Not built.",
    detail:
      "A sequence of opponents with a record that carries between them. Waiting on the fight itself being worth repeating.",
    availability: "locked",
    lockedReason: "Waiting on the CPU fight being finished.",
    category: "fight",
  },
  {
    id: "tracking",
    title: "Tracking",
    blurb: "What the camera sees, and how well. Live diagnosis.",
    detail:
      "The skeleton the camera is reading, the rate it is arriving at, and a continuous assessment of the signal — dropout, jitter, and which landmark is worst. Open this first if anything feels unresponsive.",
    availability: "ready",
    category: "tools",
  },
  {
    id: "punchlab",
    title: "Punch Lab",
    blurb: "Four-way punch classification. Measured at 19% — genuinely unreliable.",
    detail:
      "The experimental classifier that tries to name a punch (jab, cross, hook, uppercut) from a single camera. Its measured detection rate is about 19%, which is why nothing in the game depends on it and why training scores where you landed rather than what you threw. Here so the number stays honest and visible.",
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
    blurb: "Regulation octagon — 30 feet across the flats.",
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
