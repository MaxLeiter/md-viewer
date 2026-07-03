import { useCallback } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { editorExtensions } from "../editor/extensions";
import { registerEditorView, unregisterEditorView } from "../editor/registry";
import { useSettings } from "../settings";
import { useStore } from "../store";
import { leaves } from "../tree";
import type { Doc } from "../types";

export function Editor({ doc }: { doc: Doc }) {
  const setContent = useStore((s) => s.setContent);

  // The CodeMirror view is an external system: it's created when the host
  // element appears and torn down by the ref callback's cleanup.
  const attach = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host) return;

      // Serializing the whole document on every keystroke is O(doc); coalesce
      // store syncs instead — trailing 150ms, but never more than 400ms behind
      // so the preview keeps moving during continuous typing. Anything that
      // must be exact (saving) reads the live view via the registry.
      let timer: number | undefined;
      let lastSync = 0;
      const sync = (view: EditorView) => {
        timer = undefined;
        lastSync = performance.now();
        setContent(doc.id, view.state.doc.toString());
      };

      const view = new EditorView({
        state: EditorState.create({
          doc: useStore.getState().docs[doc.id]?.content ?? "",
          extensions: [
            ...editorExtensions(useSettings.getState().settings.keybinds),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              if (timer !== undefined) window.clearTimeout(timer);
              if (performance.now() - lastSync > 400) sync(update.view);
              else timer = window.setTimeout(() => sync(update.view), 150);
            }),
          ],
        }),
        parent: host,
      });
      registerEditorView(doc.id, view);

      // If this editor belongs to the focused tile, take keyboard focus.
      const state = useStore.getState();
      const leaf = leaves(state.root).find((l) => l.docId === doc.id);
      if (leaf && leaf.id === state.focusedId && leaf.mode !== "preview") {
        view.focus();
      }

      return () => {
        if (timer !== undefined) {
          window.clearTimeout(timer);
          sync(view); // don't lose the trailing keystrokes
        }
        unregisterEditorView(doc.id, view);
        view.destroy();
      };
    },
    [doc.id, setContent],
  );

  return <div className="editor" ref={attach} />;
}
