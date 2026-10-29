// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { ApiError } from "../core/api/client.js";

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

interface ToastState {
  toasts: Toast[];
  push: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(text, kind = "info") {
    const id = next++;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => get().dismiss(id), kind === "error" ? 7000 : 4000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = (text: string, kind: Toast["kind"] = "info") => useToasts.getState().push(text, kind);

/** Shows an API failure in words a person can act on; REST codes map to messages (12 §11). */
export function toastError(e: unknown, fallback = "Something went wrong."): void {
  if (e instanceof ApiError) {
    const text =
      e.code === "PERMISSION_DENIED"
        ? "You don't have permission to do that."
        : e.code === "RATE_LIMITED"
          ? "Slow down a little, then try again."
          : e.code === "NETWORK"
            ? "Can't reach the server."
            : e.message || fallback;
    toast(text, "error");
    return;
  }
  toast(fallback, "error");
}

/** Polite live region (style guide §11): status messages announced without moving focus. */
export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-80 flex flex-col items-center gap-2 px-4"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`elev-2 pointer-events-auto max-w-md px-4 py-2 text-sm ${t.kind === "error" ? "text-danger-text" : ""}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
