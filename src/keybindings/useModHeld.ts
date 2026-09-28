/**
 * Display-only tracker for "is the primary command modifier held right now?"
 *
 * Tracks EITHER ⌘ (Meta) or Ctrl. Drives the ⌘N keycap hint on the tabs — never
 * command dispatch — so it stays deliberately minimal. Adapted (simplified) from
 * AgentSpaces' use-mod-held: no terminal/PTY special-casing here.
 */
import { useEffect, useRef, useState } from "react";

export function useModHeld(): boolean {
  const [held, setHeld] = useState(false);
  // Mirror in a ref so the hot keydown path (fires on every keystroke) can skip
  // no-op setState calls without relying on React's state bailout.
  const heldRef = useRef(false);
  useEffect(() => {
    const set = (next: boolean) => {
      if (heldRef.current === next) return;
      heldRef.current = next;
      setHeld(next);
    };
    const isModKey = (e: KeyboardEvent) => e.key === "Meta" || e.key === "Control";
    const onDown = (e: KeyboardEvent) => {
      if (isModKey(e)) {
        set(true);
        return;
      }
      // Any other key clears the hint, but only when that key's own event says no
      // primary modifier is down — an OS capture chord (⇧⌘4, Spotlight) can eat
      // the ⌘ keyup, so the next keystroke is our chance to resync.
      if (!e.metaKey && !e.ctrlKey) set(false);
    };
    const onUp = (e: KeyboardEvent) => {
      if (isModKey(e)) set(false);
    };
    // A blur / tab switch can swallow the keyup — clear so the hint never sticks.
    const clear = () => set(false);
    // A modifier-less click is the pointer twin of the stuck-latch clear above.
    const onPointerDown = (e: PointerEvent) => {
      if (!e.metaKey && !e.ctrlKey) set(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);
  return held;
}
