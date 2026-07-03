import { create } from "zustand";
import type { ViewMode } from "./types";
import { setMenuAccelerators } from "./ipc";
import { allEditorViews } from "./editor/registry";
import { editorKeybindCompartment, editorKeybindings } from "./editor/extensions";

/* ---------------------------------------------------------------------------
   Preferences: persisted to localStorage, applied imperatively (CSS variables,
   classes, CodeMirror compartments, native menu accelerators).
--------------------------------------------------------------------------- */

export type ThemeSetting = "system" | "light" | "dark";
export type WidthSetting = "narrow" | "normal" | "wide" | "full";

export interface Settings {
  theme: ThemeSetting;
  editorWidth: WidthSetting;
  caretAnimation: boolean;
  defaultMode: ViewMode;
  /** Reformat markdown with Prettier on every save. */
  formatOnSave: boolean;
  /** SSH host used when an mdviewer:// link or `mdv` command omits one. */
  defaultRemoteHost: string;
  /** Keybind overrides by action id (CodeMirror syntax for editor actions, menu syntax for menu actions). */
  keybinds: Record<string, string>;
}

export interface KeybindDef {
  id: string;
  label: string;
  kind: "editor" | "menu";
  defaultKey: string;
}

export const KEYBINDS: KeybindDef[] = [
  { id: "fmt-bold", label: "Bold", kind: "editor", defaultKey: "Mod-b" },
  { id: "fmt-italic", label: "Italic", kind: "editor", defaultKey: "Mod-i" },
  { id: "fmt-code", label: "Inline code", kind: "editor", defaultKey: "Mod-e" },
  { id: "fmt-strike", label: "Strikethrough", kind: "editor", defaultKey: "Mod-Shift-x" },
  { id: "fmt-link", label: "Insert link", kind: "editor", defaultKey: "Mod-k" },
  { id: "task-toggle", label: "Toggle task checkbox", kind: "editor", defaultKey: "Mod-Enter" },
  { id: "new", label: "New file", kind: "menu", defaultKey: "CmdOrCtrl+N" },
  { id: "open", label: "Open…", kind: "menu", defaultKey: "CmdOrCtrl+O" },
  { id: "save", label: "Save", kind: "menu", defaultKey: "CmdOrCtrl+S" },
  { id: "save-as", label: "Save as…", kind: "menu", defaultKey: "Shift+CmdOrCtrl+S" },
  { id: "export-html", label: "Export as HTML…", kind: "menu", defaultKey: "Shift+CmdOrCtrl+E" },
  { id: "close-pane", label: "Close pane", kind: "menu", defaultKey: "CmdOrCtrl+W" },
  { id: "mode-editor", label: "Editor only", kind: "menu", defaultKey: "CmdOrCtrl+1" },
  { id: "mode-split", label: "Editor & preview", kind: "menu", defaultKey: "CmdOrCtrl+2" },
  { id: "mode-preview", label: "Preview only", kind: "menu", defaultKey: "CmdOrCtrl+3" },
  { id: "toggle-outline", label: "Toggle outline", kind: "menu", defaultKey: "Ctrl+CmdOrCtrl+O" },
  { id: "split-right", label: "New pane right", kind: "menu", defaultKey: "CmdOrCtrl+D" },
  { id: "split-down", label: "New pane below", kind: "menu", defaultKey: "Shift+CmdOrCtrl+D" },
  { id: "focus-next", label: "Focus next pane", kind: "menu", defaultKey: "Ctrl+Tab" },
  { id: "focus-prev", label: "Focus previous pane", kind: "menu", defaultKey: "Ctrl+Shift+Tab" },
  { id: "zoom-in", label: "Zoom in", kind: "menu", defaultKey: "CmdOrCtrl+=" },
  { id: "zoom-out", label: "Zoom out", kind: "menu", defaultKey: "CmdOrCtrl+-" },
  { id: "zoom-reset", label: "Actual size", kind: "menu", defaultKey: "CmdOrCtrl+0" },
  { id: "paste-plain", label: "Paste and match style", kind: "menu", defaultKey: "Shift+CmdOrCtrl+V" },
  { id: "format", label: "Format document", kind: "menu", defaultKey: "Shift+Alt+F" },
];

const DEFAULTS: Settings = {
  theme: "system",
  editorWidth: "normal",
  caretAnimation: true,
  defaultMode: "split",
  formatOnSave: false,
  defaultRemoteHost: "",
  keybinds: {},
};

