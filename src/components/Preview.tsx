import { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderBlocks, subscribeRerender } from "../markdown";
import { renderCsvBlocks } from "../csv";
import { classifyPath, isCsvPath } from "../types";
import { useStore } from "../store";
import { leaves } from "../tree";
import { applyAnnotations, keyForDoc, subscribeAnnotations } from "../annotations";

interface BlockRecord {
  html: string;
  nodes: ChildNode[];
}

/**
 * Patch the container so its children match `htmls`, touching only the blocks
 * that changed (diffed by common prefix/suffix). Returns the new records.
 * Every string in `htmls` is already DOMPurify-sanitized by renderBlocks.
 */
function patchBlocks(
  container: HTMLElement,
  oldRecords: BlockRecord[],
  htmls: string[],
): BlockRecord[] {
  const minLength = Math.min(oldRecords.length, htmls.length);

  let prefix = 0;
  while (prefix < minLength && oldRecords[prefix].html === htmls[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLength - prefix &&
    oldRecords[oldRecords.length - 1 - suffix].html === htmls[htmls.length - 1 - suffix]
  ) {
    suffix++;
  }

  if (prefix === htmls.length && oldRecords.length === htmls.length) {
    return oldRecords; // nothing changed
  }

  // Remove the stale middle.
  for (let i = prefix; i < oldRecords.length - suffix; i++) {
    for (const node of oldRecords[i].nodes) node.remove();
  }

  // Insert the new middle before the first surviving suffix node.
  let refNode: ChildNode | null = null;
  for (let i = oldRecords.length - suffix; i < oldRecords.length; i++) {
    if (oldRecords[i].nodes.length) {
      refNode = oldRecords[i].nodes[0];
      break;
    }
  }

  const template = document.createElement("template");
  const middle: BlockRecord[] = [];
  for (let i = prefix; i < htmls.length - suffix; i++) {
    template.innerHTML = htmls[i]; // sanitized upstream
    const nodes = Array.from(template.content.childNodes);
    container.insertBefore(template.content, refNode);
    middle.push({ html: htmls[i], nodes });
  }

  return [
    ...oldRecords.slice(0, prefix),
    ...middle,
    ...oldRecords.slice(oldRecords.length - suffix),
  ];
}

/**
 * Imperative preview controller: subscribes to the store and patches the DOM
 * incrementally, outside of React's render cycle. Returns its cleanup.
 */
function createPreviewController(container: HTMLElement, docId: string): () => void {
  // React reuses the same <article> node across StrictMode remounts and docId
  // swaps, calling this ref callback again. Reset to a known-empty state so the
  // fresh `records=[]` matches the DOM — otherwise patchBlocks finds no old
  // records to remove and appends a second full copy of the document.
  container.replaceChildren();

  let records: BlockRecord[] = [];
  let rendered: string | null = null;
  let renderedBase: string | null = null;
  let cost = 0;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const content = () => useStore.getState().docs[docId]?.content;
  // Path used for CSV detection / titles (local or remote); base dir for
  // resolving relative images only applies to local files.
  const docPath = () => {
    const doc = useStore.getState().docs[docId];
    return doc ? classifyPath(doc) : null;
  };
  const localDir = () => {
    const local = useStore.getState().docs[docId]?.path;
    return local ? local.slice(0, local.lastIndexOf("/")) : null;
  };
  const visible = () => {
    const state = useStore.getState();
    const leaf = leaves(state.root).find((l) => l.docId === docId);
    return !leaf || leaf.mode !== "editor";
  };

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    frame = null;
    timer = null;
  };

  const annotationKey = () => keyForDoc(useStore.getState().docs[docId]);

  const apply = () => {
    const source = content();
    const path = docPath();
    if (source === undefined || (rendered === source && renderedBase === path)) return;
    const start = performance.now();
    const blocks = isCsvPath(path)
      ? renderCsvBlocks(source, path)
      : renderBlocks(source, localDir());
    records = patchBlocks(container, records, blocks);
    applyAnnotations(container, annotationKey());
    rendered = source;
    renderedBase = path;
    cost = performance.now() - start;
  };

  const schedule = () => {
    const source = content();
    if (source === undefined || (rendered === source && renderedBase === docPath()) || !visible())
      return;
    cancel();
    // Adaptive: cheap documents update on the next frame (instant while
    // typing); expensive ones back off proportionally to their render cost.
    if (cost < 25) {
      frame = requestAnimationFrame(() => {
        frame = null;
        apply();
      });
    } else {
      timer = setTimeout(
        () => {
          timer = null;
          apply();
        },
        Math.min(400, cost * 3),
      );
    }
  };

  // Initial fill is synchronous so the pane never flashes empty.
  if (visible()) apply();

  const unsubscribe = useStore.subscribe(schedule);
  // Re-apply annotations when they change, without a full re-render.
  const unsubAnnotations = subscribeAnnotations(() => {
    if (rendered !== null) applyAnnotations(container, annotationKey());
  });
  // The shiki highlighter loads async; when it finishes (or lazy-loads a new
  // language), invalidate the cached render so this pane re-highlights.
  const unsubRerender = subscribeRerender(() => {
    rendered = null;
    schedule();
  });
  return () => {
    cancel();
    unsubscribe();
    unsubAnnotations();
    unsubRerender();
  };
}

export function Preview({ docId, empty }: { docId: string; empty: boolean }) {
  const attach = useCallback(
    (container: HTMLElement | null) => {
      if (!container) return;
      return createPreviewController(container, docId);
    },
    [docId],
  );

  const handleClick = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;

    // Images open in the lightbox.
    const image = target.closest("img");
    if (image) {
      event.preventDefault();
      useStore.getState().setLightbox(image.currentSrc || image.getAttribute("src") || "");
      return;
    }

    const anchor = target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (!href) return;
    if (href.startsWith("#")) {
      // In-document links (footnotes, anchors) scroll within the preview.
      const container = event.currentTarget as HTMLElement;
      container
        .querySelector(`[id="${CSS.escape(href.slice(1))}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (/^https?:\/\//i.test(href)) {
      void openUrl(href);
    } else if (/^mdviewer:\/\//i.test(href)) {
      void useStore.getState().openPaths([href]);
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      // A link to another file (relative or absolute) — open it if present.
      void useStore.getState().followLink(docId, href);
    }
  };

  return (
    <div className="preview">
      <article ref={attach} className="preview-content" data-doc-id={docId} onClick={handleClick} />
      {empty && <div className="preview-empty">Nothing to preview</div>}
    </div>
  );
}
