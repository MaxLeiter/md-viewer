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
  // Only the active document is visible, so there's a single editor to consider.
  const view = getEditorView(useStore.getState().activeId);
  if (!view) return null;
  const rect = view.dom.getBoundingClientRect();
  if (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  ) {
    return view;
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

  // Images always land in the active document's editor (the only visible one).
  const docId = s.activeId;
  const view = getEditorView(docId);
  if (!view) return;

  const docPath = s.docs[docId]?.path ?? null;
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
  if (s.views[docId]?.mode === "preview") s.setMode(docId, "split");
  view.focus();
}

/**
 * ⌘A. Replaces the native Select All, which does nothing unless a text field
 * has focus (e.g. in preview mode). Picks the target the user means: a focused
 * input, else the editor when it's focused or the only pane, else the preview.
 */
function selectAll() {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    focused.select();
    return;
  }
  const s = useStore.getState();
  const mode = s.views[s.activeId]?.mode;
  const view = getEditorView(s.activeId);
  if (view && (view.hasFocus || mode === "editor")) {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
    return;
  }
  const preview = document.querySelector<HTMLElement>(".tile .preview");
  if (preview && mode !== "editor") {
    const range = document.createRange();
    range.selectNodeContents(preview);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
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
  // ⌘1…⌘9 jump straight to a tab by index.
  if (/^tab-[1-9]$/.test(id)) {
    s.jumpToTab(Number(id.slice("tab-".length)) - 1);
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
      s.setRemoteBrowser("open");
      break;
    case "save-remote":
      s.setRemoteBrowser("save");
      break;
    case "select-all":
      selectAll();
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
      void s.closeTab();
      break;
    case "mode-editor":
    case "mode-split":
    case "mode-preview":
      s.setMode(s.activeId, id.replace("mode-", "") as "editor" | "split" | "preview");
      break;
    case "toggle-preview":
      s.togglePreview();
      break;
    case "reload":
      void s.reloadDoc(s.activeId);
      break;
    case "copy-path":
      void s.copyDocPath(s.activeId);
      break;
    case "paste-plain": {
      // ⌘V in the editor is already plain text; this covers the ⇧⌘V muscle memory.
      const view = getEditorView(s.activeId);
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
    case "toggle-outline":
      s.toggleOutline(s.activeId);
      break;
    case "focus-next":
    case "tab-next":
      s.nextTab();
      break;
    case "focus-prev":
    case "tab-prev":
      s.prevTab();
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

  // Native window title follows the active document.
  let lastTitle = "";
  const syncTitle = () => {
    const state = useStore.getState();
    const doc = state.docs[state.activeId] ?? null;
    const docTitle = doc ? displayTitle(doc) : null;
    const title = docTitle && docTitle !== "Untitled" ? docTitle : "Markdown";
    if (title !== lastTitle) {
      lastTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  };
  useStore.subscribe(syncTitle);
  syncTitle();

  // Keyboard focus follows the active tab.
  let lastActiveId = useStore.getState().activeId;
  useStore.subscribe((state) => {
    if (state.activeId === lastActiveId) return;
    lastActiveId = state.activeId;
    if (state.views[state.activeId]?.mode === "preview") return;
    // A freshly activated tab's editor mounts on the next React commit.
    requestAnimationFrame(() => {
      getEditorView(state.activeId)?.focus();
    });
  });
}
