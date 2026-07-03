import type { Doc } from "./types";

/**
 * Per-file annotations (highlights and comments) over the rendered preview.
 *
 * Annotations are anchored by their quoted text plus a little surrounding
 * context, then re-found in the rendered output on each render. This is
 * resilient to edits and to the preview's incremental DOM patching (offsets
 * would drift; a quote+context search does not), which suits a viewer.
 */
export interface Annotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  color: string;
  note: string;
  created: number;
}

export const HIGHLIGHT_COLORS = [
  "rgba(255, 214, 10, 0.40)",
  "rgba(48, 209, 88, 0.32)",
  "rgba(10, 132, 255, 0.30)",
  "rgba(255, 105, 180, 0.30)",
];

const CONTEXT = 24;
const STORAGE_KEY = "annotations";

type Store = Record<string, Annotation[]>;

function load(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

let store = load();
const listeners = new Set<() => void>();

function emit(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  listeners.forEach((fn) => fn());
}

export function subscribeAnnotations(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stable storage key for a document, or null if it has no identity yet. */
export function keyForDoc(doc: Doc | undefined): string | null {
  if (!doc) return null;
  if (doc.path) return doc.path;
  if (doc.remote) return `${doc.remote.host}:${doc.remote.path}`;
  return null;
}

export function annotationsForKey(key: string | null): Annotation[] {
  return key ? (store[key] ?? []) : [];
}

export function addAnnotation(key: string, ann: Omit<Annotation, "id" | "created">): Annotation {
  const full: Annotation = { ...ann, id: crypto.randomUUID(), created: Date.now() };
  store = { ...store, [key]: [...(store[key] ?? []), full] };
  emit();
  return full;
}

export function updateAnnotation(key: string, id: string, patch: Partial<Annotation>): void {
  const list = store[key];
  if (!list) return;
  store = { ...store, [key]: list.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
  emit();
}

export function removeAnnotation(key: string, id: string): void {
  const list = store[key];
  if (!list) return;
  store = { ...store, [key]: list.filter((a) => a.id !== id) };
  emit();
}

export function findAnnotation(key: string | null, id: string): Annotation | undefined {
  return annotationsForKey(key).find((a) => a.id === id);
}

/* ---------------------------------------------------------------------------
   Selection → annotation anchor
--------------------------------------------------------------------------- */

/** Character offset of a boundary within an element's text content. */
function offsetOf(container: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Build an annotation anchor from the current selection inside `container`. */
export function anchorFromSelection(
  container: HTMLElement,
): { quote: string; prefix: string; suffix: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = range.toString();
  if (!quote.trim()) return null;

  const start = offsetOf(container, range.startContainer, range.startOffset);
  const fullText = container.textContent ?? "";
  return {
    quote,
    prefix: fullText.slice(Math.max(0, start - CONTEXT), start),
    suffix: fullText.slice(start + quote.length, start + quote.length + CONTEXT),
  };
}

/* ---------------------------------------------------------------------------
   Applying annotations to the rendered DOM
--------------------------------------------------------------------------- */

function unwrapExisting(container: HTMLElement): void {
  container.querySelectorAll("span.annotation").forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
  });
  container.normalize();
}

/** Pick the occurrence of `quote` whose surrounding text best matches context. */
function locate(fullText: string, ann: Annotation): number {
  const positions: number[] = [];
  let from = fullText.indexOf(ann.quote);
  while (from !== -1) {
    positions.push(from);
    from = fullText.indexOf(ann.quote, from + 1);
  }
  if (positions.length === 0) return -1;
  if (positions.length === 1) return positions[0];

  let best = positions[0];
  let bestScore = -1;
  for (const pos of positions) {
    const before = fullText.slice(Math.max(0, pos - ann.prefix.length), pos);
    const after = fullText.slice(pos + ann.quote.length, pos + ann.quote.length + ann.suffix.length);
    let score = 0;
    while (
      score < ann.prefix.length &&
      before[before.length - 1 - score] === ann.prefix[ann.prefix.length - 1 - score]
    ) {
      score++;
    }
    let s2 = 0;
    while (s2 < ann.suffix.length && after[s2] === ann.suffix[s2]) s2++;
    if (score + s2 > bestScore) {
      bestScore = score + s2;
      best = pos;
    }
  }
  return best;
}

/** Wrap the text in [start, end) with annotation spans, splitting text nodes. */
function wrapRange(container: HTMLElement, start: number, end: number, ann: Annotation): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; from: number; to: number }[] = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    const len = text.nodeValue?.length ?? 0;
    const nodeStart = pos;
    const nodeEnd = pos + len;
    if (nodeEnd > start && nodeStart < end) {
      targets.push({
        node: text,
        from: Math.max(0, start - nodeStart),
        to: Math.min(len, end - nodeStart),
      });
    }
    pos = nodeEnd;
    if (pos >= end) break;
  }

  for (const t of targets) {
    let node = t.node;
    if (t.to < (node.nodeValue?.length ?? 0)) node.splitText(t.to);
    if (t.from > 0) node = node.splitText(t.from);
    const parent = node.parentNode;
    if (!parent) continue;
    // Don't annotate inside code blocks (keeps copyable code intact).
    if ((parent as HTMLElement).closest?.("pre")) continue;
    const span = document.createElement("span");
    span.className = ann.note ? "annotation has-note" : "annotation";
    span.dataset.id = ann.id;
    span.style.backgroundColor = ann.color;
    parent.insertBefore(span, node);
    span.appendChild(node);
  }
}

/** Re-render all annotations for `key` onto `container`. */
export function applyAnnotations(container: HTMLElement, key: string | null): void {
  unwrapExisting(container);
  const list = annotationsForKey(key);
  if (!list.length) return;
  const fullText = container.textContent ?? "";
  for (const ann of list) {
    const start = locate(fullText, ann);
    if (start === -1) continue;
    wrapRange(container, start, start + ann.quote.length, ann);
  }
}
