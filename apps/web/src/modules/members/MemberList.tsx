// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Member, Role } from "@tincan/shared";
import { useT } from "../../core/i18n/index.js";
import { memberName, useCan, useCommunity, type PresenceStatus } from "../../core/state/community.js";
import { Avatar, PresenceDot } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Dialog.js";
import { ModerationActions } from "./ModerationActions.js";

interface Group {
  key: string;
  title: string;
  members: Member[];
}

/** Groups of the member list (design U12): roles marked "show separately" by rank, then Online, then Offline. */
export function groupMembers(
  members: readonly Member[],
  roles: readonly Role[],
  presence: Record<string, PresenceStatus>,
  labels: { online: string; offline: string },
): Group[] {
  const hoisted = roles.filter((r) => r.hoist && !r.isDefault).sort((a, b) => b.position - a.position);
  const byName = (a: Member, b: Member) => memberName(a).localeCompare(memberName(b));
  const placed = new Set<string>();
  const groups: Group[] = [];
  for (const role of hoisted) {
    const list = members.filter(
      (m) => !placed.has(m.userId) && presence[m.userId] && m.roleIds.includes(role.id),
    );
    list.forEach((m) => placed.add(m.userId));
    if (list.length) groups.push({ key: role.id, title: role.name, members: list.sort(byName) });
  }
  const online = members.filter((m) => !placed.has(m.userId) && presence[m.userId]).sort(byName);
  const offline = members.filter((m) => !presence[m.userId]).sort(byName);
  if (online.length) groups.push({ key: "online", title: labels.online, members: online });
  if (offline.length) groups.push({ key: "offline", title: labels.offline, members: offline });
  return groups;
}

function MemberCard({ member, onClose }: { member: Member; onClose: () => void }) {
  const t = useT();
  const roles = useCommunity((s) => s.roles);
  const presence = useCommunity((s) => s.presence[member.userId] ?? "offline");
  const canRoles = useCan("MANAGE_ROLES");
  const navigate = useNavigate();
  const mine = roles.filter((r) => member.roleIds.includes(r.id));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={memberName(member)}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={memberName(member)} avatarKey={member.avatarKey} size={56} />
          <div className="min-w-0">
            <div className="text-lg font-semibold">
              <bdi>{member.displayName}</bdi>
            </div>
            <div className="text-sm text-text-muted">@{member.username}</div>
            <div className="flex items-center gap-1 text-sm">
              <PresenceDot status={presence} /> {t(`user.status.${presence}`)}
            </div>
          </div>
        </div>
        {member.statusText ? <p className="text-sm">{member.statusText}</p> : null}
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t("member.roles")}</h3>
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
            {member.isOwner ? (
              <li className="rounded-full border border-border px-2 text-xs">{t("member.owner")}</li>
            ) : null}
            {mine.length === 0 && !member.isOwner ? (
              <li className="text-sm text-text-muted">{t("member.noRoles")}</li>
            ) : null}
            {mine.map((r) => (
              // Role colours never colour text (design U7): a dot and a pill border.
              <li
                key={r.id}
                className="flex items-center gap-1 rounded-full border px-2 text-xs"
                style={r.color ? { borderColor: r.color } : undefined}
              >
                {r.color ? (
                  <span aria-hidden="true" className="size-2 rounded-full" style={{ background: r.color }} />
                ) : null}
                {r.name}
              </li>
            ))}
          </ul>
        </div>
        <div className="text-xs text-text-muted">
          {t("member.joined", { date: new Date(member.joinedAt).toLocaleDateString() })}
        </div>
        {canRoles ? (
          <Button
            variant="ghost"
            onClick={() => {
              onClose();
              void navigate(`/settings/members/${member.userId}`);
            }}
          >
            {t("member.manage")}
          </Button>
        ) : null}
        <ModerationActions member={member} onDone={onClose} />
      </div>
    </Modal>
  );
}

/** The member list (W-05): docks at 1280 px and wider, an overlay below (design U8). */
export function MemberList() {
  const t = useT();
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles);
  const presence = useCommunity((s) => s.presence);
  const [card, setCard] = useState<Member | null>(null);
  const all = useMemo(() => Object.values(members), [members]);
  const groups = useMemo(
    () =>
      groupMembers(all, roles, presence, {
        online: t("member.group.online"),
        offline: t("member.group.offline"),
      }),
    [all, roles, presence, t],
  );
  return (
    <div className="flex-1 overflow-y-auto pb-4">
      {groups.map((g) => (
        <section key={g.key} aria-label={`${g.title} — ${g.members.length}`}>
          <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {g.title} — {g.members.length}
          </h3>
          <ul className="m-0 list-none p-0 px-2">
            {g.members.map((m) => {
              const status = presence[m.userId] ?? "offline";
              return (
                <li key={m.userId}>
                  <button
                    type="button"
                    onClick={() => setCard(m)}
                    className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-bg-hover ${status === "offline" ? "opacity-60" : ""}`}
                  >
                    <span className="relative">
                      <Avatar name={memberName(m)} avatarKey={m.avatarKey} size={28} />
                      <PresenceDot status={status} className="absolute -end-0.5 -bottom-0.5 bg-bg-sidebar" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <bdi className="block truncate text-sm">{memberName(m)}</bdi>
                      <span className="sr-only">{t(`user.status.${status}`)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {card ? <MemberCard member={members[card.userId] ?? card} onClose={() => setCard(null)} /> : null}
    </div>
  );
}
