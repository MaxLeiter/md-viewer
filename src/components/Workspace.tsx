import { useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { computeLayout } from "../tree";
import type { DividerLayout, Rect } from "../tree";
import { useStore } from "../store";
import { Tile } from "./Tile";

function pct(value: number): string {
  return `${value * 100}%`;
}

function tileStyle(rect: Rect): CSSProperties {
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) };
}

function dividerStyle(divider: DividerLayout): CSSProperties {
  if (divider.dir === "row") {
    return {
      left: pct(divider.rect.x),
      top: pct(divider.rect.y),
      height: pct(divider.rect.h),
      width: "1px",
      transform: "translateX(-0.5px)",
    };
  }
  return {
    left: pct(divider.rect.x),
    top: pct(divider.rect.y),
    width: pct(divider.rect.w),
    height: "1px",
    transform: "translateY(-0.5px)",
  };
}

export function Workspace() {
  const root = useStore((s) => s.root);
  const closingIds = useStore((s) => s.closingLeafIds);
  const tileDrag = useStore((s) => s.tileDrag);
  const setSizes = useStore((s) => s.setSizes);
  const ref = useRef<HTMLElement>(null);

  const closing = useMemo(() => new Set(closingIds), [closingIds]);
  const { tiles, dividers } = useMemo(() => computeLayout(root, closing), [root, closing]);

  // Highlight where the dragged tile would land.
  let dropIndicator: CSSProperties | null = null;
  if (tileDrag?.targetId && tileDrag.region) {
    const target = tiles.find((t) => t.leaf.id === tileDrag.targetId);
    if (target) {
      let { x, y, w, h } = target.rect;
      if (tileDrag.region === "left") w /= 2;
      else if (tileDrag.region === "right") {
        x += w / 2;
        w /= 2;
      } else if (tileDrag.region === "top") h /= 2;
      else if (tileDrag.region === "bottom") {
        y += h / 2;
        h /= 2;
      }
      dropIndicator = { left: pct(x), top: pct(y), width: pct(w), height: pct(h) };
    }
  }

  const startDrag = (divider: DividerLayout) => (event: React.PointerEvent) => {
    event.preventDefault();
    const workspace = ref.current;
    if (!workspace) return;

    const rect = workspace.getBoundingClientRect();
    const horizontal = divider.dir === "row";
    const total = (horizontal ? rect.width : rect.height) * divider.splitSpan;
    if (total <= 0) return;

    const startPos = horizontal ? event.clientX : event.clientY;
    const startSizes = [...divider.sizes];
    const index = divider.index;
    const cls = horizontal ? "resizing-x" : "resizing-y";
    document.body.classList.add(cls);

    const MIN = 0.12;
    const move = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const lo = Math.min(0, -(startSizes[index] - MIN));
      const hi = Math.max(0, startSizes[index + 1] - MIN);
      const delta = Math.max(lo, Math.min(hi, (pos - startPos) / total));
      const next = [...startSizes];
      next[index] = startSizes[index] + delta;
      next[index + 1] = startSizes[index + 1] - delta;
      setSizes(divider.splitId, next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove(cls);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <main className="workspace" ref={ref}>
      {tiles.map(({ leaf, rect }) => (
        <div
          key={leaf.id}
          data-leaf-id={leaf.id}
          className={`tile-slot${closing.has(leaf.id) ? " closing" : ""}${
            tileDrag?.sourceId === leaf.id ? " drag-source" : ""
          }`}
          style={tileStyle(rect)}
        >
          <Tile leaf={leaf} />
        </div>
      ))}
      {dividers.map((divider) => (
        <div
          key={divider.id}
          className={`divider divider-${divider.dir}`}
          style={dividerStyle(divider)}
          onPointerDown={startDrag(divider)}
        />
      ))}
      {dropIndicator && <div className="tile-drop-indicator" style={dropIndicator} />}
    </main>
  );
}
