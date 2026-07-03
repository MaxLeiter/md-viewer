import { setRecentFiles } from "./ipc";

/** An entry in the File → Open Recent menu. */
export interface RecentEntry {
  /** Open spec: a local path or an mdviewer:// URL. */
  spec: string;
  label: string;
}

const STORAGE_KEY = "recentFiles";
const MAX = 12;

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

let entries = load();

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  void setRecentFiles(entries).catch(() => {});
}

/** Record a freshly opened/saved document; most recent first, de-duplicated. */
export function addRecent(spec: string, label: string): void {
  entries = [{ spec, label }, ...entries.filter((e) => e.spec !== spec)].slice(0, MAX);
  persist();
}

export function clearRecents(): void {
  entries = [];
  persist();
}

/** Push the persisted list into the native menu (after the menu is built). */
export function initRecents(): void {
  if (entries.length) void setRecentFiles(entries).catch(() => {});
}
