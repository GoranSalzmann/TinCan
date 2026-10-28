// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The read interface `accounts` offers other modules (04 §5). Other modules import this file's types
 * and nothing else from here; they never touch the account tables.
 */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  isInstanceOwner: boolean;
}

export interface AccountsApi {
  getUser(id: string): Promise<PublicUser | null>;
}
