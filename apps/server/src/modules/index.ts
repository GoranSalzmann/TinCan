// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AnyManifest } from "../framework/types.js";
import accounts from "./accounts/index.js";
import channels from "./channels/index.js";
import core from "./core/index.js";
import search from "./search/index.js";
import uploads from "./uploads/index.js";
import invites from "./invites/index.js";
import readState from "./read-state/index.js";
import roles from "./roles/index.js";
import textChat from "./text-chat/index.js";

/**
 * Every module this build knows (04 §2). Features that arrive in later milestones (roles, channels,
 * text-chat, voice …) are added here; a config that names one this build lacks is refused.
 */
export const ALL_MODULES: readonly AnyManifest[] = [
  core,
  accounts,
  roles,
  channels,
  textChat,
  readState,
  invites,
  uploads,
  search,
];
