import { useCallback, useState } from "react";
import {
  addAnnotation,
  anchorFromSelection,
  findAnnotation,
  HIGHLIGHT_COLORS,
  removeAnnotation,
  updateAnnotation,
} from "../annotations";
import { keyForDoc } from "../annotations";
import { useStore } from "../store";
import { CommentIcon } from "./icons";

/** The on-screen rect of the selection/annotation a popup anchors to. */
interface AnchorRect {
  cx: number; // horizontal center
  top: number;
  bottom: number;
}

interface ToolbarState {
  anchor: AnchorRect;
  key: string;
  sel: { quote: string; prefix: string; suffix: string };
}

interface PopoverState {
  anchor: AnchorRect;
  key: string;
  id: string;
}

const MARGIN = 8;
const BAR_H = 34;
const POP_W = 240;
const POP_H = 132;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Center-x clamped, placed above the anchor or flipped below if no room. */
function barStyle(a: AnchorRect): { left: number; top: number } {
  const left = clamp(a.cx, MARGIN + 90, window.innerWidth - MARGIN - 90);
  const above = a.top - BAR_H - MARGIN;
  const top = above >= MARGIN ? above : a.bottom + MARGIN;
  return { left, top: clamp(top, MARGIN, window.innerHeight - BAR_H - MARGIN) };
}

/** Left clamped to the viewport, placed below the anchor or flipped above. */
function popoverStyle(a: AnchorRect): { left: number; top: number } {
  const left = clamp(a.cx - POP_W / 2, MARGIN, window.innerWidth - POP_W - MARGIN);
  const below = a.bottom + MARGIN;
  const top = below + POP_H <= window.innerHeight - MARGIN ? below : a.top - POP_H - MARGIN;
  return { left, top: clamp(top, MARGIN, window.innerHeight - POP_H - MARGIN) };
}

function keyForPreview(el: HTMLElement | null): string | null {
  const article = el?.closest<HTMLElement>("[data-doc-id]");
  const docId = article?.dataset.docId;
  if (!docId) return null;
  return keyForDoc(useStore.getState().docs[docId]);
}

export function AnnotationLayer() {
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [draft, setDraft] = useState("");

  // One document-level pointer/selection listener (bound once via ref callback).
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;

    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as HTMLElement;

      // Clicks inside our own toolbar/popover must not tear it down here —
      // otherwise the React re-render detaches the button before its click
      // fires, and "Add comment"/highlight silently do nothing.
      if (target.closest(".annotate-bar, .annotate-popover")) return;

      // A click anywhere else dismisses an open note popover.
      setPopover(null);

      // Click on an existing annotation → open its popover.
      const span = target.closest<HTMLElement>("span.annotation[data-id]");
      if (span) {
        const key = keyForPreview(span);
        const id = span.dataset.id;
        if (key && id) {
          const r = span.getBoundingClientRect();
          setToolbar(null);
          setDraft(findAnnotation(key, id)?.note ?? "");
          setPopover({ anchor: { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom }, key, id });
          return;
        }
      }

      // Otherwise, a fresh selection inside a preview → show the create toolbar.
      const preview = target.closest<HTMLElement>(".preview-content");
      if (!preview) {
        setToolbar(null);
        return;
      }
      const key = keyForPreview(preview);
      if (!key) {
        setToolbar(null);
        return;
      }
      const sel = anchorFromSelection(preview);
      if (!sel) {
        setToolbar(null);
        return;
      }
      const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      if (!r) return;
      setPopover(null);
      setToolbar({
        anchor: { cx: r.left + r.width / 2, top: r.top, bottom: r.bottom },
        key,
        sel,
      });
    };

    node.ownerDocument.addEventListener("pointerup", onPointerUp);
    return () => node.ownerDocument.removeEventListener("pointerup", onPointerUp);
  }, []);

  const createHighlight = (color: string, withNote: boolean) => {
    if (!toolbar) return;
    const created = addAnnotation(toolbar.key, { ...toolbar.sel, color, note: "" });
    window.getSelection()?.removeAllRanges();
    if (withNote) {
      setDraft("");
      setPopover({ anchor: toolbar.anchor, key: toolbar.key, id: created.id });
    }
    setToolbar(null);
  };

  const popoverAnnotation = popover ? findAnnotation(popover.key, popover.id) : undefined;

  return (
    <div ref={attach}>
      {toolbar && (
        <div
          className="annotate-bar"
          style={barStyle(toolbar.anchor)}
          onPointerDown={(e) => e.preventDefault()}
        >
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              className="annotate-swatch"
              style={{ backgroundColor: color }}
              data-tip="Highlight"
              onClick={() => createHighlight(color, false)}
            />
          ))}
          <span className="annotate-divider" />
          <button
            className="annotate-comment"
            data-tip="Add comment"
            onClick={() => createHighlight(HIGHLIGHT_COLORS[0], true)}
          >
            <CommentIcon />
          </button>
        </div>
      )}

      {popover && popoverAnnotation && (
        <div
          className="annotate-popover"
          style={popoverStyle(popover.anchor)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <textarea
            className="annotate-note"
            placeholder="Add a note…"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => updateAnnotation(popover.key, popover.id, { note: draft })}
          />
          <div className="annotate-popover-actions">
            <div className="annotate-colors">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  className={`annotate-swatch${
                    popoverAnnotation.color === color ? " active" : ""
                  }`}
                  style={{ backgroundColor: color }}
                  onClick={() => updateAnnotation(popover.key, popover.id, { color })}
                />
              ))}
            </div>
            <button
              className="annotate-delete"
              onClick={() => {
                removeAnnotation(popover.key, popover.id);
                setPopover(null);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
