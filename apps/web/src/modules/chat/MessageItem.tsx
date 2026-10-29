// SPDX-License-Identifier: AGPL-3.0-or-later
import { memo, useMemo, useState } from "react";
import { Copy, CornerUpLeft, FileText, Pencil, Pin, Trash2 } from "lucide-react";
import { has, type Attachment, type Message } from "@tincan/shared";
import { api, fileUrl } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useChat, type PendingMessage } from "../../core/state/chat.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { useUi } from "../../core/state/ui.js";
import { Avatar } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { toast, toastError } from "../../ui/toast.js";
import { useLinkGate } from "./linkGate.js";
import { Markdown, type RenderContext } from "./markdown.js";
import { decodeMentions, encodeMentions, type InsertedMention } from "./mentions.js";

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The names a message needs to render its mentions, read from the community store. */
export function useRenderContext(selfId: string): RenderContext {
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles);
  const channels = useCommunity((s) => s.channels);
  const request = useLinkGate((s) => s.request);
  return useMemo(
    () => ({
      userName: (id) => memberName(members[id]),
      roleName: (id) => roles.find((r) => r.id === id)?.name ?? null,
      channelName: (id) => channels.find((c) => c.id === id)?.name ?? null,
      selfId,
      selfRoleIds: members[selfId]?.roleIds ?? [],
      openChannel: (id) => useUi.getState().navigator?.(id),
      openLink: request,
    }),
    [members, roles, channels, selfId, request],
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const t = useT();
  if (a.removed) {
    return (
      <div className="my-1 inline-block rounded-md border border-border px-3 py-2 text-sm text-text-muted">
        {t("message.fileRemoved")}
      </div>
    );
  }
  const href = fileUrl(a.id, a.filename);
  const isImage = a.hasThumbnail && a.width && a.height;
  if (isImage) {
    // Width and height are known, so the box is reserved before the image loads (no layout shift).
    const maxW = 360;
    const w = Math.min(a.width!, maxW);
    const h = Math.round((a.height! * w) / a.width!);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="my-1 inline-block max-w-full no-underline"
      >
        <img
          src={fileUrl(a.id, a.filename, true)}
          alt={a.filename}
          width={w}
          height={h}
          loading="lazy"
          style={{ aspectRatio: `${a.width} / ${a.height}` }}
          className="max-h-80 max-w-full rounded-md bg-bg-input object-contain"
        />
        <span className="block text-xs text-text-muted">
          {a.filename} · {a.width} × {a.height}
        </span>
      </a>
    );
  }
  return (
    <a
      href={href}
      download={a.filename}
      className="my-1 flex max-w-sm items-center gap-3 rounded-md border border-border bg-bg-sidebar px-3 py-2 no-underline"
    >
      <FileText aria-hidden="true" size={24} className="shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-link underline">{a.filename}</span>
        <span className="block text-xs text-text-muted">{formatSize(a.size)}</span>
      </span>
      <span className="text-sm text-accent-text">{t("message.download")}</span>
    </a>
  );
}

export interface MessageItemProps {
  message: Message;
  grouped: boolean;
  highlight: boolean;
  selfId: string;
  /** Base permissions in this channel, for the toolbar. */
  perms: bigint;
  onReply: (m: Message) => void;
  onJump: (id: string) => void;
}

