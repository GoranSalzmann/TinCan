// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, Hash, MoreHorizontal, Plus, Volume2 } from "lucide-react";
import type { Category, Channel } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { levelFor, type ChannelPref } from "../../core/notifications.js";
import { useChat } from "../../core/state/chat.js";
import { useCan, useCommunity } from "../../core/state/community.js";
import { isUnread } from "../../core/state/window.js";
import { toast, toastError } from "../../ui/toast.js";
import { joinVoice } from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import { ParticipantRow } from "../voice/Participants.js";
import { CreateChannelDialog } from "./CreateChannelDialog.js";

const NONE: never[] = [];
const menuContent = "elev-2 z-60 min-w-48 p-1 text-sm text-text";
const menuItem =
  "flex cursor-default items-center gap-2 rounded-md px-3 py-1.5 outline-none data-[highlighted]:bg-bg-hover data-[disabled]:text-text-disabled";

const MUTE_CHOICES: {
  key: "channel.mute.15m" | "channel.mute.1h" | "channel.mute.8h" | "channel.mute.forever";
  ms: number | null;
}[] = [
  { key: "channel.mute.15m", ms: 15 * 60_000 },
  { key: "channel.mute.1h", ms: 3_600_000 },
  { key: "channel.mute.8h", ms: 8 * 3_600_000 },
  { key: "channel.mute.forever", ms: null },
];

