import type { EditorView } from "@codemirror/view";

/**
 * Live CodeMirror views by document id, so non-React code (menu handlers,
 * the title-bar table picker, focus management) can reach the editor.
 */
const views = new Map<string, EditorView>();

export function registerEditorView(docId: string, view: EditorView): void {
  views.set(docId, view);
}

export function unregisterEditorView(docId: string, view: EditorView): void {
  if (views.get(docId) === view) views.delete(docId);
}

export function getEditorView(docId: string): EditorView | undefined {
  return views.get(docId);
}

export function allEditorViews(): EditorView[] {
  return [...views.values()];
}
