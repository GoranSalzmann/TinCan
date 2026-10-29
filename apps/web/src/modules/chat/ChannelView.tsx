// SPDX-License-Identifier: AGPL-3.0-or-later
import { Hash, Pin, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import type { Message } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { useChat } from "../../core/state/chat.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { useUi } from "../../core/state/ui.js";
import { Modal } from "../../ui/Dialog.js";
import { SearchDialog } from "../search/SearchDialog.js";
import { Composer } from "./Composer.js";
import { LinkConfirmDialog } from "./linkGate.js";
import { MessageList } from "./MessageList.js";
import { toastError } from "../../ui/toast.js";

function Typing({ channelId, selfId }: { channelId: string; selfId: string }) {
  const t = useT();
  const typing = useChat((s) => s.typing[channelId]);
  const members = useCommunity((s) => s.members);
  const [, tick] = useState(0);
  const active = Object.entries(typing ?? {}).filter(([id, until]) => id !== selfId && until > Date.now());
  useEffect(() => {
    if (active.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active.length]);
  const names = active.map(([id]) => memberName(members[id], "Someone"));
  const text =
    names.length === 0
      ? ""
      : names.length === 1
        ? t("typing.one", { a: names[0]! })
        : names.length === 2
          ? t("typing.two", { a: names[0]!, b: names[1]! })
          : t("typing.many");
  return (
    <div className="h-5 px-4 text-xs text-text-muted" aria-live="polite" role="status">
      {text}
    </div>
  );
}

function Pins({
  channelId,
  onClose,
  onJump,
}: {
  channelId: string;
  onClose: () => void;
  onJump: (id: string) => void;
}) {
  const t = useT();
  const [pins, setPins] = useState<Message[] | null>(null);
  useEffect(() => {
    api
      .pins(channelId)
      .then(setPins)
      .catch((e: unknown) => {
        toastError(e);
        onClose();
      });
  }, [channelId, onClose]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t("channel.pins")} wide>
      {pins === null ? (
        <p role="status">{t("app.loading")}</p>
      ) : pins.length === 0 ? (
        <p className="text-text-muted">{t("channel.pins.empty")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {pins.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  onJump(m.id);
                  onClose();
                }}
                className="w-full rounded-md border border-border p-2 text-start hover:bg-bg-hover"
              >
                <span className="block text-sm font-semibold">
                  {m.author?.displayName ?? t("message.deletedUser")}
                </span>
                <span className="block truncate text-sm text-text-muted">
                  {m.content || t("message.attachmentOnly")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** A text channel: header, messages, typing line, composer (W-01, W-03, W-04). */
export function ChannelView() {
  const t = useT();
  const { channelId = "" } = useParams();
  const user = useSession((s) => s.user)!;
  const channel = useCommunity((s) => s.channels.find((c) => c.id === channelId));
  const ready = useCommunity((s) => s.ready);
  const perms = useCommunity((s) => s.channelPermissions[channelId] ?? 0n);
  const members = useCommunity((s) => s.members);
  const select = useUi((s) => s.select);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOn = useSession((s) => !!s.capabilities?.features.search);

  useEffect(() => {
    select(channelId);
    return () => select(null);
  }, [channelId, select]);
  useEffect(() => setReplyTo(null), [channelId]);

  // Ctrl/Cmd+K opens search from anywhere in the channel.
  useEffect(() => {
    if (!searchOn) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOn]);

  if (!ready)
    return (
      <div className="flex flex-1 items-center justify-center text-text-muted" role="status">
        {t("app.loading")}
      </div>
    );
  if (!channel || channel.type !== "text") return <Navigate to="/" replace />;

  const me = members[user.id];
  const editLast = () => {
    const win = useChat.getState().windows[channelId];
    const mine = win?.messages.findLast((m) => m.authorId === user.id);
    if (mine)
      document
        .getElementById(`m-${mine.id}`)
        ?.querySelector<HTMLButtonElement>('button[data-action="edit"]')
        ?.click();
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border ps-4 pe-4 md:pe-56">
        <Hash aria-hidden="true" size={20} className="shrink-0 text-text-muted" />
        <h1 className="truncate text-lg">
          <bdi>{channel.name}</bdi>
        </h1>
        {channel.topic ? (
          <p className="hidden min-w-0 flex-1 truncate border-s border-border ps-3 text-sm text-text-muted md:block">
            {channel.topic}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          aria-label={t("channel.pins")}
          onClick={() => setPinsOpen(true)}
          className="rounded-md p-1.5 hover:bg-bg-hover"
        >
          <Pin aria-hidden="true" size={18} />
        </button>
        {searchOn ? (
          <button
            type="button"
            aria-label={t("search.open")}
            title="Ctrl+K"
            onClick={() => setSearchOpen(true)}
            className="rounded-md p-1.5 hover:bg-bg-hover"
          >
            <Search aria-hidden="true" size={18} />
          </button>
        ) : null}
      </header>
      <MessageList
        channelId={channel.id}
        selfId={user.id}
        selfName={memberName(me, user.displayName)}
        selfAvatar={me?.avatarKey ?? user.avatarKey}
        perms={perms}
        onReply={setReplyTo}
      />
      <Typing channelId={channel.id} selfId={user.id} />
      <Composer
        channel={channel}
        perms={perms}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onEditLast={editLast}
      />
      <LinkConfirmDialog />
      {pinsOpen ? (
        <Pins
          channelId={channel.id}
          onClose={() => setPinsOpen(false)}
          onJump={(id) => void useChat.getState().jumpTo(channel.id, id)}
        />
      ) : null}
      {searchOpen ? <SearchDialog channelId={channel.id} onClose={() => setSearchOpen(false)} /> : null}
    </>
  );
}
