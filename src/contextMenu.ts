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
  const path = state.docs[leaf.docId]?.path ?? null;
  state.focusLeaf(leafId);

  const separator = () => PredefinedMenuItem.new({ item: "Separator" });
  const item = (text: string, action: () => void) => MenuItem.new({ text, action });

  const items = await Promise.all([
    item("New File", () => useStore.getState().newDoc()),
    item("Open…", () => void useStore.getState().openViaDialog()),
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
