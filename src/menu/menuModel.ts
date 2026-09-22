// The front end's data model: what screens exist, what is on them, and what is
// actually playable today.
//
// The shape follows what the genre has converged on. Mortal Kombat and
// Injustice: a flat tile grid of modes, fighter select with a live stat panel,
// destructive choices confirmed on the screen they are made. WWE 2K: match
// setup as a separate step after the participants, carrying rules, because one
// roster feeds a dozen match types - this project has the same split coming so
// the step exists now. Tekken and Street Fighter: online as its own branch,
// because folding it into exhibition confuses both flows.
//
// The convention they share, and the one that matters most: the player is
// never more than two presses from a fight.
//
// Honesty rule. Every entry carries an explicit availability. Nothing is
// presented as playable that is not, and nothing built is hidden. It is a
// required field rather than a flag someone can forget.

export type Availability =
  /** Built, tested, reachable now. */
  | "ready"
  /** Reachable but incomplete - it will run and it will be rough. */
  | "preview"
  /** Deliberately not built yet. Shown so the shape of the game is legible. */
  | "locked";

export interface MenuItem {
  id: string;
  label: string;
  /** One line, shown in the side panel when focused. */
  blurb: string;
  availability: Availability;
  /** Screen to go to. Absent for items that act rather than navigate. */
  goto?: ScreenId;
  /** Why it is locked. Shown instead of letting the player press a dead tile,
   *  which is the single most annoying thing a menu can do. */
  lockedReason?: string;
}

export type ScreenId =
  | "title"
  | "main"
  | "modes"
  | "online"
  | "fighters"
  | "arenas"
  | "setup"
  | "training"
  | "settings";

// --- Roster ---------------------------------------------------------------

export type WeightClass =
  | "flyweight"
  | "bantamweight"
  | "featherweight"
  | "lightweight"
  | "welterweight"
  | "middleweight"
  | "lightheavy"
  | "heavyweight";

/** Upper bound of each class, kg. Standard commission limits. */
export const WEIGHT_LIMITS: Record<WeightClass, number> = {
  flyweight: 56.7,
  bantamweight: 61.2,
  featherweight: 65.8,
  lightweight: 70.3,
  welterweight: 77.1,
  middleweight: 83.9,
  lightheavy: 93.0,
  heavyweight: 120.2,
};

export interface Fighter {
  id: string;
  name: string;
  weightClass: WeightClass;
  /** Orthodox leads with the left hand. Drives which hand is jab vs cross. */
  stance: "orthodox" | "southpaw";
  /** 1-10, for the stat bars. Cosmetic until the sim layer reads them. */
  stats: { power: number; speed: number; chin: number; stamina: number };
  availability: Availability;
  blurb: string;
  /** Required in practice on a locked entry - a dead tile with no explanation
   *  is the most annoying thing a menu can contain. */
  lockedReason?: string;
}

/**
 * The roster.
 *
 * There is exactly one character mesh in this project, so exactly one entry is
 * `ready`. The rest are shown as locked slots rather than being invented,
 * because a grid of eight selectable fighters that are all the same model with
 * different names would be a lie told by the menu about the game.
 *
 * They are laid out by weight class because that is the customisation axis
 * already planned, and it is the axis that changes the simulation (reach,
 * mass, speed) rather than only the skin.
 */
export const ROSTER: Fighter[] = [
  {
    id: "default",
    name: "The Boxer",
    weightClass: "middleweight",
    stance: "orthodox",
    stats: { power: 6, speed: 6, chin: 6, stamina: 6 },
    availability: "ready",
    blurb: "The exported MHR figure. Baseline for every measurement so far.",
  },
  {
    id: "southpaw",
    name: "Southpaw",
    weightClass: "middleweight",
    stance: "southpaw",
    stats: { power: 6, speed: 7, chin: 5, stamina: 6 },
    availability: "preview",
    blurb: "Same mesh, mirrored stance. Swaps which hand jabs.",
  },
  {
    id: "lightweight",
    name: "Lightweight",
    weightClass: "lightweight",
    stance: "orthodox",
    stats: { power: 4, speed: 9, chin: 5, stamina: 8 },
    availability: "locked",
    blurb: "Faster, shorter reach, less power.",
    lockedReason: "Needs the body-morph path (see the customisation notes).",
  },
  {
    id: "heavyweight",
    name: "Heavyweight",
    weightClass: "heavyweight",
    stance: "orthodox",
    stats: { power: 9, speed: 4, chin: 8, stamina: 4 },
    availability: "locked",
    blurb: "Longer reach, heavier hands, slower recovery.",
    lockedReason: "Needs the body-morph path (see the customisation notes).",
  },
];

/**
 * Every locked entry must say why. TypeScript cannot express "required only
 * when availability is locked" without splitting the type into a union that
 * would make every consumer narrow before reading a name, so it is asserted in
 * the tests instead - which is where the check is actually useful, because the
 * failure mode is a human forgetting when adding a row.
 */
export function missingLockReasons(): string[] {
  const out: string[] = [];
  const check = (items: { id: string; availability: Availability; lockedReason?: string }[]) => {
    for (const i of items) {
      if (i.availability === "locked" && !i.lockedReason) out.push(i.id);
    }
  };
  check(ROSTER);
  check(ARENAS);
  check(MAIN_MENU);
  check(FIGHT_MODES);
  check(ONLINE_MODES);
  return out;
}

