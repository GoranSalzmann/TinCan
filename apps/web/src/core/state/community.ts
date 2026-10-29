// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import {
  has,
  parsePermissions,
  type Category,
  type Channel,
  type Member,
  type PermissionName,
  type Role,
} from "@tincan/shared";

/**
 * Everything the server tells us about the community: channels, roles, members, presence and our own
 * permissions (12 §5.1). Filled from READY, kept current by gateway events. The permission bits here
 * are cosmetic (12 §7): the server decides, a mismatch just yields a PERMISSION_DENIED toast.
 */
export type PresenceStatus = "online" | "idle" | "dnd" | "offline";

interface CommunityState {
  ready: boolean;
  categories: Category[];
  channels: Channel[];
  roles: Role[];
  members: Record<string, Member>;
  presence: Record<string, PresenceStatus>;
  /** Instance-wide permissions of the signed-in user. */
  permissions: bigint;
  channelPermissions: Record<string, bigint>;
  settings: Record<string, unknown>;
  apply: (t: string, d: unknown) => void;
  reset: () => void;
}

const sortChannels = (cs: Channel[]) =>
  [...cs].sort((a, b) => (a.categoryId ?? "").localeCompare(b.categoryId ?? "") || a.position - b.position);
const sortCategories = (cs: Category[]) => [...cs].sort((a, b) => a.position - b.position);
const sortRoles = (rs: Role[]) => [...rs].sort((a, b) => a.position - b.position);

function toPerms(map: Record<string, string>): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [id, v] of Object.entries(map)) out[id] = parsePermissions(v);
  return out;
}

const initial = {
  ready: false,
  categories: [] as Category[],
  channels: [] as Channel[],
  roles: [] as Role[],
  members: {} as Record<string, Member>,
  presence: {} as Record<string, PresenceStatus>,
  permissions: 0n,
  channelPermissions: {} as Record<string, bigint>,
  settings: {} as Record<string, unknown>,
};

export const useCommunity = create<CommunityState>((set, get) => ({
  ...initial,

  reset: () => set({ ...initial }),

  apply(t, d) {
    const p = d as Record<string, unknown>;
    switch (t) {
      case "READY":
        set({
          ready: true,
          categories: sortCategories((p.categories ?? []) as Category[]),
          channels: sortChannels((p.channels ?? []) as Channel[]),
          roles: sortRoles((p.roles ?? []) as Role[]),
          members: Object.fromEntries(((p.members ?? []) as Member[]).map((m) => [m.userId, m])),
          presence: (p.presence ?? {}) as Record<string, PresenceStatus>,
          permissions: parsePermissions(typeof p.permissions === "string" ? p.permissions : "0"),
          channelPermissions: toPerms((p.channelPermissions ?? {}) as Record<string, string>),
          settings: (p.settings ?? {}) as Record<string, unknown>,
        });
        return;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE": {
        const c = p.channel as Channel;
        set({ channels: sortChannels([...get().channels.filter((x) => x.id !== c.id), c]) });
        return;
      }
      case "CHANNEL_DELETE":
        set({ channels: get().channels.filter((c) => c.id !== p.channelId) });
        return;
      case "CHANNEL_REORDER": {
        const items = p.items as { id: string; categoryId: string | null; position: number }[];
        const byId = new Map(items.map((i) => [i.id, i]));
        set({
          channels: sortChannels(
            get().channels.map((c) => {
              const i = byId.get(c.id);
              return i ? { ...c, categoryId: i.categoryId, position: i.position } : c;
            }),
          ),
        });
        return;
      }
      case "CATEGORY_CREATE":
      case "CATEGORY_UPDATE": {
        const c = p.category as Category;
        set({ categories: sortCategories([...get().categories.filter((x) => x.id !== c.id), c]) });
        return;
      }
      case "CATEGORY_DELETE":
        set({
          categories: get().categories.filter((c) => c.id !== p.categoryId),
          channels: get().channels.map((c) =>
            c.categoryId === p.categoryId ? { ...c, categoryId: null } : c,
          ),
        });
        return;
      case "ROLE_CREATE":
      case "ROLE_UPDATE": {
        const r = p.role as Role;
        set({ roles: sortRoles([...get().roles.filter((x) => x.id !== r.id), r]) });
        return;
      }
      case "ROLE_DELETE":
        set({
          roles: get().roles.filter((r) => r.id !== p.roleId),
          members: Object.fromEntries(
            Object.entries(get().members).map(([id, m]) => [
              id,
              { ...m, roleIds: m.roleIds.filter((r) => r !== p.roleId) },
            ]),
          ),
        });
        return;
      case "MEMBER_ADD":
      case "MEMBER_UPDATE": {
        const m = p.member as Member;
        set({ members: { ...get().members, [m.userId]: m } });
        return;
      }
      case "USER_UPDATE": {
        const m = get().members[p.id as string];
        if (!m) return;
        set({
          members: {
            ...get().members,
            [m.userId]: {
              ...m,
              username: p.username as string,
              displayName: p.displayName as string,
              avatarKey: p.avatarKey as string | null,
              statusText: p.statusText as string | null,
            },
          },
        });
        return;
      }
      case "PRESENCE_UPDATE": {
        const presence = { ...get().presence };
        if (p.status === "offline") delete presence[p.userId as string];
        else presence[p.userId as string] = p.status as PresenceStatus;
        set({ presence });
        return;
      }
      case "PERMISSIONS_UPDATE":
        set({
          permissions: parsePermissions(typeof p.permissions === "string" ? p.permissions : "0"),
          channelPermissions: toPerms(p.channels as Record<string, string>),
        });
        return;
      case "USER_SETTINGS_UPDATE": {
        const settings = { ...get().settings };
        for (const [k, v] of Object.entries(p.settings as Record<string, unknown>)) {
          if (v === null) delete settings[k];
          else settings[k] = v;
        }
        set({ settings });
        return;
      }
    }
  },
}));

// ---- selectors -------------------------------------------------------------------------------------

/** Instance-wide permission, e.g. MANAGE_CHANNELS. */
export function useCan(perm: PermissionName): boolean {
  return useCommunity((s) => has(s.permissions, perm));
}

/** Permission in one channel. The server stays the judge. */
export function useCanIn(channelId: string | undefined, perm: PermissionName): boolean {
  return useCommunity((s) => (channelId ? has(s.channelPermissions[channelId] ?? 0n, perm) : false));
}

/** Name to show for a member: nickname, then display name (design U7: role colours never colour names). */
export function memberName(
  m: Pick<Member, "nickname" | "displayName"> | undefined,
  fallback = "Deleted User",
): string {
  return m ? (m.nickname ?? m.displayName) : fallback;
}
