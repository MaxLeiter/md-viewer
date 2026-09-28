import { useStore } from "../store";
import { displayTitle, isDirty } from "../types";
import { CloseIcon, SwapIcon } from "./icons";

/**
 * Collapsible left rail listing every open document vertically. Mirrors the tab
 * strip; clicking an entry activates it, the ✕ closes it.
 */
export function Sidebar() {
  const tabs = useStore((s) => s.tabs);
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const width = useStore((s) => s.sidebarWidth);

  // Drag the right edge to resize; width is clamped + persisted in the store.
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    document.body.classList.add("resizing-x");
    const move = (ev: PointerEvent) => {
      useStore.getState().setSidebarWidth(startWidth + (ev.clientX - startX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">Open</div>
      <nav className="sidebar-list">
        {tabs.map((docId) => {
          const doc = docs[docId];
          if (!doc) return null;
          const active = docId === activeId;
          return (
            <div
              key={docId}
              className={`sidebar-item${active ? " active" : ""}`}
              onPointerDown={() => selectTab(docId)}
              title={displayTitle(doc)}
            >
              {doc.remote && (
                <span className="remote-badge" data-tip={`SSH · ${doc.remote.host}`}>
                  <SwapIcon size={11} />
                </span>
              )}
              <span className="sidebar-name">{displayTitle(doc)}</span>
              {isDirty(doc) && <span className="dirty-dot" aria-label="Unsaved changes" />}
              <button
                className="sidebar-close"
                data-tip="Close tab · ⌘W"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(docId);
                }}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          );
        })}
      </nav>
      <div className="sidebar-resizer" onPointerDown={startResize} />
    </aside>
  );
}
