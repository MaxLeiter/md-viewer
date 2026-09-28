import { create } from "zustand";
import type { Doc, LeafNode, TabView, ViewMode } from "./types";
import { basename, displayTitle, isCsvPath, isDirty, isPristine } from "./types";
import {
  askToSave,
  confirmReloadDiscard,
  copyToClipboard,
  pathExists,
  pickFilesToOpen,
  pickSavePath,
  readRemoteFile,
  readTextFile,
  showError,
  writeRemoteFile,
  writeTextFile,
} from "./ipc";
import { allEditorViews, getEditorView } from "./editor/registry";
import { useSettings } from "./settings";
import { isValidHost, parseOpenSpec, remoteUrl } from "./remote";
import { addRecent } from "./recent";
import { formatMarkdown } from "./format";
import { buildExportHtml } from "./export";
import type { RemoteRef } from "./types";

/** Resolve a relative/absolute link target against a base directory. */
function resolveLink(baseDir: string | null, href: string): string | null {
  const clean = decodeURI(href.split("#")[0].split("?")[0]);
  if (!clean) return null;
  if (clean.startsWith("/")) return clean;
  if (!baseDir) return null;
  return `${baseDir}/${clean}`;
}

function makeDoc(partial: Partial<Doc> = {}): Doc {
  return {
    id: crypto.randomUUID(),
    path: null,
    remote: null,
    title: "Untitled",
    content: "",
    saved: "",
    ...partial,
  };
}

/** A document's default view state when it first opens as a tab. */
function makeView(mode: ViewMode): TabView {
  return { mode, ratio: 0.5, outline: false };
}

const SIDEBAR_KEY = "sidebarOpen";
const SIDEBAR_WIDTH_KEY = "sidebarWidth";
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 240;

function clampSidebar(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

interface AppState {
  docs: Record<string, Doc>;
  /** Ordered doc ids — the tab order. */
  tabs: string[];
  /** The active (visible) doc id. */
  activeId: string;
  /** Per-doc view state (mode / split ratio / outline). */
  views: Record<string, TabView>;
  /** Whether the left sidebar is expanded. */
  sidebarOpen: boolean;
  /** Left sidebar width in px (draggable). */
  sidebarWidth: number;
  /** True while files are being dragged over the window. */
  dropping: boolean;
  /** Content scale factor (⌘+ / ⌘−). */
  zoom: number;
  /** Image currently shown in the lightbox, if any. */
  lightboxSrc: string | null;
  /** Remote file browser: which flow it's showing, or null when closed. */
  remoteBrowser: "open" | "save" | null;

  // --- selectors -----------------------------------------------------------
  /** The single visible leaf, synthesized from activeId + its view state. */
  activeLeaf(): LeafNode;
  focusedLeaf(): LeafNode | null;
  focusedDoc(): Doc | null;
  dirtyDocs(): Doc[];

  // --- pure UI updates -----------------------------------------------------
  setDropping(value: boolean): void;
  setZoom(value: number): void;
  setLightbox(src: string | null): void;
  setRemoteBrowser(mode: "open" | "save" | null): void;
  setContent(docId: string, content: string): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  selectTab(docId: string): void;
  /** Move a tab to a new index in the strip (drag-to-reorder). */
  reorderTab(docId: string, toIndex: number): void;
  /** Alias for selectTab (leaf id === doc id now). */
  focusLeaf(docId: string): void;
  nextTab(): void;
  prevTab(): void;
  jumpToTab(index: number): void;
  setMode(docId: string, mode: ViewMode): void;
  togglePreview(): void;
  toggleOutline(docId: string): void;
  setRatio(docId: string, ratio: number): void;
  newDoc(): void;

  // --- file operations -----------------------------------------------------
  placeDoc(doc: Doc, mode: ViewMode): void;
  openPaths(specs: string[]): Promise<void>;
  openRemote(host: string, path: string): Promise<void>;
  openViaDialog(): Promise<void>;
  followLink(docId: string, href: string): Promise<void>;
  exportHtml(docId: string): Promise<void>;
  saveDoc(docId: string, saveAs?: boolean): Promise<boolean>;
  reloadDoc(docId: string): Promise<void>;
  copyDocPath(docId: string): Promise<void>;
  /** Write the doc to host:path over SSH and make it a remote document. */
  saveToRemote(docId: string, host: string, path: string): Promise<boolean>;
  closeTab(docId?: string): Promise<void>;
}

const initialDoc = makeDoc();

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.8;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 10) / 10));
}

