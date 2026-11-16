// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";

/**
 * What the DeepFilterNet loader is doing, for the UI: the first use downloads the module and the model (about 20 MB
 * before compression), then every new pipeline loads the model in its worklet (about half a second).
 */
export type DeepFilterPhase = "idle" | "downloading" | "starting" | "ready";

export interface DeepFilterStatus {
  phase: DeepFilterPhase;
  /** Bytes received so far and expected in all, while downloading. */
  loaded: number;
  total: number;
}

export const useDeepFilterStatus = create<DeepFilterStatus>(() => ({ phase: "idle", loaded: 0, total: 0 }));
