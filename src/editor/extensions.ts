import { Decoration, drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import type { DecorationSet, KeyBinding } from "@codemirror/view";
import { Compartment, Prec, RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";
import {
  insertLink,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from "./commands";
import { navigationKeymap, toggleTaskItem } from "./navigation";
import { selectionToolbar } from "./selectionToolbar";

/**
 * User-rebindable editor shortcuts live in a compartment so the settings
 * panel can reconfigure them on every open editor without recreating views.
 */
export const editorKeybindCompartment = new Compartment();

export function editorKeybindings(binds: Record<string, string>): Extension {
  const key = (id: string, fallback: string) => binds[id] ?? fallback;
  const bindings: KeyBinding[] = [
    { key: key("fmt-bold", "Mod-b"), run: toggleBold },
    { key: key("fmt-italic", "Mod-i"), run: toggleItalic },
    { key: key("fmt-code", "Mod-e"), run: toggleInlineCode },
    { key: key("fmt-strike", "Mod-Shift-x"), run: toggleStrikethrough },
    { key: key("fmt-link", "Mod-k"), run: insertLink },
    { key: key("task-toggle", "Mod-Enter"), run: toggleTaskItem },
  ];
  return keymap.of(bindings);
}

/**
 * Auto-pair markdown emphasis markers and brackets: typing `*`, `_`, `~`,
 * `` ` ``, quotes or brackets inserts the closing marker after the cursor,
 * typing over the closer skips it, Backspace removes the pair, and typing a
 * marker with a selection wraps it.
 */
const markdownPairing = markdownLanguage.data.of({
  closeBrackets: {
    brackets: ["(", "[", "{", "'", '"', "`", "*", "_", "~"],
    before: ")]}:;>*_~`'\"",
  },
});

/**
 * YAML frontmatter at the top of a document would otherwise be parsed as a
 * setext heading (text followed by ---) and rendered huge. Style the whole
 * block as quiet, monospaced metadata instead.
 */
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

function frontmatterDecorations(state: EditorState): DecorationSet {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 4000));
  const match = FRONTMATTER_BLOCK.exec(head);
  if (!match) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const end = Math.min(match[0].length, state.doc.length);
  for (let pos = 0; pos < end; ) {
    const line = state.doc.lineAt(pos);
    builder.add(line.from, line.from, Decoration.line({ class: "cm-frontmatter" }));
    pos = line.to + 1;
  }
  return builder.finish();
}

const frontmatterStyling = StateField.define<DecorationSet>({
  create: frontmatterDecorations,
  update(value, tr) {
    if (!tr.docChanged) return value;
    return frontmatterDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Pasting a URL while text is selected wraps the selection as a markdown link
 * rather than overwriting it. Bare URLs with no selection paste normally.
 */
const URL_PASTE_PATTERN = /^(?:https?|mailto|tel|ftp|file|mdviewer):\/\/\S+$|^mailto:\S+@\S+$/i;

const pasteLinkify = EditorView.domEventHandlers({
  paste(event, view) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return false;
    const url = text.trim();
    if (!URL_PASTE_PATTERN.test(url) || /\s/.test(url)) return false;
    const { from, to } = view.state.selection.main;
    if (from === to) return false;
    event.preventDefault();
    const selected = view.state.sliceDoc(from, to);
    const link = `[${selected}](${url})`;
    view.dispatch({
      changes: { from, to, insert: link },
      selection: { anchor: from + link.length },
      userEvent: "input.paste",
    });
    return true;
  },
});

/**
 * Don't auto-pair `*` when it starts a bullet list item (only whitespace
 * before it on the line) — a stray closing `*` there is never wanted.
 */
const listMarkerGuard = Prec.high(
  EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== "*" || from !== to) return false;
    const line = view.state.doc.lineAt(from);
    if (/\S/.test(view.state.sliceDoc(line.from, from))) return false;
    view.dispatch({
      changes: { from, insert: "*" },
      selection: { anchor: from + 1 },
      userEvent: "input.type",
    });
    return true;
  }),
);

/**
 * Live markdown styling: formatting is applied inline while the syntax
 * markers (**, #, >, `) stay visible, just dimmed.
 */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.7em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.45em", fontWeight: "700", lineHeight: "1.3" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "650", lineHeight: "1.3" },
  { tag: t.heading4, fontSize: "1.1em", fontWeight: "650" },
  { tag: t.heading5, fontWeight: "650" },
  { tag: t.heading6, fontWeight: "650", color: "var(--fg-muted)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--fg-muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--fg-faint)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: t.contentSeparator, color: "var(--fg-faint)" },
  { tag: t.processingInstruction, color: "var(--fg-faint)" },
  { tag: t.escape, color: "var(--fg-faint)" },
  { tag: t.labelName, color: "var(--fg-muted)" },
  { tag: t.atom, color: "var(--accent)" },
  { tag: t.meta, color: "var(--fg-muted)" },

  // Fenced code block contents (nested language parsers).
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-func)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-prop)" },
  { tag: [t.operator, t.punctuation], color: "var(--fg-muted)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "calc(15px * var(--content-scale, 1))",
    backgroundColor: "transparent",
    color: "var(--fg)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-prose)",
    lineHeight: "1.65",
    overflowX: "hidden",
  },
  ".cm-content": {
    maxWidth: "var(--content-width, 44rem)",
    margin: "0 auto",
    padding: "28px 32px 45vh",
    caretColor: "var(--accent)",
  },
  ".cm-line": {
    padding: "0",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
    marginLeft: "-1px",
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
  ".cm-placeholder": {
    color: "var(--fg-faint)",
  },
  ".cm-panels": {
    backgroundColor: "var(--bg-secondary)",
    color: "var(--fg)",
    borderTop: "1px solid var(--border)",
    padding: "2px 6px",
  },
  ".cm-panels button": {
    color: "var(--fg)",
  },
  ".cm-panels input": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--search-match-selected)",
  },
});

export function editorExtensions(keybinds: Record<string, string> = {}): Extension[] {
  return [
    history(),
    EditorView.lineWrapping,
    // Custom-drawn caret/selection so the caret can glide (Word-style).
    drawSelection({ cursorBlinkRate: 1100 }),
    placeholder("Write…"),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlight),
    selectionToolbar,
    frontmatterStyling,
    markdownPairing,
    listMarkerGuard,
    pasteLinkify,
    closeBrackets(),
    editorKeybindCompartment.of(editorKeybindings(keybinds)),
    keymap.of([
      ...navigationKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
    ]),
    editorTheme,
  ];
}