function applyZoom(zoom: number): void {
  document.documentElement.style.setProperty("--content-scale", String(zoom));
}

const initialZoom = clampZoom(Number(localStorage.getItem("zoom")) || 1);
applyZoom(initialZoom);

export const useStore = create<AppState>()((set, get) => ({
  docs: { [initialDoc.id]: initialDoc },
  tabs: [initialDoc.id],
  activeId: initialDoc.id,
  views: { [initialDoc.id]: makeView("editor") },
  sidebarOpen: localStorage.getItem(SIDEBAR_KEY) !== "false",
  sidebarWidth: clampSidebar(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT),
  dropping: false,
  zoom: initialZoom,
  lightboxSrc: null,
  remoteBrowser: null,

  activeLeaf() {
    const { activeId, views } = get();
    const v = views[activeId] ?? makeView(useSettings.getState().settings.defaultMode);
    return { type: "leaf", id: activeId, docId: activeId, mode: v.mode, ratio: v.ratio, outline: v.outline };
  },

  focusedLeaf() {
    return get().activeLeaf();
  },

  focusedDoc() {
    return get().docs[get().activeId] ?? null;
  },

  dirtyDocs() {
    return Object.values(get().docs).filter(isDirty);
  },

  setDropping(value) {
    if (get().dropping !== value) set({ dropping: value });
  },

  setZoom(value) {
    const zoom = clampZoom(value);
    if (zoom === get().zoom) return;
    set({ zoom });
    localStorage.setItem("zoom", String(zoom));
    applyZoom(zoom);
    for (const view of allEditorViews()) view.requestMeasure();
  },

  setLightbox(src) {
    if (get().lightboxSrc !== src) set({ lightboxSrc: src });
  },

  setRemoteBrowser(mode) {
    if (get().remoteBrowser !== mode) set({ remoteBrowser: mode });
  },

  setContent(docId, content) {
    const doc = get().docs[docId];
    if (!doc || doc.content === content) return;
    set((s) => ({ docs: { ...s.docs, [docId]: { ...doc, content } } }));
  },

  toggleSidebar() {
    const next = !get().sidebarOpen;
    localStorage.setItem(SIDEBAR_KEY, String(next));
    set({ sidebarOpen: next });
  },

  setSidebarWidth(width) {
    const w = clampSidebar(width);
    if (w === get().sidebarWidth) return;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
    set({ sidebarWidth: w });
  },

  selectTab(docId) {
    if (get().tabs.includes(docId) && get().activeId !== docId) set({ activeId: docId });
  },

  reorderTab(docId, toIndex) {
    const { tabs } = get();
    const from = tabs.indexOf(docId);
    if (from === -1) return;
    const clamped = Math.max(0, Math.min(tabs.length - 1, toIndex));
    if (from === clamped) return;
    const next = tabs.filter((t) => t !== docId);
    next.splice(clamped, 0, docId);
    set({ tabs: next });
  },

  focusLeaf(docId) {
    get().selectTab(docId);
  },

  nextTab() {
    const { tabs, activeId } = get();
    if (tabs.length < 2) return;
    const idx = tabs.indexOf(activeId);
    set({ activeId: tabs[(idx + 1) % tabs.length] });
  },

  prevTab() {
    const { tabs, activeId } = get();
    if (tabs.length < 2) return;
    const idx = tabs.indexOf(activeId);
    set({ activeId: tabs[(idx - 1 + tabs.length) % tabs.length] });
  },

  jumpToTab(index) {
    const id = get().tabs[index];
    if (id && get().activeId !== id) set({ activeId: id });
  },

  setMode(docId, mode) {
    const view = get().views[docId];
    if (!view) return;
    set((s) => ({ views: { ...s.views, [docId]: { ...view, mode } } }));
  },

  togglePreview() {
    const id = get().activeId;
    const view = get().views[id];
    if (!view) return;
    // Flip between editor and preview (a split view collapses to preview first).
    const mode = view.mode === "preview" ? "editor" : "preview";
    set((s) => ({ views: { ...s.views, [id]: { ...view, mode } } }));
  },

  toggleOutline(docId) {
    const view = get().views[docId];
    if (!view) return;
    set((s) => ({ views: { ...s.views, [docId]: { ...view, outline: !view.outline } } }));
  },

  setRatio(docId, ratio) {
    const view = get().views[docId];
    if (!view) return;
    set((s) => ({ views: { ...s.views, [docId]: { ...view, ratio } } }));
  },

  newDoc() {
    const s = get();
    // The active tab is already an empty scratch document — nothing to do.
    const active = s.docs[s.activeId];
    if (active && isPristine(active)) return;
    const doc = makeDoc();
    set({
      docs: { ...s.docs, [doc.id]: doc },
      views: { ...s.views, [doc.id]: makeView("editor") },
      tabs: [...s.tabs, doc.id],
      activeId: doc.id,
    });
  },

  placeDoc(doc, mode) {
    const s = get();
    const active = s.docs[s.activeId];

    // Opening a real file while the active tab is a pristine scratch replaces it
    // in place (no leftover empty "Untitled" tab).
    if (active && isPristine(active)) {
      const oldId = s.activeId;
      const docs = { ...s.docs, [doc.id]: doc };
      delete docs[oldId];
      const views = { ...s.views, [doc.id]: makeView(mode) };
      delete views[oldId];
      set({
        docs,
        views,
        tabs: s.tabs.map((id) => (id === oldId ? doc.id : id)),
        activeId: doc.id,
      });
      return;
    }

    set({
      docs: { ...s.docs, [doc.id]: doc },
      views: { ...s.views, [doc.id]: makeView(mode) },
      tabs: [...s.tabs, doc.id],
      activeId: doc.id,
    });
  },

  async openPaths(specs) {
    const defaultHost = useSettings.getState().settings.defaultRemoteHost ?? "";
    for (const spec of specs) {
      const parsed = parseOpenSpec(spec, defaultHost);
      if (parsed.kind === "remote") {
        await get().openRemote(parsed.ref.host, parsed.ref.path);
        continue;
      }
      const path = parsed.path;
      const state = get();

      // Already open? Activate its tab instead of opening a second copy.
      const existingDoc = Object.values(state.docs).find((d) => d.path === path);
      if (existingDoc) {
        get().selectTab(existingDoc.id);
        continue;
      }

      let content: string;
      try {
        content = await readTextFile(path);
      } catch (err) {
        await showError(String(err));
        continue;
      }

      const doc = makeDoc({ path, title: basename(path), content, saved: content });
      // Data files open straight into the table view; markdown follows the preference.
      const openMode = isCsvPath(path) ? "preview" : useSettings.getState().settings.defaultMode;
      get().placeDoc(doc, openMode);
      addRecent(path, basename(path));
    }
  },

  async openRemote(host, path) {
    if (!isValidHost(host)) {
      await showError(`Invalid SSH host: ${host}`);
      return;
    }
    const state = get();
    // Already open? Activate the existing tab.
    const existing = Object.values(state.docs).find(
      (d) => d.remote && d.remote.host === host && d.remote.path === path,
    );
    if (existing) {
      get().selectTab(existing.id);
      return;
    }

    let content: string;
    try {
      content = await readRemoteFile(host, path);
    } catch (err) {
      await showError(String(err));
      return;
    }

    const remote: RemoteRef = { host, path };
    const doc = makeDoc({ remote, title: basename(path), content, saved: content });
    const openMode = isCsvPath(path) ? "preview" : useSettings.getState().settings.defaultMode;
    get().placeDoc(doc, openMode);
    addRecent(remoteUrl(remote), `${basename(path)} — ${host}`);
  },

  async openViaDialog() {
    const paths = await pickFilesToOpen();
    if (paths.length) await get().openPaths(paths);
  },

  async exportHtml(docId) {
    const doc = get().docs[docId];
    if (!doc) return;
    const view = getEditorView(docId);
    const source = view ? view.state.doc.toString() : doc.content;
    const title = displayTitle(doc);
    const base = (doc.path ?? doc.remote?.path)?.replace(/\.[^./]+$/, "") ?? title;
    const suggested = `${base.split("/").pop() || "document"}.html`;
    const path = await pickSavePath(suggested);
    if (!path) return;
    try {
      await writeTextFile(path, buildExportHtml(source, title));
    } catch (err) {
      await showError(String(err));
    }
  },

  async followLink(docId, href) {
    const doc = get().docs[docId];
    if (!doc) return;

    if (doc.remote) {
      const baseDir = doc.remote.path.slice(0, doc.remote.path.lastIndexOf("/"));
      const target = resolveLink(baseDir, href);
      if (target) await get().openRemote(doc.remote.host, target);
      return;
    }

    const baseDir = doc.path ? doc.path.slice(0, doc.path.lastIndexOf("/")) : null;
    const target = resolveLink(baseDir, href);
    if (!target) return;
    if (await pathExists(target)) {
      await get().openPaths([target]);
    } else {
      await showError(`File not found: ${target}`);
    }
  },

  async saveDoc(docId, saveAs = false) {
    const doc = get().docs[docId];
    if (!doc) return false;

    // Editor → store syncing is coalesced; the live view is the source of
    // truth, so saves always take the freshest text.
    const liveView = getEditorView(docId);
    const liveContent = liveView ? liveView.state.doc.toString() : doc.content;
    if (liveContent !== doc.content) {
      set((s) => ({ docs: { ...s.docs, [docId]: { ...s.docs[docId], content: liveContent } } }));
    }

    let content = liveContent;

    // Optionally reformat markdown (never data files) before writing.
    const classify = doc.path ?? doc.remote?.path ?? null;
    if (useSettings.getState().settings.formatOnSave && !isCsvPath(classify)) {
      const formatted = await formatMarkdown(content);
      if (formatted !== null && formatted !== content) {
        content = formatted;
        const view = getEditorView(docId);
        if (view) {
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        }
      }
    }

    // Plain Save of a remote document writes straight back over SSH.
    if (doc.remote && !saveAs) {
      try {
        await writeRemoteFile(doc.remote.host, doc.remote.path, content);
      } catch (err) {
        await showError(String(err));
        return false;
      }
      set((s) => {
        const current = s.docs[docId];
        return current ? { docs: { ...s.docs, [docId]: { ...current, saved: content } } } : s;
      });
      addRecent(remoteUrl(doc.remote), `${basename(doc.remote.path)} — ${doc.remote.host}`);
      return true;
    }

    let path = doc.path;
    if (saveAs || !path) {
      const base =
        doc.path || doc.remote
          ? doc.title.replace(/\.(md|markdown|txt|csv|tsv)$/i, "")
          : displayTitle(doc).replace(/[/\\:]/g, "-");
      const suggested = doc.path ?? `${base}.md`;
      path = await pickSavePath(suggested);
      if (!path) return false;
    }

    try {
      await writeTextFile(path, content);
    } catch (err) {
      await showError(String(err));
      return false;
    }

    // Saving to disk makes the document local (a remote "Save As" detaches it).
    set((s) => {
      const current = s.docs[docId];
      if (!current) return s;
      return {
        docs: {
          ...s.docs,
          [docId]: { ...current, path, remote: null, title: basename(path), saved: content },
        },
      };
    });
    addRecent(path, basename(path));
    return true;
  },

  async reloadDoc(docId) {
    const doc = get().docs[docId];
    if (!doc) return;
    // Nothing to reload for an unsaved scratch document.
    if (!doc.path && !doc.remote) return;

    // The live editor view is the source of truth for dirtiness.
    const liveView = getEditorView(docId);
    const liveContent = liveView ? liveView.state.doc.toString() : doc.content;
    if (liveContent !== doc.saved && !(await confirmReloadDiscard(displayTitle(doc)))) return;

    let content: string;
    try {
      content = doc.remote
        ? await readRemoteFile(doc.remote.host, doc.remote.path)
        : await readTextFile(doc.path!);
    } catch (err) {
      await showError(String(err));
      return;
    }

    set((s) => {
      const current = s.docs[docId];
      return current ? { docs: { ...s.docs, [docId]: { ...current, content, saved: content } } } : s;
    });
    const view = getEditorView(docId);
    if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    }
  },

  async copyDocPath(docId) {
    const doc = get().docs[docId];
    if (!doc) return;
    if (doc.remote) {
      // Default: bare path (pastes straight into a shell on that box). Opt-in to
      // the `host:path` form via settings.
      const withHost = useSettings.getState().settings.copyPathWithHost;
      await copyToClipboard(withHost ? `${doc.remote.host}:${doc.remote.path}` : doc.remote.path);
      return;
    }
    if (doc.path) await copyToClipboard(doc.path);
  },

  async saveToRemote(docId, host, path) {
    const doc = get().docs[docId];
    if (!doc) return false;
    if (!isValidHost(host)) {
      await showError(`Invalid SSH host: ${host}`);
      return false;
    }
    // The live editor view is the source of truth (store sync is coalesced).
    const view = getEditorView(docId);
    const content = view ? view.state.doc.toString() : doc.content;
    try {
      await writeRemoteFile(host, path, content);
    } catch (err) {
      await showError(String(err));
      return false;
    }
    // The document now lives on the remote: later ⌘S writes straight back there.
    const remote: RemoteRef = { host, path };
    set((s) => {
      const current = s.docs[docId];
      if (!current) return s;
      return {
        docs: {
          ...s.docs,
          [docId]: { ...current, path: null, remote, title: basename(path), content, saved: content },
        },
      };
    });
    addRecent(remoteUrl(remote), `${basename(path)} — ${host}`);
    return true;
  },

  async closeTab(docId) {
    const id = docId ?? get().activeId;
    if (!get().tabs.includes(id)) return;

    const doc = get().docs[id];
    if (doc && isDirty(doc)) {
      const wantsSave = await askToSave(doc.title);
      if (wantsSave) {
        const saved = await get().saveDoc(id);
        if (!saved) return; // cancelled the save dialog — abort the close
      }
    }

    const s = get();
    const idx = s.tabs.indexOf(id);
    if (idx === -1) return;

    // Last tab: keep the window alive with a fresh scratch document.
    if (s.tabs.length === 1) {
      const fresh = makeDoc();
      set({
        docs: { [fresh.id]: fresh },
        views: { [fresh.id]: makeView("editor") },
        tabs: [fresh.id],
        activeId: fresh.id,
      });
      return;
    }

    const tabs = s.tabs.filter((t) => t !== id);
    const docs = { ...s.docs };
    delete docs[id];
    const views = { ...s.views };
    delete views[id];
    // If the closed tab was active, hand over to the next (else previous) tab.
    const activeId = s.activeId === id ? (s.tabs[idx + 1] ?? s.tabs[idx - 1]) : s.activeId;
    set({ docs, views, tabs, activeId });
  },
}));
