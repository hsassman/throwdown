// Play a Friend room codes: four characters from the server's alphabet
// (server/Throwdown.Server/MatchmakingQueue.cs), which leaves out I, O, 0 and 1.

const ROOM_CODE = /^[A-HJ-NP-Z2-9]{4}$/;

export const isRoomCode = (text: string): boolean => ROOM_CODE.test(text);

/** The code as typed: upper case, letters and digits only, at most four. */
export function cleanCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

/** The link a QR code carries: this page, joining the room. */
export function joinUrl(code: string, origin = window.location.origin, path = window.location.pathname): string {
  return `${origin}${path}?join=${code}`;
}

/** The room code in a page's `?join=`, or null. */
export function joinCodeFrom(search: string): string | null {
  const code = cleanCode(new URLSearchParams(search).get("join") ?? "");
  return isRoomCode(code) ? code : null;
}