function ChannelRow({
  channel,
  siblings,
  onEdit,
}: {
  channel: Channel;
  siblings: Channel[];
  onEdit: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const read = useChat((s) => s.read[channel.id]);
  const settings = useCommunity((s) => s.settings);
  const canManage = useCan("MANAGE_CHANNELS");
  const markRead = useChat((s) => s.markRead);
  const { level, muted } = levelFor(settings, channel.id, Date.now());
  const unread = isUnread(read) && !muted && level !== "none";
  const mentions = read?.mentionCount ?? 0;
  const index = siblings.findIndex((c) => c.id === channel.id);
  const isVoice = channel.type === "voice";
  const inVoice = useVoice((s) => s.presence[channel.id]) ?? NONE;

  const savePref = async (pref: ChannelPref | null) => {
    try {
      await api.patchSettings({ [`notifications.channel.${channel.id}`]: pref });
    } catch (e) {
      toastError(e);
    }
  };
  const move = async (dir: -1 | 1) => {
    const other = siblings[index + dir];
    if (!other) return;
    try {
      await api.reorderChannels([
        { id: channel.id, categoryId: channel.categoryId, position: other.position },
        { id: other.id, categoryId: other.categoryId, position: channel.position },
      ]);
    } catch (e) {
      toastError(e);
    }
  };

  const label = (
    <>
      {isVoice ? (
        <Volume2 aria-hidden="true" size={16} className="shrink-0" />
      ) : (
        <Hash aria-hidden="true" size={16} className="shrink-0" />
      )}
      <bdi className={`min-w-0 flex-1 truncate ${unread || mentions > 0 ? "font-semibold" : ""}`}>
        {channel.name}
      </bdi>
    </>
  );

  return (
    <li className="group relative flex flex-wrap items-center">
      {isVoice ? (
        <NavLink
          to={`/voice/${channel.id}`}
          onClick={() => void joinVoice(channel.id).catch(toastError)}
          aria-label={t("channel.voice.join", { name: channel.name })}
          className={({ isActive }) =>
            `flex min-h-8 flex-1 items-center gap-2 rounded-md px-2 text-text no-underline hover:bg-bg-hover ${isActive ? "bg-bg-selected" : ""}`
          }
        >
          {label}
        </NavLink>
      ) : (
        <NavLink
          to={`/channels/${channel.id}`}
          className={({ isActive }) =>
            `flex min-h-8 flex-1 items-center gap-2 rounded-md px-2 text-text no-underline hover:bg-bg-hover ${isActive ? "bg-bg-selected" : ""} ${muted ? "text-text-muted" : ""}`
          }
          aria-label={
            mentions > 0
              ? t("channel.aria.mentions", { name: channel.name, count: mentions })
              : unread
                ? t("channel.aria.unread", { name: channel.name })
                : undefined
          }
        >
          {unread && mentions === 0 ? (
            <span aria-hidden="true" className="absolute -start-1 size-2 rounded-full bg-text" />
          ) : null}
          {label}
          {mentions > 0 ? (
            <span
              aria-hidden="true"
              className="ms-auto min-w-5 rounded-full bg-danger px-1.5 text-center text-xs font-semibold text-text-on-danger"
            >
              {mentions}
            </span>
          ) : null}
        </NavLink>
      )}
      <Menu.Root>
        <Menu.Trigger
          aria-label={t("channel.menu", { name: channel.name })}
          className="absolute end-1 rounded-md p-1 opacity-0 hover:bg-bg-hover focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal aria-hidden="true" size={16} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="start" sideOffset={4} className={menuContent}>
            {!isVoice ? (
              <>
                <Menu.Item
                  className={menuItem}
                  onSelect={() => {
                    markRead(channel.id);
                  }}
                >
                  {t("channel.markRead")}
                </Menu.Item>
                <Menu.Sub>
                  <Menu.SubTrigger className={menuItem}>
                    {t("channel.mute")} <ChevronRight aria-hidden="true" size={14} className="ms-auto" />
                  </Menu.SubTrigger>
                  <Menu.Portal>
                    <Menu.SubContent className={menuContent} sideOffset={4}>
                      {muted ? (
                        <Menu.Item className={menuItem} onSelect={() => void savePref(null)}>
                          {t("channel.unmute")}
                        </Menu.Item>
                      ) : (
                        MUTE_CHOICES.map((c) => (
                          <Menu.Item
                            key={c.key}
                            className={menuItem}
                            onSelect={() =>
                              void savePref({
                                mutedUntil: c.ms === null ? Number.MAX_SAFE_INTEGER : Date.now() + c.ms,
                              })
                            }
                          >
                            {t(c.key)}
                          </Menu.Item>
                        ))
                      )}
                    </Menu.SubContent>
                  </Menu.Portal>
                </Menu.Sub>
                <Menu.Sub>
                  <Menu.SubTrigger className={menuItem}>
                    {t("channel.notifications")}{" "}
                    <ChevronRight aria-hidden="true" size={14} className="ms-auto" />
                  </Menu.SubTrigger>
                  <Menu.Portal>
                    <Menu.SubContent className={menuContent} sideOffset={4}>
                      <Menu.RadioGroup
                        value={
                          (settings[`notifications.channel.${channel.id}`] as ChannelPref | undefined)
                            ?.level ?? "default"
                        }
                        onValueChange={(v) =>
                          void savePref(v === "default" ? null : { level: v as "all" | "mentions" | "none" })
                        }
                      >
                        {(["default", "all", "mentions", "none"] as const).map((v) => (
                          <Menu.RadioItem key={v} value={v} className={menuItem}>
                            <span className="inline-block w-4 text-center" aria-hidden="true">
                              <Menu.ItemIndicator>•</Menu.ItemIndicator>
                            </span>
                            {t(`notifications.level.${v}`)}
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                    </Menu.SubContent>
                  </Menu.Portal>
                </Menu.Sub>
                <Menu.Item
                  className={menuItem}
                  onSelect={() => {
                    void navigator.clipboard
                      ?.writeText(`${window.location.origin}/channels/${channel.id}`)
                      .then(() => toast(t("channel.linkCopied")));
                  }}
                >
                  {t("channel.copyLink")}
                </Menu.Item>
              </>
            ) : null}
            {canManage ? (
              <>
                {!isVoice ? <Menu.Separator className="my-1 h-px bg-border" /> : null}
                <Menu.Item className={menuItem} onSelect={onEdit}>
                  {t("channel.edit")}
                </Menu.Item>
                <Menu.Item
                  className={menuItem}
                  onSelect={() => void navigate(`/settings/channels/${channel.id}`)}
                >
                  {t("channel.permissions")}
                </Menu.Item>
                <Menu.Item className={menuItem} disabled={index <= 0} onSelect={() => void move(-1)}>
                  {t("channel.moveUp")}
                </Menu.Item>
                <Menu.Item
                  className={menuItem}
                  disabled={index >= siblings.length - 1}
                  onSelect={() => void move(1)}
                >
                  {t("channel.moveDown")}
                </Menu.Item>
              </>
            ) : null}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {isVoice && inVoice.length > 0 ? (
        <ul
          className="m-0 basis-full list-none p-0"
          aria-label={t("channel.voice.in", { count: inVoice.length, name: channel.name })}
        >
          {inVoice.map((p) => (
            <ParticipantRow key={p.userId} p={p} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CategoryGroup({
  category,
  channels,
  canManage,
  onCreate,
  onEdit,
}: {
  category: Category | null;
  channels: Channel[];
  canManage: boolean;
  onCreate: (categoryId: string | null) => void;
  onEdit: (c: Channel) => void;
}) {
  const t = useT();
  const read = useChat((s) => s.read);
  const [open, setOpen] = useState(true);
  const unreadInside = channels.some((c) => isUnread(read[c.id]) || (read[c.id]?.mentionCount ?? 0) > 0);
  const name = category?.name ?? t("channel.uncategorised");
  return (
    <section aria-label={name} className="mb-2">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-7 flex-1 items-center gap-1 rounded-md px-1 text-xs font-semibold uppercase tracking-wide text-text-muted hover:text-text"
        >
          {open ? (
            <ChevronDown aria-hidden="true" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" size={14} />
          )}
          <bdi className="truncate">{name}</bdi>
          {!open && unreadInside ? (
            <span aria-hidden="true" className="ms-1 size-2 rounded-full bg-text" />
          ) : null}
        </button>
        {canManage ? (
          <button
            type="button"
            aria-label={t("channel.create.in", { name })}
            onClick={() => onCreate(category?.id ?? null)}
            className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <Plus aria-hidden="true" size={14} />
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="m-0 list-none px-2 py-0">
          {channels.map((c) => (
            <ChannelRow key={c.id} channel={c} siblings={channels} onEdit={() => onEdit(c)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The channel list (W-02): categories with their channels, unread and mention markers, and management for those who may. */
export function ChannelList() {
  const t = useT();
  const categories = useCommunity((s) => s.categories);
  const channels = useCommunity((s) => s.channels);
  const canManage = useCan("MANAGE_CHANNELS");
  const [dialog, setDialog] = useState<{ categoryId: string | null; edit?: Channel } | null>(null);

  const loose = channels.filter((c) => c.categoryId === null);
  const groups = categories
    .map((cat) => ({ cat, items: channels.filter((c) => c.categoryId === cat.id) }))
    .filter((g) => canManage || g.items.length > 0);

  if (channels.length === 0 && !canManage) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
        <p className="text-sm font-medium">{t("channel.none.title")}</p>
        <p className="text-sm text-text-muted">{t("channel.none.body")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-2" role="navigation" aria-label={t("channel.list")}>
      {loose.length > 0 ? (
        <CategoryGroup
          category={null}
          channels={loose}
          canManage={canManage}
          onCreate={(c) => setDialog({ categoryId: c })}
          onEdit={(c) => setDialog({ categoryId: c.categoryId, edit: c })}
        />
      ) : null}
      {groups.map(({ cat, items }) => (
        <CategoryGroup
          key={cat.id}
          category={cat}
          channels={items}
          canManage={canManage}
          onCreate={(c) => setDialog({ categoryId: c })}
          onEdit={(c) => setDialog({ categoryId: c.categoryId, edit: c })}
        />
      ))}
      {channels.length === 0 && canManage ? (
        <div className="px-4 py-6 text-center">
          <p className="mb-2 text-sm text-text-muted">{t("channel.none.admin")}</p>
          <button
            type="button"
            onClick={() => setDialog({ categoryId: null })}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-text-on-accent hover:bg-accent-hover"
          >
            {t("channel.create")}
          </button>
        </div>
      ) : null}
      {dialog ? (
        <CreateChannelDialog
          categoryId={dialog.categoryId}
          {...(dialog.edit ? { edit: dialog.edit } : {})}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
