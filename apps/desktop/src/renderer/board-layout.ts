const STORAGE_KEY = "dodocode.board";

/** How the board was left. */
export interface BoardLayout {
  /** The backlog column shows, left of To do. It starts hidden. */
  backlog: boolean;
}

export function loadBoard(): BoardLayout {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) throw new Error("Nothing saved.");
    return { backlog: (saved as Record<string, unknown>).backlog === true };
  } catch {
    return { backlog: false };
  }
}

export function saveBoard(layout: BoardLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage can be full or blocked; the board stays as it is until the app closes.
  }
}
