export type ViewMode = "editor" | "split" | "preview";

/** A file living on a remote host, reached over SSH. */
export interface RemoteRef {
  host: string;
  path: string;
}

export interface Doc {
  id: string;
  /** Absolute path on disk, or null for an unsaved/remote document. */
  path: string | null;
  /** Remote location when the document was opened over SSH, else null. */
  remote: RemoteRef | null;
  title: string;
  content: string;
  /** The content as it exists on disk/remote (used to compute dirty state). */
  saved: string;
}

export interface LeafNode {
  type: "leaf";
  id: string;
  docId: string;
  mode: ViewMode;
  /** Editor's share of the tile when mode === "split" (0..1). */
  ratio: number;
  /** Whether the document-outline sidebar is shown in this tile. */
  outline?: boolean;
}

export interface SplitNode {
  type: "split";
  id: string;
  dir: "row" | "col";
  children: TileNode[];
  /** Fractions summing to 1, one per child. */
  sizes: number[];
}

export type TileNode = LeafNode | SplitNode;

export function isDirty(doc: Doc): boolean {
  return doc.content !== doc.saved;
}

export function isPristine(doc: Doc): boolean {
  return doc.path === null && doc.remote === null && doc.content === "" && doc.saved === "";
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** Documents rendered as data tables instead of markdown. */
export function isCsvPath(path: string | null): boolean {
  return !!path && /\.(csv|tsv)$/i.test(path);
}

/** Where a dragged tile is about to land relative to the tile under the pointer. */
export type DropRegion = "center" | "left" | "right" | "top" | "bottom";

/** Classification path for a doc — local path or remote path. */
export function classifyPath(doc: Doc): string | null {
  return doc.path ?? doc.remote?.path ?? null;
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * Title to show in the UI: the filename for saved documents; for unsaved ones,
 * the first heading in the content (if the first non-blank line is a heading),
 * otherwise "Untitled".
 */
export function displayTitle(doc: Doc): string {
  if (doc.path || doc.remote) return doc.title;
  for (const line of doc.content.slice(0, 1000).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = HEADING_RE.exec(trimmed);
    if (match) {
      const text = match[1].replace(/[*_`~]/g, "").trim();
      if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
    break; // first real line isn't a heading — keep the default
  }
  return doc.title;
}
