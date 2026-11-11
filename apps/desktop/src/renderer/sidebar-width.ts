/**
 * The sidebar's width in pixels: where it starts, how narrow and wide it can be dragged, and how
 * far one arrow press on its edge moves it.
 */
export const SIDEBAR = { initial: 232, min: 200, max: 360, step: 16 } as const;

const STORAGE_KEY = "dodocode.sidebar";

export interface SidebarLayout {
  width: number;
  collapsed: boolean;
}

/** The sidebar as it was left, kept inside the widths it can take. */
export function loadSidebar(): SidebarLayout {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) throw new Error("Nothing saved.");
    const { width, collapsed } = saved as Record<string, unknown>;
    return {
      width:
        typeof width === "number" && Number.isFinite(width)
          ? Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width))
          : SIDEBAR.initial,
      collapsed: collapsed === true,
    };
  } catch {
    return { width: SIDEBAR.initial, collapsed: false };
  }
}

export function saveSidebar(layout: SidebarLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage can be full or blocked; the sidebar keeps its width until the app closes.
  }
}
