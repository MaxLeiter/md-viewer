import { create } from "zustand";
import type { Doc, DropRegion, LeafNode, TileNode, ViewMode } from "./types";
import { basename, displayTitle, isCsvPath, isDirty, isPristine } from "./types";
import {
  countLeaves,
  findLeaf,
  leaves,
  makeLeaf,
  removeLeaf,
  splitLeaf,
  swapLeaves,
  updateLeaf,
  updateSizes,
} from "./tree";
import {
  askToSave,
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

/** Drop docs no longer referenced by any leaf. */
function pruneDocs(docs: Record<string, Doc>, root: TileNode): Record<string, Doc> {
  const used = new Set(leaves(root).map((l) => l.docId));
  const next: Record<string, Doc> = {};
  for (const id of Object.keys(docs)) {
    if (used.has(id)) next[id] = docs[id];
  }
  return next;
}

/** How long the tile-collapse animation runs before the leaf is really removed. */
const CLOSE_ANIMATION_MS = 200;

interface AppState {
  docs: Record<string, Doc>;
  root: TileNode;
  focusedId: string;
  /** Leaves currently animating out before removal. */
  closingLeafIds: string[];
  /** True while files are being dragged over the window. */
  dropping: boolean;
  /** Content scale factor (⌘+ / ⌘−). */
  zoom: number;
  /** Image currently shown in the lightbox, if any. */
  lightboxSrc: string | null;
  /** Active tile-header drag (rearranging panes), if any. */
  tileDrag: { sourceId: string; targetId: string | null; region: DropRegion | null } | null;
  /** Whether the "Open Remote…" prompt is showing. */
  remotePromptOpen: boolean;

  // --- selectors -----------------------------------------------------------
  focusedLeaf(): LeafNode | null;
  focusedDoc(): Doc | null;
  dirtyDocs(): Doc[];

  // --- pure UI updates -----------------------------------------------------
  setDropping(value: boolean): void;
  setZoom(value: number): void;
  setLightbox(src: string | null): void;
  setRemotePrompt(open: boolean): void;
  setContent(docId: string, content: string): void;
  focusLeaf(leafId: string): void;
  focusNext(): void;
  focusPrevious(): void;
  setMode(leafId: string, mode: ViewMode): void;
  toggleOutline(leafId: string): void;
  setRatio(leafId: string, ratio: number): void;
  setSizes(splitId: string, sizes: number[]): void;
  splitFocused(dir: "row" | "col", before?: boolean): void;
  newDoc(): void;
  beginTileDrag(sourceId: string): void;
  updateTileDrag(targetId: string | null, region: DropRegion | null): void;
  endTileDrag(commit: boolean): void;

  // --- file operations -----------------------------------------------------
  placeDoc(doc: Doc, mode: ViewMode): void;
  openPaths(specs: string[]): Promise<void>;
  openRemote(host: string, path: string): Promise<void>;
  openViaDialog(): Promise<void>;
  followLink(docId: string, href: string): Promise<void>;
  exportHtml(docId: string): Promise<void>;
  saveDoc(docId: string, saveAs?: boolean): Promise<boolean>;
  closeLeaf(leafId?: string): Promise<void>;
}

const initialDoc = makeDoc();
const initialLeaf = makeLeaf(initialDoc.id, "editor");

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
  root: initialLeaf,
  focusedId: initialLeaf.id,
  closingLeafIds: [],
  dropping: false,
  zoom: initialZoom,
  lightboxSrc: null,
  tileDrag: null,
  remotePromptOpen: false,

  focusedLeaf() {
    return findLeaf(get().root, get().focusedId);
  },

  focusedDoc() {
    const leaf = get().focusedLeaf();
    return leaf ? (get().docs[leaf.docId] ?? null) : null;
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

  setRemotePrompt(open) {
    if (get().remotePromptOpen !== open) set({ remotePromptOpen: open });
  },

  setContent(docId, content) {
    const doc = get().docs[docId];
    if (!doc || doc.content === content) return;
    set((s) => ({ docs: { ...s.docs, [docId]: { ...doc, content } } }));
  },

  focusLeaf(leafId) {
    if (get().focusedId !== leafId) set({ focusedId: leafId });
  },

  focusNext() {
    const all = leaves(get().root);
    if (all.length < 2) return;
    const idx = all.findIndex((l) => l.id === get().focusedId);
    const next = all[(idx + 1) % all.length];
    set({ focusedId: next.id });
  },

  focusPrevious() {
    const all = leaves(get().root);
    if (all.length < 2) return;
    const idx = all.findIndex((l) => l.id === get().focusedId);
    const previous = all[(idx - 1 + all.length) % all.length];
    set({ focusedId: previous.id });
  },

  setMode(leafId, mode) {
    set((s) => ({ root: updateLeaf(s.root, leafId, { mode }) }));
  },

  toggleOutline(leafId) {
    const leaf = findLeaf(get().root, leafId);
    if (!leaf) return;
    set((s) => ({ root: updateLeaf(s.root, leafId, { outline: !leaf.outline }) }));
  },

  setRatio(leafId, ratio) {
    set((s) => ({ root: updateLeaf(s.root, leafId, { ratio }) }));
  },

  setSizes(splitId, sizes) {
    set((s) => ({ root: updateSizes(s.root, splitId, sizes) }));
  },

  splitFocused(dir, before = false) {
    const doc = makeDoc();
    const leaf = makeLeaf(doc.id, "editor");
    set((s) => ({
      docs: { ...s.docs, [doc.id]: doc },
      root: splitLeaf(s.root, s.focusedId, dir, leaf, before),
      focusedId: leaf.id,
    }));
  },

  newDoc() {
    const focused = get().focusedDoc();
    // The focused tile is already an empty scratch document — nothing to do.
    if (focused && isPristine(focused)) return;
    get().splitFocused("row");
  },

  beginTileDrag(sourceId) {
    set({ tileDrag: { sourceId, targetId: null, region: null }, focusedId: sourceId });
  },

  updateTileDrag(targetId, region) {
    const drag = get().tileDrag;
    if (!drag) return;
    if (drag.targetId === targetId && drag.region === region) return;
    set({ tileDrag: { ...drag, targetId, region } });
  },

  endTileDrag(commit) {
    const drag = get().tileDrag;
    set({ tileDrag: null });
    if (!commit || !drag || !drag.targetId || !drag.region) return;
    const { sourceId, targetId, region } = drag;
    if (sourceId === targetId) return;

    // Drop in the middle: the two tiles trade places.
    if (region === "center") {
      set((s) => ({ root: swapLeaves(s.root, sourceId, targetId) }));
      return;
    }

    // Drop on an edge: pull the tile out and re-split the target around it.
    const state = get();
    const source = findLeaf(state.root, sourceId);
    if (!source || !findLeaf(state.root, targetId)) return;
    const without = removeLeaf(state.root, sourceId);
    if (!without || !findLeaf(without, targetId)) return;
    const dir = region === "left" || region === "right" ? "row" : "col";
    const before = region === "left" || region === "top";
    set({
      root: splitLeaf(without, targetId, dir, source, before),
      focusedId: sourceId,
    });
  },

  placeDoc(doc, mode) {
    const current = get();
    const focusedLeaf = findLeaf(current.root, current.focusedId);
    const focusedDoc = focusedLeaf ? current.docs[focusedLeaf.docId] : null;

    if (focusedLeaf && focusedDoc && isPristine(focusedDoc)) {
      // Reuse the empty scratch tile rather than splitting.
      const root = updateLeaf(current.root, focusedLeaf.id, { docId: doc.id, mode });
      set({
        docs: pruneDocs({ ...current.docs, [doc.id]: doc }, root),
        root,
        focusedId: focusedLeaf.id,
      });
    } else {
      const leaf = makeLeaf(doc.id, mode);
      const root = splitLeaf(current.root, current.focusedId, "row", leaf);
      set({ docs: { ...current.docs, [doc.id]: doc }, root, focusedId: leaf.id });
    }
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

      // Already open? Focus it instead of opening a second copy.
      const existingDoc = Object.values(state.docs).find((d) => d.path === path);
      if (existingDoc) {
        const leaf = leaves(state.root).find((l) => l.docId === existingDoc.id);
        if (leaf) {
          set({ focusedId: leaf.id });
          continue;
        }
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
    // Already open? Focus the existing tile.
    const existing = Object.values(state.docs).find(
      (d) => d.remote && d.remote.host === host && d.remote.path === path,
    );
    if (existing) {
      const leaf = leaves(state.root).find((l) => l.docId === existing.id);
      if (leaf) {
        set({ focusedId: leaf.id });
        return;
      }
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

  async closeLeaf(leafId) {
    const state = get();
    const id = leafId ?? state.focusedId;
    if (state.closingLeafIds.includes(id)) return;
    const leaf = findLeaf(state.root, id);
    if (!leaf) return;

    const doc = state.docs[leaf.docId];
    if (doc && isDirty(doc)) {
      const wantsSave = await askToSave(doc.title);
      if (wantsSave) {
        const saved = await get().saveDoc(doc.id);
        if (!saved) return; // cancelled the save dialog — abort the close
      }
    }

    // Last tile: keep the window alive with a fresh scratch document.
    if (get().root.type === "leaf") {
      const fresh = makeDoc();
      const freshLeaf = makeLeaf(fresh.id, "editor");
      set({ docs: { [fresh.id]: fresh }, root: freshLeaf, focusedId: freshLeaf.id });
      return;
    }

    // Hand focus to a neighbour right away, let the tile collapse, then take
    // it out of the tree once the animation has played.
    const ordered = leaves(get().root);
    const idx = ordered.findIndex((l) => l.id === id);
    const neighbor = ordered[idx + 1] ?? ordered[idx - 1];
    set((s) => ({
      focusedId: neighbor ? neighbor.id : s.focusedId,
      closingLeafIds: [...s.closingLeafIds, id],
    }));

    setTimeout(() => {
      const newRoot = removeLeaf(get().root, id);
      set((s) => {
        const closingLeafIds = s.closingLeafIds.filter((x) => x !== id);
        if (!newRoot) return { closingLeafIds };
        return {
          root: newRoot,
          closingLeafIds,
          docs: pruneDocs(s.docs, newRoot),
          focusedId: findLeaf(newRoot, s.focusedId) ? s.focusedId : leaves(newRoot)[0].id,
        };
      });
    }, CLOSE_ANIMATION_MS);
  },
}));

export { countLeaves, findLeaf, leaves };
