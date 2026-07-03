import { EditorSelection } from "@codemirror/state";
import type { Command, EditorView, KeyBinding } from "@codemirror/view";

/** Toggle an inline marker (e.g. ** or *) around every selection range. */
function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view;
  const len = marker.length;

  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const before = state.sliceDoc(Math.max(0, from - len), from);
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + len));
    const selected = state.sliceDoc(from, to);

    // Already wrapped, markers just outside the selection → unwrap.
    if (before === marker && after === marker) {
      return {
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        range: EditorSelection.range(from - len, to - len),
      };
    }
    // Already wrapped, markers inside the selection → unwrap.
    if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
      return {
        changes: [
          { from, to: from + len },
          { from: to - len, to },
        ],
        range: EditorSelection.range(from, to - len * 2),
      };
    }
    // Wrap.
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + len, to + len),
    };
  });

  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  view.focus();
  return true;
}

export const toggleBold: Command = (view) => toggleWrap(view, "**");
export const toggleItalic: Command = (view) => toggleWrap(view, "*");
export const toggleStrikethrough: Command = (view) => toggleWrap(view, "~~");
export const toggleInlineCode: Command = (view) => toggleWrap(view, "`");

export const insertLink: Command = (view) => {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (/^https?:\/\/\S+$/i.test(text)) {
      // The selection is a URL — wrap it and put the cursor in the label.
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const label = text || "link text";
    const insert = `[${label}](url)`;
    const urlStart = range.from + label.length + 3; // past "[label]("
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(urlStart, urlStart + 3), // select "url"
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  view.focus();
  return true;
};

/** Insert a GFM table at the end of the current line. */
export function insertTable(view: EditorView, rows: number, cols: number): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const headerCells = Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
  const header = `| ${headerCells.join(" | ")} |`;
  const separator = `| ${Array(cols).fill("---").join(" | ")} |`;
  const body = Array.from(
    { length: rows },
    () => `| ${Array(cols).fill("    ").join(" | ")} |`,
  ).join("\n");

  const prefix = line.length > 0 ? "\n\n" : "";
  const insert = `${prefix}${header}\n${separator}\n${body}\n`;
  const start = line.to + prefix.length;

  view.dispatch({
    changes: { from: line.to, insert },
    // Select the first header cell so typing replaces it immediately.
    selection: EditorSelection.range(start + 2, start + 2 + headerCells[0].length),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
}

export const formatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-e", run: toggleInlineCode },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-k", run: insertLink },
];
