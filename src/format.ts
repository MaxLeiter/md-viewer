import { EditorSelection } from "@codemirror/state";
import { getEditorView } from "./editor/registry";
import { showError } from "./ipc";

/** Format markdown source with Prettier (lazy-loaded to keep startup lean). */
export async function formatMarkdown(source: string): Promise<string | null> {
  try {
    const [prettier, markdownPlugin] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/markdown"),
    ]);
    const formatted = await prettier.format(source, {
      parser: "markdown",
      plugins: [markdownPlugin.default],
      proseWrap: "preserve",
    });
    return formatted;
  } catch (err) {
    await showError(`Could not format: ${String(err)}`);
    return null;
  }
}

/** Format the document in an editor view, preserving the caret line/column. */
export async function formatDocument(docId: string): Promise<void> {
  const view = getEditorView(docId);
  if (!view) return;
  const source = view.state.doc.toString();
  const formatted = await formatMarkdown(source);
  if (formatted === null || formatted === source) return;

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const row = line.number;
  const col = head - line.from;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: formatted },
  });

  // Best-effort caret restore at the same line/column.
  const doc = view.state.doc;
  if (row <= doc.lines) {
    const target = doc.line(row);
    const pos = Math.min(target.from + col, target.to);
    view.dispatch({ selection: EditorSelection.cursor(pos) });
  }
  view.focus();
}
