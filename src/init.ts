import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { EditorView } from "@codemirror/view";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { allowAsset, confirmDiscardAll, frontendReady, quitApp } from "./ipc";
import { applySettings, useSettings } from "./settings";
import { clearRecents, initRecents } from "./recent";
import { formatDocument } from "./format";
import { useStore } from "./store";
import { findLeaf, leaves } from "./tree";
import { displayTitle } from "./types";
import { getEditorView } from "./editor/registry";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|heic|heif|bmp|tiff?)$/i;

function markdownImageSnippet(path: string, docDir: string | null): string {
  // Same folder (or below) as the document → clean relative path, else absolute.
  let target = path;
  if (docDir && path.startsWith(`${docDir}/`)) target = path.slice(docDir.length + 1);
  const name = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "image";
  const url = /[\s()]/.test(target) ? `<${target}>` : target;
  return `![${name}](${url})`;
}

/** Find the editor under a viewport point. The Tauri webview suppresses
 *  native dragover events during an OS file drag, so CodeMirror's own drop
 *  cursor never sees them — we drive the caret ourselves. */
function editorAtPoint(point: { x: number; y: number }): EditorView | null {
  for (const leaf of leaves(useStore.getState().root)) {
    const view = getEditorView(leaf.docId);
    if (!view) continue;
    const rect = view.dom.getBoundingClientRect();
    if (
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom
    ) {
      return view;
    }
  }
  return null;
}

/** Move the caret of whichever editor the drag is currently over so the
 *  drop position is visible as the user moves the file around. */
function trackDragCursor(point: { x: number; y: number } | null) {
  if (!point) return;
  const view = editorAtPoint(point);
  if (!view) return;
  const pos = view.posAtCoords(point);
  if (pos == null) return;
  if (view.state.selection.main.head === pos) return;
  view.dispatch({ selection: { anchor: pos } });
}

/** Insert dropped image files as markdown, into the editor under the cursor
 *  position if there is one, otherwise into the focused tile's editor. */
