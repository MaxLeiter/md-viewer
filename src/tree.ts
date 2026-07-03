import type { LeafNode, SplitNode, TileNode, ViewMode } from "./types";

export function makeLeaf(docId: string, mode: ViewMode = "editor"): LeafNode {
  return { type: "leaf", id: crypto.randomUUID(), docId, mode, ratio: 0.5 };
}

/** All leaves in visual (left-to-right, top-to-bottom) order. */
export function leaves(node: TileNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(node: TileNode, leafId: string): LeafNode | null {
  return leaves(node).find((l) => l.id === leafId) ?? null;
}

/** Immutably patch a leaf. */
export function updateLeaf(
  node: TileNode,
  leafId: string,
  patch: Partial<Omit<LeafNode, "type" | "id">>,
): TileNode {
  if (node.type === "leaf") {
    return node.id === leafId ? { ...node, ...patch } : node;
  }
  return { ...node, children: node.children.map((c) => updateLeaf(c, leafId, patch)) };
}

/** Immutably patch a split's sizes. */
export function updateSizes(node: TileNode, splitId: string, sizes: number[]): TileNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => updateSizes(c, splitId, sizes)) };
}

/**
 * Insert `newLeaf` next to the leaf with `leafId`, splitting in direction
 * `dir` ("row" = side by side, "col" = stacked). `before` places the new
 * leaf to the left/above instead of right/below.
 */
export function splitLeaf(
  node: TileNode,
  leafId: string,
  dir: "row" | "col",
  newLeaf: LeafNode,
  before = false,
): TileNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    const split: SplitNode = {
      type: "split",
      id: crypto.randomUUID(),
      dir,
      children: before ? [newLeaf, node] : [node, newLeaf],
      sizes: [0.5, 0.5],
    };
    return split;
  }

  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === leafId);
  if (idx !== -1 && node.dir === dir) {
    // Same orientation: insert as a sibling, taking half of the target's space.
    const children = [...node.children];
    const sizes = [...node.sizes];
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    children.splice(before ? idx : idx + 1, 0, newLeaf);
    sizes.splice(before ? idx : idx + 1, 0, half);
    return { ...node, children, sizes };
  }

  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, leafId, dir, newLeaf, before)),
  };
}

/**
 * Remove a leaf. Returns the new tree, or null if the removed leaf was the
 * only node. Single-child splits collapse into their child.
 */
export function removeLeaf(node: TileNode, leafId: string): TileNode | null {
  if (node.type === "leaf") {
    return node.id === leafId ? null : node;
  }

  const children: TileNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removeLeaf(child, leafId);
    if (next) {
      children.push(next);
      sizes.push(node.sizes[i]);
    }
  });

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/** Number of leaves in the tree. */
export function countLeaves(node: TileNode): number {
  return leaves(node).length;
}

/** Swap the positions of two leaves (each keeps its identity, mode and ratio). */
export function swapLeaves(node: TileNode, aId: string, bId: string): TileNode {
  const a = findLeaf(node, aId);
  const b = findLeaf(node, bId);
  if (!a || !b || aId === bId) return node;
  const replace = (current: TileNode): TileNode => {
    if (current.type === "leaf") {
      if (current.id === aId) return b;
      if (current.id === bId) return a;
      return current;
    }
    return { ...current, children: current.children.map(replace) };
  };
  return replace(node);
}

/* ---------------------------------------------------------------------------
   Flat layout: the tree is rendered as absolutely-positioned tiles + divider
   strips so tiles keep their identity (and editor state) across splits, and
   layout changes can animate with plain CSS transitions.
--------------------------------------------------------------------------- */

/** Rectangle in fractions (0..1) of the workspace. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileLayout {
  leaf: LeafNode;
  rect: Rect;
}

export interface DividerLayout {
  id: string;
  splitId: string;
  /** Divider sits between child `index` and `index + 1`. */
  index: number;
  dir: "row" | "col";
  rect: Rect;
  /** The split's fractional extent along its axis (for px → fraction math). */
  splitSpan: number;
  sizes: number[];
}

/**
 * Compute the layout. Leaves in `closing` collapse to zero size so their
 * neighbours can transition into the freed space before the leaf is removed.
 */
export function computeLayout(
  root: TileNode,
  closing: ReadonlySet<string>,
): { tiles: TileLayout[]; dividers: DividerLayout[] } {
  const tiles: TileLayout[] = [];
  const dividers: DividerLayout[] = [];

  const walk = (node: TileNode, rect: Rect) => {
    if (node.type === "leaf") {
      tiles.push({ leaf: node, rect });
      return;
    }

    const rawSizes = node.children.map((child, i) =>
      child.type === "leaf" && closing.has(child.id) ? 0 : node.sizes[i],
    );
    const total = rawSizes.reduce((a, b) => a + b, 0) || 1;
    const sizes = rawSizes.map((s) => s / total);

    let offset = 0;
    node.children.forEach((child, i) => {
      const fraction = sizes[i];
      const childRect: Rect =
        node.dir === "row"
          ? { x: rect.x + offset * rect.w, y: rect.y, w: fraction * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: fraction * rect.h };
      walk(child, childRect);
      offset += fraction;

      if (i < node.children.length - 1) {
        dividers.push({
          id: `${node.id}:${i}`,
          splitId: node.id,
          index: i,
          dir: node.dir,
          rect:
            node.dir === "row"
              ? { x: rect.x + offset * rect.w, y: rect.y, w: 0, h: rect.h }
              : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: 0 },
          splitSpan: node.dir === "row" ? rect.w : rect.h,
          sizes: node.sizes,
        });
      }
    });
  };

  walk(root, { x: 0, y: 0, w: 1, h: 1 });
  return { tiles, dividers };
}
