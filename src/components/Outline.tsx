import { useStore } from "../store";
import { extractHeadings } from "../outline";
import type { Heading } from "../outline";
import { getEditorView } from "../editor/registry";
import { EditorView } from "@codemirror/view";
import type { LeafNode } from "../types";
import { CloseIcon } from "./icons";

/**
 * Scroll a heading into view in whichever pane is showing. Prefers the preview
 * (matched positionally — the Nth rendered heading is headings[index]); falls
 * back to the editor's line when only the editor is visible.
 */
function revealHeading(leaf: LeafNode, docId: string, heading: Heading) {
  if (leaf.mode !== "editor") {
    const article = document.querySelector<HTMLElement>(
      `.preview-content[data-doc-id="${docId}"]`,
    );
    const els = article?.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6");
    const target = els?.[heading.index];
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
  const view = getEditorView(docId);
  if (view) {
    const lineNo = Math.min(heading.line + 1, view.state.doc.lines);
    const pos = view.state.doc.line(lineNo).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
    view.focus();
  }
}

export function Outline({ leaf }: { leaf: LeafNode }) {
  const content = useStore((s) => s.docs[leaf.docId]?.content ?? "");
  const toggleOutline = useStore((s) => s.toggleOutline);
  const headings = extractHeadings(content);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);

  return (
    <aside className="outline">
      <header className="outline-header">
        <span>Outline</span>
        <button
          className="outline-close"
          data-tip="Hide outline · ⌃⌘O"
          onClick={() => toggleOutline(leaf.id)}
        >
          <CloseIcon size={13} />
        </button>
      </header>
      <nav className="outline-list">
        {headings.length === 0 ? (
          <p className="outline-empty">No headings</p>
        ) : (
          headings.map((h) => (
            <button
              key={h.index}
              className="outline-item"
              style={{ paddingLeft: `${10 + (h.level - minLevel) * 14}px` }}
              title={h.text}
              onClick={() => revealHeading(leaf, leaf.docId, h)}
            >
              {h.text}
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}
