// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

/** A width the viewer chose, kept in localStorage; the layout works without storage. */
export function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? clampWidth(n, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function storeWidth(key: string, width: number | null) {
  try {
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  } catch {
    // convenience only
  }
}

export interface PanelWidth {
  /** The width to render, never outside `min` and `max`. */
  width: number;
  /** While dragging or after a key: changes the width; `commit` also saves it. */
  set: (width: number, commit?: boolean) => void;
  reset: () => void;
}

/** The chosen width of a side panel. `max` may change with the window; the stored value stays as chosen. */
export function usePanelWidth(storageKey: string, def: number, min: number, max: number): PanelWidth {
  const [chosen, setChosen] = useState(() => readStoredWidth(storageKey, def, min, Number.MAX_SAFE_INTEGER));
  const set = useCallback(
    (width: number, commit = true) => {
      const next = clampWidth(width, min, max);
      setChosen(next);
      if (commit) storeWidth(storageKey, next);
    },
    [storageKey, min, max],
  );
  const reset = useCallback(() => {
    setChosen(def);
    storeWidth(storageKey, null);
  }, [storageKey, def]);
  return { width: clampWidth(chosen, min, max), set, reset };
}

/**
 * The drag handle on the inner edge of a side panel (a focusable separator, WAI-ARIA window splitter).
 * `edge` is the side of the panel the handle sits on: a panel at the start of the page has it at its `end`.
 * Pointer capture keeps the drag going over iframes and video; arrows, Home, End and Enter work from the keyboard.
 */
export function ResizeHandle({
  label,
  edge,
  panel,
  min,
  max,
}: {
  label: string;
  edge: "start" | "end";
  panel: PanelWidth;
  min: number;
  max: number;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const { width, set, reset } = panel;
  const upper = Math.max(min, max);

  // Which way the pointer moves to make the panel wider, in screen terms.
  const grow = () => {
    const rtl = getComputedStyle(document.documentElement).direction === "rtl";
    return (edge === "end") !== rtl ? 1 : -1;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, width };
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    set(d.width + (e.clientX - d.x) * grow(), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    set(d.width + (e.clientX - d.x) * grow(), true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = width + step * grow();
    else if (e.key === "ArrowLeft") next = width - step * grow();
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = upper;
    else if (e.key === "Enter") {
      e.preventDefault();
      reset();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    set(next, true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={upper}
      aria-valuetext={`${width}px`}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        reset();
      }}
      onKeyDown={onKeyDown}
      className={`group/handle absolute inset-y-0 z-20 w-3 cursor-col-resize touch-none outline-none ${edge === "end" ? "-end-1.5" : "-start-1.5"}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 bg-transparent group-hover/handle:bg-accent group-focus-visible/handle:bg-accent group-data-[dragging]/handle:bg-accent motion-safe:transition-colors"
      />
    </div>
  );
}
