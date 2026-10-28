// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AnyManifest } from "../framework/types.js";
import accounts from "./accounts/index.js";
import core from "./core/index.js";

/**
 * Every module this build knows (04 §2). Features that arrive in later milestones (roles, channels,
 * text-chat, voice …) are added here; a config that names one this build lacks is refused.
 */
export const ALL_MODULES: readonly AnyManifest[] = [core, accounts];
