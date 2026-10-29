// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

/** What is on screen right now; the notification and read-state rules depend on it (12 §5.4). */
interface UiState {
  selectedChannelId: string | null;
  windowFocused: boolean;
  /** Counts READY events: a new one after a non-resumable reconnect means cached state may be stale. */
  readyCount: number;
  /** Set by the layout: opens a channel (and optionally a message) in the router. */
  navigator: ((channelId: string, messageId?: string) => void) | null;
  setNavigator: (fn: UiState["navigator"]) => void;
  select: (channelId: string | null) => void;
  setFocused: (focused: boolean) => void;
  bumpReady: () => void;
}

export const useUi = create<UiState>((set) => ({
  selectedChannelId: null,
  navigator: null,
  setNavigator: (navigator) => set({ navigator }),
  windowFocused: true,
  readyCount: 0,
  select: (selectedChannelId) => set({ selectedChannelId }),
  setFocused: (windowFocused) => set({ windowFocused }),
  bumpReady: () => set((s) => ({ readyCount: s.readyCount + 1 })),
}));
