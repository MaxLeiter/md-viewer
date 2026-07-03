import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { Command, KeyBinding } from "@codemirror/view";

/* ---------------------------------------------------------------------------
   Table cell navigation: Tab / Shift-Tab move between cells, Tab on the last
   cell appends a new row. Cells are located textually (between unescaped
   pipes) so empty cells navigate fine too.
--------------------------------------------------------------------------- */

interface CellRange {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

function findTable(state: EditorState, pos: number): { from: number; to: number } | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      if (node.name === "Table") return { from: node.from, to: node.to };
      node = node.parent;
    }
  }
  return null;
}

function isDelimiterRow(text: string): boolean {
  return /^\s*\|?[\s:|-]*$/.test(text) && text.includes("-");
}

/** Cell ranges for one table row line. */
function rowCells(state: EditorState, lineFrom: number, lineTo: number): CellRange[] {
  const text = state.sliceDoc(lineFrom, lineTo);
  if (isDelimiterRow(text)) return [];

  const cells: CellRange[] = [];
  let segStart = 0;
  for (let i = 0; i <= text.length; i++) {
    const isPipe = i < text.length && text[i] === "|" && (i === 0 || text[i - 1] !== "\\");
    if (!isPipe && i < text.length) continue;

    const raw = text.slice(segStart, i);
    const leadingPipeSegment = cells.length === 0 && segStart === 0 && text.trimStart().startsWith("|");
    if (!(leadingPipeSegment && raw.trim() === "")) {
      const trimStart = raw.length - raw.trimStart().length;
      const trimEnd = raw.length - raw.trimEnd().length;
      cells.push({
        from: lineFrom + segStart,
        to: lineFrom + i,
        contentFrom: lineFrom + segStart + trimStart,
        contentTo: lineFrom + i - trimEnd,
      });
    }
    segStart = i + 1;
  }

  // Drop the empty segment after a trailing pipe.
  if (cells.length && text.trimEnd().endsWith("|")) {
    const last = cells[cells.length - 1];
    if (state.sliceDoc(last.from, last.to).trim() === "" && last.from > lineFrom + text.lastIndexOf("|")) {
      cells.pop();
    }
  }
  return cells;
}

function tableCells(state: EditorState, table: { from: number; to: number }): CellRange[] {
  const cells: CellRange[] = [];
  let pos = table.from;
  for (;;) {
    const line = state.doc.lineAt(pos);
    cells.push(...rowCells(state, line.from, Math.min(line.to, table.to)));
    if (line.to >= table.to) break;
    pos = line.to + 1;
  }
  return cells;
}

function selectCell(cell: CellRange) {
  return cell.contentFrom < cell.contentTo
    ? EditorSelection.range(cell.contentFrom, cell.contentTo)
    : EditorSelection.cursor(Math.min(cell.from + 1, cell.to));
}

export const nextTableCell: Command = (view) => {
  const { state } = view;
  const head = state.selection.main.head;
  const table = findTable(state, head);
  if (!table) return false;
  const cells = tableCells(state, table);
  if (!cells.length) return false;

  const currentIndex = cells.findIndex((c) => head >= c.from && head <= c.to);
  const next =
    currentIndex >= 0 ? cells[currentIndex + 1] : cells.find((c) => c.from > head);

  if (next) {
    view.dispatch({ selection: selectCell(next), scrollIntoView: true });
    return true;
  }

  // Already on the last cell: append a fresh row and move into it.
  const headerLine = state.doc.lineAt(table.from);
  const columns = Math.max(1, rowCells(state, headerLine.from, headerLine.to).length);
  const lastLine = state.doc.lineAt(table.to);
  const newRow = `\n|${"   |".repeat(columns)}`;
  view.dispatch({
    changes: { from: lastLine.to, insert: newRow },
    selection: EditorSelection.cursor(lastLine.to + 3),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

export const previousTableCell: Command = (view) => {
  const { state } = view;
  const head = state.selection.main.head;
  const table = findTable(state, head);
  if (!table) return false;
  const cells = tableCells(state, table);
  if (!cells.length) return false;

  const currentIndex = cells.findIndex((c) => head >= c.from && head <= c.to);
  let previous: CellRange | undefined;
  if (currentIndex > 0) {
    previous = cells[currentIndex - 1];
  } else if (currentIndex === -1) {
    previous = [...cells].reverse().find((c) => c.to < head);
  }

  if (previous) {
    view.dispatch({ selection: selectCell(previous), scrollIntoView: true });
  }
  // Swallow Shift-Tab inside tables either way so the row never gets dedented.
  return true;
};

/* ---------------------------------------------------------------------------
   Task list items: ⌘Enter toggles the checkbox on the current line(s).
--------------------------------------------------------------------------- */

export const toggleTaskItem: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    if (seen.has(line.from)) continue;
    seen.add(line.from);
    const match = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(line.text);
    if (!match) continue;
    const checkboxAt = line.from + match[1].length;
    changes.push({
      from: checkboxAt,
      to: checkboxAt + 1,
      insert: match[2] === " " ? "x" : " ",
    });
  }

  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input" });
  return true;
};

// Mod-Enter (toggle task) is user-rebindable and lives in the settings-driven
// keymap compartment; only the fixed Tab navigation stays here.
export const navigationKeymap: KeyBinding[] = [
  { key: "Tab", run: nextTableCell, shift: previousTableCell },
];
