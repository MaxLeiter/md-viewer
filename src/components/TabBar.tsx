import { useStore } from "../store";
import { displayTitle, isDirty } from "../types";
import { useModHeld } from "../keybindings/useModHeld";
import { CloseIcon, SwapIcon } from "./icons";

/**
 * Browser-style tab strip: every open document, in tab order. Clicking a tab
 * activates it; the ✕ closes it; dragging a tab left/right reorders it. While
 * ⌘/Ctrl is held, the first nine tabs show a ⌘N keycap (jump-to-tab hint).
 */
export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const selectTab = useStore((s) => s.selectTab);
  const closeTab = useStore((s) => s.closeTab);
  const newDoc = useStore((s) => s.newDoc);
  const modHeld = useModHeld();

  // Drag a tab horizontally to reorder it. Selecting happens on pointerdown;
  // reordering kicks in once the pointer moves past a small threshold.
  const startTabDrag = (event: React.PointerEvent, docId: string) => {
    if (event.button !== 0) return;
    selectTab(docId);
    const list = event.currentTarget.parentElement;
    if (!list) return;
    const startX = event.clientX;
    let dragging = false;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5) return;
        dragging = true;
        document.body.classList.add("tab-dragging");
      }
      const els = Array.from(list.querySelectorAll<HTMLElement>(".tab"));
      let target = els.length - 1;
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) {
          target = i;
          break;
        }
      }
      useStore.getState().reorderTab(docId, target);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tab-dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="tabbar">
      <div className="tab-list">
        {tabs.map((docId, i) => {
          const doc = docs[docId];
          if (!doc) return null;
          const active = docId === activeId;
          return (
            <div
              key={docId}
              className={`tab${active ? " active" : ""}`}
              onPointerDown={(e) => startTabDrag(e, docId)}
              title={displayTitle(doc)}
            >
              {modHeld && i < 9 && <span className="tab-keycap">⌘{i + 1}</span>}
              {doc.remote && (
                <span className="remote-badge" data-tip={`SSH · ${doc.remote.host}`}>
                  <SwapIcon size={11} />
                </span>
              )}
              <span className="tab-name">{displayTitle(doc)}</span>
              {isDirty(doc) && <span className="dirty-dot" aria-label="Unsaved changes" />}
              <button
                className="tab-close"
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
      </div>
      <button className="tab-new" data-tip="New file · ⌘N" onClick={newDoc}>
        ＋
      </button>
    </div>
  );
}
