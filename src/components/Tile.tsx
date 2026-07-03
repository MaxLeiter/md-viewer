import { useCallback } from "react";
import type { DropRegion, LeafNode } from "../types";
import { displayTitle, isDirty } from "../types";
import { countLeaves } from "../tree";
import { useStore } from "../store";
import { showTileContextMenu } from "../contextMenu";
import { Editor } from "./Editor";
import { Preview } from "./Preview";
import { Outline } from "./Outline";
import { CloseIcon, SwapIcon } from "./icons";

export function Tile({ leaf }: { leaf: LeafNode }) {
  const doc = useStore((s) => s.docs[leaf.docId]);
  const focused = useStore((s) => s.focusedId === leaf.id);
  const multiple = useStore((s) => countLeaves(s.root) > 1);
  const focusLeaf = useStore((s) => s.focusLeaf);
  const closeLeaf = useStore((s) => s.closeLeaf);
  const setRatio = useStore((s) => s.setRatio);

  // Keep editor and preview scroll positions roughly in sync. Scroll events
  // don't bubble but they do capture, so one delegated listener on the tile
  // body covers both panes — and keeps working when the editor or preview
  // element is recreated (document swapped into the tile, mode changes, …).
  const attachBody = useCallback((body: HTMLDivElement | null) => {
    if (!body) return;

    let active: HTMLElement | null = null;
    let release: ReturnType<typeof setTimeout> | undefined;

    const onScroll = (event: Event) => {
      const target = event.target as HTMLElement;
      const isEditor = target.classList.contains("cm-scroller");
      const isPreview = target.classList.contains("preview");
      if (!isEditor && !isPreview) return;

      const counterpart = isEditor
        ? body.querySelector<HTMLElement>(".preview")
        : body.querySelector<HTMLElement>(".cm-scroller");
      if (!counterpart) return;

      // Only follow the pane the user is actually scrolling.
      if (active && active !== target) return;
      active = target;
      clearTimeout(release);
      release = setTimeout(() => (active = null), 120);

      const max = target.scrollHeight - target.clientHeight;
      if (max <= 0) return;
      counterpart.scrollTop =
        (target.scrollTop / max) * (counterpart.scrollHeight - counterpart.clientHeight);
    };

    body.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      clearTimeout(release);
      body.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, []);

  if (!doc) return null;

  const dirty = isDirty(doc);
  const empty = !/\S/.test(doc.content);
  const showEditor = leaf.mode !== "preview";
  const showPreview = leaf.mode !== "editor";
  const editorFlex = showEditor ? `${leaf.ratio * 100} 1 0%` : "0.0001 1 0%";
  const previewFlex = showPreview ? `${(1 - leaf.ratio) * 100} 1 0%` : "0.0001 1 0%";

  const startPaneDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const body = (event.currentTarget as HTMLElement).parentElement;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    document.body.classList.add("resizing-x");

    const move = (ev: PointerEvent) => {
      const ratio = (ev.clientX - rect.left) / rect.width;
      setRatio(leaf.id, Math.min(0.85, Math.max(0.15, ratio)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-x");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onContextMenu = (event: React.MouseEvent) => {
    // Inside the editor keep the native menu (copy/paste, spelling, …).
    if ((event.target as HTMLElement).closest(".cm-editor")) return;
    event.preventDefault();
    void showTileContextMenu(leaf.id);
  };

  // Drag the header to rearrange tiles: drop on another tile's middle to swap
  // places, or on one of its edges to re-tile next to it.
  const startHeaderDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tile-close")) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;

    const move = (ev: PointerEvent) => {
      const store = useStore.getState();
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        started = true;
        document.body.classList.add("tile-dragging");
        store.beginTileDrag(leaf.id);
      }

      const slot = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>("[data-leaf-id]");
      const targetId = slot?.dataset.leafId ?? null;
      if (!slot || !targetId || targetId === leaf.id) {
        store.updateTileDrag(null, null);
        return;
      }

      const rect = slot.getBoundingClientRect();
      const nx = (ev.clientX - rect.left) / rect.width;
      const ny = (ev.clientY - rect.top) / rect.height;
      let region: DropRegion = "center";
      if (nx < 0.25 || nx > 0.75 || ny < 0.25 || ny > 0.75) {
        const edges: [number, DropRegion][] = [
          [nx, "left"],
          [1 - nx, "right"],
          [ny, "top"],
          [1 - ny, "bottom"],
        ];
        edges.sort((a, b) => a[0] - b[0]);
        region = edges[0][1];
      }
      store.updateTileDrag(targetId, region);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tile-dragging");
      if (started) useStore.getState().endTileDrag(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      className={`tile${focused ? " focused" : ""}`}
      onPointerDownCapture={() => focusLeaf(leaf.id)}
      onContextMenu={onContextMenu}
    >
      {multiple && (
        <header className="tile-header" onPointerDown={startHeaderDrag}>
          <span className="tile-title">
            {doc.remote && (
              <span className="remote-badge" data-tip={`SSH · ${doc.remote.host}`}>
                <SwapIcon size={12} />
              </span>
            )}
            <span className="tile-name">{displayTitle(doc)}</span>
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
          </span>
          <button
            className="tile-close"
            data-tip="Close pane · ⌘W"
            onClick={() => void closeLeaf(leaf.id)}
          >
            <CloseIcon size={13} />
          </button>
        </header>
      )}
      <div className="tile-body" ref={attachBody}>
        {leaf.outline && <Outline leaf={leaf} />}
        <div className={`pane${showEditor ? "" : " pane-hidden"}`} style={{ flex: editorFlex }}>
          <Editor doc={doc} />
        </div>
        {leaf.mode === "split" && (
          <div className="pane-divider" onPointerDown={startPaneDrag} />
        )}
        <div className={`pane${showPreview ? "" : " pane-hidden"}`} style={{ flex: previewFlex }}>
          <Preview docId={doc.id} empty={empty} />
        </div>
      </div>
    </section>
  );
}