function insertDroppedImages(paths: string[], point: { x: number; y: number } | null) {
  const s = useStore.getState();

  let view: EditorView | null = null;
  let leafId: string | null = null;
  if (point) {
    for (const leaf of leaves(s.root)) {
      const candidate = getEditorView(leaf.docId);
      if (!candidate) continue;
      const rect = candidate.dom.getBoundingClientRect();
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      ) {
        view = candidate;
        leafId = leaf.id;
        break;
      }
    }
  }
  const focused = s.focusedLeaf();
  if (!view && focused) {
    view = getEditorView(focused.docId) ?? null;
    leafId = focused.id;
  }
  if (!view || !leafId) return;
  const leaf = findLeaf(s.root, leafId);
  if (!leaf) return;

  const docPath = s.docs[leaf.docId]?.path ?? null;
  const docDir = docPath ? docPath.slice(0, docPath.lastIndexOf("/")) : null;
  const snippet = paths.map((p) => markdownImageSnippet(p, docDir)).join("\n");

  // The asset scope is per-document; explicitly allow dropped files so images
  // outside the document's folder still render.
  for (const p of paths) void allowAsset(p);

  const dropPos = point ? view.posAtCoords(point) : null;
  const { from, to } = view.state.selection.main;
  const insertFrom = dropPos ?? from;
  const insertTo = dropPos ?? to;
  view.dispatch({
    changes: { from: insertFrom, to: insertTo, insert: snippet },
    selection: { anchor: insertFrom + snippet.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  s.focusLeaf(leafId);
  if (leaf.mode === "preview") s.setMode(leaf.id, "split");
  view.focus();
}

declare global {
  interface Window {
    __MD_VIEWER_INITIALIZED__?: boolean;
  }
}

function handleMenu(id: string) {
  const s = useStore.getState();
  // Dynamic "Open Recent" entries carry their open spec in the id.
  if (id.startsWith("recent:")) {
    void s.openPaths([id.slice("recent:".length)]);
    return;
  }
  switch (id) {
    case "new":
      s.newDoc();
      break;
    case "open":
      void s.openViaDialog();
      break;
    case "open-remote":
      s.setRemotePrompt(true);
      break;
    case "clear-recent":
      clearRecents();
      break;
    case "format": {
      const doc = s.focusedDoc();
      if (doc) void formatDocument(doc.id);
      break;
    }
    case "save": {
      const doc = s.focusedDoc();
      if (doc) void s.saveDoc(doc.id);
      break;
    }
    case "save-as": {
      const doc = s.focusedDoc();
      if (doc) void s.saveDoc(doc.id, true);
      break;
    }
    case "export-html": {
      const doc = s.focusedDoc();
      if (doc) void s.exportHtml(doc.id);
      break;
    }
    case "close-pane":
      void s.closeLeaf();
      break;
    case "mode-editor":
    case "mode-split":
    case "mode-preview": {
      const leaf = s.focusedLeaf();
      if (leaf) s.setMode(leaf.id, id.replace("mode-", "") as "editor" | "split" | "preview");
      break;
    }
    case "paste-plain": {
      // ⌘V in the editor is already plain text; this covers the ⇧⌘V muscle memory.
      const leaf = s.focusedLeaf();
      const view = leaf ? getEditorView(leaf.docId) : undefined;
      if (!view) break;
      void readText().then((text) => {
        if (!text) return;
        view.dispatch(view.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        view.focus();
      });
      break;
    }
    case "toggle-outline": {
      const leaf = s.focusedLeaf();
      if (leaf) s.toggleOutline(leaf.id);
      break;
    }
    case "split-right":
      s.splitFocused("row");
      break;
    case "split-down":
      s.splitFocused("col");
      break;
    case "focus-next":
      s.focusNext();
      break;
    case "focus-prev":
      s.focusPrevious();
      break;
    case "zoom-in":
      s.setZoom(s.zoom + 0.1);
      break;
    case "zoom-out":
      s.setZoom(s.zoom - 0.1);
      break;
    case "zoom-reset":
      s.setZoom(1);
      break;
    case "settings":
      useSettings.getState().setOpen(true);
      break;
    case "quit":
      void maybeQuit();
      break;
  }
}

async function maybeQuit() {
  const dirty = useStore.getState().dirtyDocs();
  if (dirty.length === 0 || (await confirmDiscardAll(dirty.length))) {
    await quitApp();
  }
}

/**
 * App-lifetime wiring: native events in, imperative side effects out.
 * Lives outside React entirely — components stay declarative.
 */
export function initApp(): void {
  if (window.__MD_VIEWER_INITIALIZED__) return;
  window.__MD_VIEWER_INITIALIZED__ = true;

  void listen<string>("menu", (event) => handleMenu(event.payload));

  void listen<string[]>("open-files", (event) => {
    void useStore.getState().openPaths(event.payload);
  });

  void getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    const s = useStore.getState();
    if (payload.type === "enter" || payload.type === "over") {
      s.setDropping(true);
      if (payload.position) {
        const scale = window.devicePixelRatio || 1;
        trackDragCursor({
          x: payload.position.x / scale,
          y: payload.position.y / scale,
        });
      }
    } else if (payload.type === "leave") {
      s.setDropping(false);
    } else if (payload.type === "drop") {
      s.setDropping(false);
      if (!payload.paths.length) return;
      // Images get inserted into the editor; everything else opens as a document.
      const images = payload.paths.filter((p) => IMAGE_EXT.test(p));
      const documents = payload.paths.filter((p) => !IMAGE_EXT.test(p));
      if (images.length) {
        const scale = window.devicePixelRatio || 1;
        const point = payload.position
          ? { x: payload.position.x / scale, y: payload.position.y / scale }
          : null;
        insertDroppedImages(images, point);
      }
      if (documents.length) void s.openPaths(documents);
    }
  });

  void getCurrentWindow().onCloseRequested(async (event) => {
    const dirty = useStore.getState().dirtyDocs();
    if (dirty.length > 0 && !(await confirmDiscardAll(dirty.length))) {
      event.preventDefault();
    }
  });

  // Files queued before the frontend was ready (Finder "Open With", CLI args).
  void frontendReady().then((paths) => {
    if (paths.length) void useStore.getState().openPaths(paths);
    // Apply persisted preferences (theme, width, caret, custom keybinds) and
    // populate the Open Recent menu once the backend — and therefore the
    // native menu — is definitely up.
    applySettings(useSettings.getState().settings);
    initRecents();
  });

  // Native window title follows the focused document.
  let lastTitle = "";
  const syncTitle = () => {
    const state = useStore.getState();
    const leaf = findLeaf(state.root, state.focusedId);
    const doc = leaf ? state.docs[leaf.docId] : null;
    const docTitle = doc ? displayTitle(doc) : null;
    const title = docTitle && docTitle !== "Untitled" ? docTitle : "Markdown";
    if (title !== lastTitle) {
      lastTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  };
  useStore.subscribe(syncTitle);
  syncTitle();

  // Keyboard focus follows the focused tile.
  let lastFocusedId = useStore.getState().focusedId;
  useStore.subscribe((state) => {
    if (state.focusedId === lastFocusedId) return;
    lastFocusedId = state.focusedId;
    const leaf = findLeaf(state.root, state.focusedId);
    if (!leaf || leaf.mode === "preview") return;
    // A freshly created tile's editor mounts on the next React commit.
    requestAnimationFrame(() => {
      getEditorView(leaf.docId)?.focus();
    });
  });
}
