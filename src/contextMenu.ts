import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "./store";
import { findLeaf } from "./tree";

/**
 * Native right-click menu for a tile. Built fresh each time so it reflects
 * the current document (e.g. "Reveal in Finder" only when saved to disk).
 */
export async function showTileContextMenu(leafId: string): Promise<void> {
  const state = useStore.getState();
  const leaf = findLeaf(state.root, leafId);
  if (!leaf) return;
  const docId = leaf.docId;
  const doc = state.docs[docId];
  const path = doc?.path ?? null;
  // Reload/Copy Path need a backing file (local path or remote SSH ref).
  const hasFile = !!(doc && (doc.path || doc.remote));
  state.focusLeaf(leafId);

  const separator = () => PredefinedMenuItem.new({ item: "Separator" });
  const item = (text: string, action: () => void) => MenuItem.new({ text, action });

  const items = await Promise.all([
    item("New File", () => useStore.getState().newDoc()),
    item("Open…", () => void useStore.getState().openViaDialog()),
    ...(hasFile
      ? [
          separator(),
          item("Reload", () => void useStore.getState().reloadDoc(docId)),
          item("Copy Path", () => void useStore.getState().copyDocPath(docId)),
        ]
      : []),
    separator(),
    item("New Pane Right", () => useStore.getState().splitFocused("row")),
    item("New Pane Left", () => useStore.getState().splitFocused("row", true)),
    item("New Pane Below", () => useStore.getState().splitFocused("col")),
    separator(),
    ...(path ? [item("Reveal in Finder", () => void revealItemInDir(path))] : []),
    item("Close Pane", () => void useStore.getState().closeLeaf(leafId)),
  ]);

  const menu = await Menu.new({ items });
  await menu.popup();
}
