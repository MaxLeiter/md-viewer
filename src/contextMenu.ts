import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "./store";

/**
 * Native right-click menu for a tab/document. Built fresh each time so it
 * reflects the current document (e.g. "Reveal in Finder" only when saved to
 * disk). `docId` is the document the menu acts on (the active doc's id).
 */
export async function showTileContextMenu(docId: string): Promise<void> {
  const state = useStore.getState();
  const doc = state.docs[docId];
  if (!doc) return;
  const path = doc.path ?? null;
  // Reload/Copy Path need a backing file (local path or remote SSH ref).
  const hasFile = !!(doc.path || doc.remote);
  state.selectTab(docId);

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
    ...(path ? [item("Reveal in Finder", () => void revealItemInDir(path))] : []),
    item("Close Tab", () => void useStore.getState().closeTab(docId)),
  ]);

  const menu = await Menu.new({ items });
  await menu.popup();
}
