import type { LeafNode } from "../types";
import { useStore } from "../store";
import { useSettings } from "../settings";
import { Tile } from "./Tile";
import { Sidebar } from "./Sidebar";

/**
 * Renders the collapsible sidebar beside the single active document. Tabs (not
 * tiling) drive which document is visible — exactly one is shown at a time.
 */
export function Workspace() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  // Build the synthesized active leaf from primitive selectors so this only
  // re-renders when the active doc or its view state actually changes.
  const activeId = useStore((s) => s.activeId);
  const mode = useStore((s) => s.views[s.activeId]?.mode);
  const ratio = useStore((s) => s.views[s.activeId]?.ratio);
  const outline = useStore((s) => s.views[s.activeId]?.outline);

  const defaultMode = useSettings.getState().settings.defaultMode;
  const leaf: LeafNode = {
    type: "leaf",
    id: activeId,
    docId: activeId,
    mode: mode ?? defaultMode,
    ratio: ratio ?? 0.5,
    outline: outline ?? false,
  };

  return (
    <main className="workspace">
      {sidebarOpen && <Sidebar />}
      <div className="tile-slot" data-leaf-id={activeId}>
        <Tile leaf={leaf} />
      </div>
    </main>
  );
}