const STORAGE_KEY = "settings";

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed, keybinds: { ...(parsed.keybinds ?? {}) } };
  } catch {
    return DEFAULTS;
  }
}

/** Effective key for an action (override or default). */
export function keybindFor(settings: Settings, id: string): string {
  return settings.keybinds[id] ?? KEYBINDS.find((k) => k.id === id)?.defaultKey ?? "";
}

const WIDTHS: Record<WidthSetting, string> = {
  narrow: "38rem",
  normal: "44rem",
  wide: "56rem",
  full: "9999px",
};

/** Push the current settings into the DOM, the editors, and the native menu. */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;

  if (settings.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", settings.theme);

  root.style.setProperty("--content-width", WIDTHS[settings.editorWidth]);
  root.classList.toggle("no-caret-animation", !settings.caretAnimation);

  // Live-reconfigure every open editor's bindable keymap.
  const binds = settings.keybinds;
  for (const view of allEditorViews()) {
    view.dispatch({
      effects: editorKeybindCompartment.reconfigure(editorKeybindings(binds)),
    });
  }

  // Native menu accelerators: always send the full effective map so resets
  // restore defaults too.
  const accelerators: Record<string, string> = {};
  for (const def of KEYBINDS) {
    if (def.kind === "menu") accelerators[def.id] = keybindFor(settings, def.id);
  }
  void setMenuAccelerators(accelerators);
}

/** Temporarily clear all menu accelerators (used while recording a shortcut). */
export function suspendMenuAccelerators(): void {
  const cleared: Record<string, string> = {};
  for (const def of KEYBINDS) {
    if (def.kind === "menu") cleared[def.id] = "";
  }
  void setMenuAccelerators(cleared);
}

/** Convert a keydown into our keybind syntax, or null if it isn't a usable combo. */
export function captureKeybind(
  event: KeyboardEvent,
  kind: "editor" | "menu",
): string | null {
  const key = event.key;
  if (key === "Meta" || key === "Control" || key === "Alt" || key === "Shift") return null;
  if (key === "Escape") return null;
  const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
  const isFunctionKey = /^F\d{1,2}$/.test(key);
  if (!hasModifier && !isFunctionKey) return null;

  const named = key === " " ? "Space" : key.length === 1 ? key : key;
  if (kind === "editor") {
    const parts: string[] = [];
    if (event.metaKey) parts.push("Mod");
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    parts.push(named.length === 1 ? named.toLowerCase() : named);
    return parts.join("-");
  }
  const parts: string[] = [];
  if (event.metaKey) parts.push("CmdOrCtrl");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(named.length === 1 ? named.toUpperCase() : named);
  return parts.join("+");
}

/** Pretty-print a keybind with mac symbols for display. */
export function formatKeybind(key: string): string {
  if (!key) return "—";
  return key
    .split(/[-+]/)
    .map((part) => {
      switch (part) {
        case "Mod":
        case "CmdOrCtrl":
        case "Cmd":
        case "Meta":
          return "⌘";
        case "Ctrl":
        case "Control":
          return "⌃";
        case "Alt":
        case "Option":
          return "⌥";
        case "Shift":
          return "⇧";
        case "Enter":
          return "↩";
        case "Tab":
          return "⇥";
        case "Space":
          return "␣";
        case "Backspace":
          return "⌫";
        case "ArrowUp":
          return "↑";
        case "ArrowDown":
          return "↓";
        case "ArrowLeft":
          return "←";
        case "ArrowRight":
          return "→";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join("");
}

interface SettingsStore {
  settings: Settings;
  open: boolean;
  setOpen(open: boolean): void;
  update(patch: Partial<Settings>): void;
  setKeybind(id: string, key: string | null): void;
  resetKeybinds(): void;
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  settings: loadSettings(),
  open: false,

  setOpen(open) {
    if (get().open !== open) set({ open });
  },

  update(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    applySettings(settings);
  },

  setKeybind(id, key) {
    const def = KEYBINDS.find((k) => k.id === id);
    if (!def) return;
    const keybinds = { ...get().settings.keybinds };
    if (!key || key === def.defaultKey) delete keybinds[id];
    else keybinds[id] = key;
    get().update({ keybinds });
  },

  resetKeybinds() {
    get().update({ keybinds: {} });
  },
}));