export const MessageItem = memo(function MessageItem({
  message: m,
  grouped,
  highlight,
  selfId,
  perms,
  onReply,
  onJump,
}: MessageItemProps) {
  const t = useT();
  const ctx = useRenderContext(selfId);
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles);
  const channels = useCommunity((s) => s.channels);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [inserted, setInserted] = useState<InsertedMention[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const own = m.authorId === selfId;
  const canManage = has(perms, "MANAGE_MESSAGES");
  const author = members[m.authorId];
  const name = author ? memberName(author) : (m.author?.displayName ?? t("message.deletedUser"));
  const mentioned =
    m.mentions.everyone ||
    m.mentions.users.includes(selfId) ||
    m.mentions.roles.some((r) => ctx.selfRoleIds.includes(r));

  const startEdit = () => {
    const d = decodeMentions(m.content, {
      user: (id) => (members[id] ? memberName(members[id]) : "Deleted User"),
      role: (id) => roles.find((r) => r.id === id)?.name ?? null,
      channel: (id) => channels.find((c) => c.id === id)?.name ?? null,
    });
    setDraft(d.text);
    setInserted(d.inserted);
    setEditing(true);
  };
  const saveEdit = async () => {
    const content = encodeMentions(draft, inserted, Object.values(members));
    if (content.trim() === "" || content === m.content) {
      setEditing(false);
      return;
    }
    try {
      await api.editMessage(m.channelId, m.id, content);
      setEditing(false);
    } catch (e) {
      toastError(e);
    }
  };

  const toolbar = (
    <div
      role="toolbar"
      aria-label={t("message.actions")}
      className="elev-2 absolute -top-3 end-3 hidden items-center rounded-md p-0.5 group-focus-within:flex group-hover:flex"
    >
      <ToolButton label={t("message.reply")} onClick={() => onReply(m)}>
        <CornerUpLeft aria-hidden="true" size={16} />
      </ToolButton>
      {own && has(perms, "SEND_MESSAGES") ? (
        <ToolButton label={t("message.edit")} onClick={startEdit} action="edit">
          <Pencil aria-hidden="true" size={16} />
        </ToolButton>
      ) : null}
      {canManage ? (
        <ToolButton
          label={m.pinned ? t("message.unpin") : t("message.pin")}
          onClick={() => void api.pin(m.channelId, m.id, !m.pinned).catch(toastError)}
        >
          <Pin aria-hidden="true" size={16} />
        </ToolButton>
      ) : null}
      <ToolButton
        label={t("message.copy")}
        onClick={() => {
          void navigator.clipboard?.writeText(m.content).then(() => toast(t("message.copied")));
        }}
      >
        <Copy aria-hidden="true" size={16} />
      </ToolButton>
      {own || canManage ? (
        <ToolButton label={t("message.delete")} onClick={() => setConfirmDelete(true)}>
          <Trash2 aria-hidden="true" size={16} />
        </ToolButton>
      ) : null}
    </div>
  );

  return (
    <article
      id={`m-${m.id}`}
      data-testid="message"
      aria-label={t("message.aria", { name, time: time.format(new Date(m.createdAt)) })}
      className={`group relative flex gap-3 px-4 ${grouped ? "py-0.5" : "pt-2 pb-0.5"} ${mentioned ? "border-s-4 border-accent bg-bg-mention" : ""} ${highlight ? "bg-bg-selected" : "hover:bg-bg-hover"}`}
    >
      <div className="w-10 shrink-0">
        {grouped ? (
          <time
            dateTime={m.createdAt}
            title={full.format(new Date(m.createdAt))}
            className="hidden pt-1 text-xs text-text-muted group-hover:block"
          >
            {time.format(new Date(m.createdAt))}
          </time>
        ) : (
          <Avatar name={name} avatarKey={author?.avatarKey ?? m.author?.avatarKey} size={40} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {m.reply ? (
          <button
            type="button"
            onClick={() => !m.reply!.deleted && onJump(m.reply!.id)}
            className="mb-0.5 flex max-w-full items-center gap-1 truncate text-start text-sm text-text-muted hover:text-text"
          >
            <CornerUpLeft aria-hidden="true" size={14} className="shrink-0" />
            {m.reply.deleted ? (
              <em>{t("message.reply.deleted")}</em>
            ) : (
              <>
                <span className="font-medium">{m.reply.authorName ?? t("message.deletedUser")}</span>
                <span className="truncate">{m.reply.excerpt}</span>
              </>
            )}
          </button>
        ) : null}
        {!grouped ? (
          <div className="flex items-baseline gap-2">
            <bdi className="font-semibold">{name}</bdi>
            <time
              dateTime={m.createdAt}
              title={full.format(new Date(m.createdAt))}
              className="text-xs text-text-muted"
            >
              {time.format(new Date(m.createdAt))}
            </time>
            {m.pinned ? <Pin aria-label={t("message.pinned")} size={12} className="text-text-muted" /> : null}
          </div>
        ) : null}
        {editing ? (
          <div className="flex flex-col gap-1">
            <textarea
              autoFocus
              value={draft}
              aria-label={t("message.edit")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                } else if (e.key === "Escape") setEditing(false);
              }}
              rows={Math.min(8, draft.split("\n").length + 1)}
              className="w-full resize-none rounded-md border border-border-control bg-bg-input p-2"
            />
            <div className="flex items-center gap-2 text-xs text-text-muted">
              {t("message.edit.hint")}
              <Button variant="ghost" className="min-h-6 px-2 py-0 text-xs" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
              <Button className="min-h-6 px-2 py-0 text-xs" onClick={() => void saveEdit()}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {m.content ? (
              <div>
                <Markdown text={m.content} ctx={ctx} />
                {m.editedAt ? (
                  <span className="text-xs text-text-muted" title={full.format(new Date(m.editedAt))}>
                    {" "}
                    {t("message.edited")}
                  </span>
                ) : null}
              </div>
            ) : null}
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} a={a} />
            ))}
          </>
        )}
      </div>
      {!editing ? toolbar : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("message.delete.title")}
        body={t("message.delete.body")}
        confirmLabel={t("message.delete")}
        onConfirm={() => api.deleteMessage(m.channelId, m.id).catch(toastError)}
      />
    </article>
  );
});

function ToolButton({
  label,
  onClick,
  children,
  action,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  action?: string;
}) {
  return (
    <button
      type="button"
      data-action={action}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1.5 hover:bg-bg-hover"
    >
      {children}
    </button>
  );
}

/** An unconfirmed or failed message of ours: dimmed, with retry and delete when it failed (W-03). */
export function PendingItem({
  p,
  selfName,
  selfAvatar,
}: {
  p: PendingMessage;
  selfName: string;
  selfAvatar: string | null;
}) {
  const t = useT();
  const retry = useChat((s) => s.retry);
  const discard = useChat((s) => s.discard);
  return (
    <article
      data-testid="pending-message"
      className={`flex gap-3 px-4 pt-2 pb-0.5 ${p.status === "sending" ? "opacity-60" : ""}`}
    >
      <Avatar name={selfName} avatarKey={selfAvatar} size={40} />
      <div className="min-w-0 flex-1">
        <bdi className="font-semibold">{selfName}</bdi>
        <p className="whitespace-pre-wrap break-words">{p.content}</p>
        {p.attachments.map((a) => (
          <div key={a.id} className="text-sm text-text-muted">
            {a.filename}
          </div>
        ))}
        {p.status === "sending" ? (
          <span className="text-xs text-text-muted">{t("message.sending")}</span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-danger-text" role="alert">
            {t("message.failed")}
            {p.error ? `: ${p.error}` : ""}
            <Button
              variant="ghost"
              className="min-h-6 px-2 py-0 text-xs"
              onClick={() => void retry(p.channelId, p.nonce)}
            >
              {t("message.retry")}
            </Button>
            <Button
              variant="ghost"
              className="min-h-6 px-2 py-0 text-xs"
              onClick={() => discard(p.channelId, p.nonce)}
            >
              {t("message.discard")}
            </Button>
          </span>
        )}
      </div>
    </article>
  );
}