// --- Arenas ---------------------------------------------------------------

export interface Arena {
  id: string;
  name: string;
  blurb: string;
  availability: Availability;
  lockedReason?: string;
}

export const ARENAS: Arena[] = [
  {
    id: "octagon",
    name: "The Octagon",
    blurb: "Regulation cage, 30ft across, dim broadcast lighting.",
    availability: "ready",
  },
  {
    id: "octagon-bright",
    name: "Octagon - House Lights",
    blurb: "Same cage, flat even lighting. Easier to read while training.",
    availability: "ready",
  },
  {
    id: "gym",
    name: "The Gym",
    blurb: "Heavy bags, mirrors, no cage.",
    availability: "locked",
    lockedReason: "Not built. The octagon was the priority.",
  },
  {
    id: "ring",
    name: "Boxing Ring",
    blurb: "Four ropes, square canvas, corner stools.",
    availability: "locked",
    lockedReason:
      "Ropes need a different structural approach to the cage's rigid panels.",
  },
];

// --- Modes ----------------------------------------------------------------

export const MAIN_MENU: MenuItem[] = [
  {
    id: "fight",
    label: "Fight",
    blurb: "Exhibition, tower, and career.",
    availability: "preview",
    goto: "modes",
  },
  {
    id: "online",
    label: "Online",
    blurb: "Play someone else over the network.",
    availability: "locked",
    goto: "online",
    lockedReason:
      "Networking is deliberately gated behind the perception layer. LAN first.",
  },
  {
    id: "training",
    label: "Training",
    blurb: "Free striking against a target. No rounds, no score.",
    availability: "ready",
    goto: "training",
  },
  {
    id: "arenas",
    label: "Arenas",
    blurb: "Look around the cage with nobody in it.",
    availability: "ready",
    goto: "arenas",
  },
  {
    id: "settings",
    label: "Settings",
    blurb: "Camera, tracking, video, audio, accessibility.",
    availability: "ready",
    goto: "settings",
  },
];

export const FIGHT_MODES: MenuItem[] = [
  {
    id: "exhibition",
    label: "Exhibition",
    blurb: "One fight. Pick a fighter, pick a cage, go.",
    availability: "preview",
    goto: "fighters",
  },
  {
    id: "ai",
    label: "Versus CPU",
    blurb: "A training target that fights back.",
    availability: "locked",
    lockedReason:
      "The target reacts to hits but does not throw any. It needs a CPU layer.",
  },
  {
    id: "tower",
    label: "Tower",
    blurb: "A ladder of opponents, escalating.",
    availability: "locked",
    lockedReason: "Needs Versus CPU and more than one opponent.",
  },
  {
    id: "career",
    label: "Career",
    blurb: "Build a fighter through a division.",
    availability: "locked",
    lockedReason: "Needs the roster, weight classes, and persistence.",
  },
];

export const ONLINE_MODES: MenuItem[] = [
  {
    id: "lan",
    label: "Same Network",
    blurb: "Direct peer-to-peer on your LAN. The first target.",
    availability: "locked",
    lockedReason: "Not started. It is the milestone after the perception layer.",
  },
  {
    id: "casual",
    label: "Casual Match",
    blurb: "Unranked, over the internet.",
    availability: "locked",
    lockedReason: "Needs a signaling server, and LAN play proven first.",
  },
  {
    id: "ranked",
    label: "Ranked",
    blurb: "Rated matches.",
    availability: "locked",
    lockedReason: "Needs a fair, validated fight first. Ranking an unfair game is worse than not ranking it.",
  },
  {
    id: "private",
    label: "Private Lobby",
    blurb: "Invite a friend with a code.",
    availability: "locked",
    lockedReason: "Needs the signaling server.",
  },
];

// --- Match setup ----------------------------------------------------------

export interface MatchRules {
  rounds: number;
  roundSeconds: number;
  /** Scales all damage. 1 = the table in strikeGeometry.ts as written. */
  damageScale: number;
  /** Fouls below the belt cost a point instead of being ignored. */
  enforceFouls: boolean;
  /** Stops the fight when a fighter is finished rather than continuing. */
  stoppages: boolean;
}

export const DEFAULT_RULES: MatchRules = {
  rounds: 3,
  roundSeconds: 180,
  damageScale: 1,
  enforceFouls: true,
  stoppages: true,
};

/** The full selection a match needs before it can start. */
export interface MatchConfig {
  fighterId: string;
  opponentId: string;
  arenaId: string;
  rules: MatchRules;
}

export function defaultMatch(): MatchConfig {
  return {
    fighterId: "default",
    opponentId: "default",
    arenaId: "octagon",
    rules: { ...DEFAULT_RULES },
  };
}

/**
 * Whether a match config can actually be started, and why not.
 *
 * Returned as a reason string rather than a boolean so the button can say what
 * is wrong instead of just being greyed out - the thing every one of the
 * reference menus gets right and most web UIs get wrong.
 */
export function matchBlockedReason(config: MatchConfig): string | null {
  const fighter = ROSTER.find((f) => f.id === config.fighterId);
  const arena = ARENAS.find((a) => a.id === config.arenaId);
  if (!fighter) return "No fighter selected.";
  if (!arena) return "No arena selected.";
  if (fighter.availability === "locked") return `${fighter.name} is not built yet.`;
  if (arena.availability === "locked") return `${arena.name} is not built yet.`;
  return null;
}

export function formatRoundLength(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, "0")}`;
}
