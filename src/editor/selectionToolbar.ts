import { showTooltip } from "@codemirror/view";
import type { Command, Tooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import {
  insertLink,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from "./commands";

interface ToolbarItem {
  label: string;
  title: string;
  className: string;
  run: Command;
}

const ITEMS: ToolbarItem[] = [
  { label: "B", title: "Bold · ⌘B", className: "fmt-bold", run: toggleBold },
  { label: "I", title: "Italic · ⌘I", className: "fmt-italic", run: toggleItalic },
  { label: "S", title: "Strikethrough · ⇧⌘X", className: "fmt-strike", run: toggleStrikethrough },
  { label: "<>", title: "Code · ⌘E", className: "fmt-code", run: toggleInlineCode },
  { label: "Link", title: "Link · ⌘K", className: "fmt-link", run: insertLink },
];

/** Floating formatting bar shown above a non-empty selection. */
function selectionTooltip(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  if (range.empty) return null;

  return {
    pos: range.from,
    above: true,
    strictSide: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-format-bar";
      for (const item of ITEMS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `cm-format-btn ${item.className}`;
        button.textContent = item.label;
        button.dataset.tip = item.title;
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          item.run(view);
        });
        dom.appendChild(button);
      }
      return { dom };
    },
  };
}

export const selectionToolbar = StateField.define<Tooltip | null>({
  create: selectionTooltip,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return selectionTooltip(tr.state);
  },
  provide: (field) => showTooltip.from(field),
});
