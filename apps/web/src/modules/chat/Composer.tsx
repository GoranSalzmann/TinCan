// SPDX-License-Identifier: AGPL-3.0-or-later
import { Paperclip, Send, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { has, type Channel, type Message } from "@tincan/shared";
import { api, ApiError, uploadFile, type UploadResult } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { sendCommand, useSession } from "../../core/session/store.js";
import { useChat } from "../../core/state/chat.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { toast } from "../../ui/toast.js";
import { formatSize } from "./MessageItem.js";
import {
  activeTrigger,
  candidatesFor,
  encodeMentions,
  filterCandidates,
  tokenOf,
  type Candidate,
  type InsertedMention,
} from "./mentions.js";

interface Upload {
  key: string;
  file: File;
  progress: number;
  result?: UploadResult;
  error?: string;
  abort: AbortController;
}

const DRAFT_KEY = (channelId: string) => `tincan.draft.${channelId}`;

function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY(channelId)) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(channelId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY(channelId), text);
    else localStorage.removeItem(DRAFT_KEY(channelId));
  } catch {
    // Storage can be unavailable (private windows); a draft is a convenience only.
  }
}

/** The message composer (W-04, 12 §5.5). */
export function Composer({
  channel,
  perms,
  replyTo,
  onCancelReply,
  onEditLast,
}: {
  channel: Channel;
  perms: bigint;
  replyTo: Message | null;
  onCancelReply: () => void;
  onEditLast: () => void;
}) {
  const t = useT();
  const caps = useSession((s) => s.capabilities);
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles);
  const channels = useCommunity((s) => s.channels);
  const send = useChat((s) => s.send);
  const maxChars = caps?.limits.messageMaxChars ?? 4000;
  const uploadsOn = !!caps?.features.uploads;
  const canSend = has(perms, "SEND_MESSAGES");
  const canAttach = uploadsOn && has(perms, "ATTACH_FILES");

  const [text, setText] = useState(() => loadDraft(channel.id));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [inserted, setInserted] = useState<InsertedMention[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const area = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // A different channel brings its own draft.
  useEffect(() => {
    setText(loadDraft(channel.id));
    setUploads([]);
    setInserted([]);
  }, [channel.id]);
  useEffect(() => {
    const id = setTimeout(() => saveDraft(channel.id, text), 300);
    return () => clearTimeout(id);
  }, [text, channel.id]);

  // Replying focuses the box.
  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  // Size to fit, up to a limit (W-04).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Slowmode countdown
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [cooldownUntil]);
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  // ---- mention autocomplete ----
  const trigger = canSend ? activeTrigger(text, caret) : null;
  const all = useMemo(
    () =>
      trigger
        ? candidatesFor(
            trigger.trigger,
            Object.values(members),
            roles,
            channels,
            has(perms, "MENTION_EVERYONE"),
          )
        : [],
    [trigger?.trigger, members, roles, channels, perms],
  );
  const options: Candidate[] =
    trigger && dismissed !== trigger.start ? filterCandidates(all, trigger.query) : [];
  useEffect(() => setActive(0), [trigger?.query, trigger?.trigger]);

  const pick = (c: Candidate) => {
    if (!trigger) return;
    const m = tokenOf(c);
    const next = `${text.slice(0, trigger.start)}${m.label} ${text.slice(caret)}`;
    setText(next);
    setInserted((cur) => [...cur.filter((x) => x.label !== m.label), m]);
    const pos = trigger.start + m.label.length + 1;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // ---- uploads ----
  const addFiles = useCallback(
    (files: File[]) => {
      if (!canAttach) return;
      const maxBytes =
        (caps?.features.uploads as { maxBytes?: number } | undefined)?.maxBytes ?? 25 * 1024 * 1024;
      for (const file of files.slice(0, 10)) {
        if (file.size > maxBytes) {
          toast(t("composer.fileTooLarge", { name: file.name, max: formatSize(maxBytes) }), "error");
          continue;
        }
        const u: Upload = {
          key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
          file,
          progress: 0,
          abort: new AbortController(),
        };
        setUploads((cur) => [...cur, u]);
        uploadFile(
          file,
          (p) => setUploads((cur) => cur.map((x) => (x.key === u.key ? { ...x, progress: p } : x))),
          u.abort.signal,
        )
          .then((result) =>
            setUploads((cur) => cur.map((x) => (x.key === u.key ? { ...x, result, progress: 1 } : x))),
          )
          .catch((e: unknown) => {
            if (e instanceof DOMException && e.name === "AbortError") return;
            const msg =
              e instanceof ApiError && e.code === "QUOTA_EXCEEDED"
                ? t("composer.quota")
                : e instanceof ApiError
                  ? e.message
                  : t("composer.uploadFailed");
            setUploads((cur) => cur.map((x) => (x.key === u.key ? { ...x, error: msg } : x)));
          });
      }
    },
    [canAttach, caps, t],
  );

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length > 0 && canAttach) {
      e.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  // ---- sending ----
  const ready = uploads.every((u) => u.result || u.error);
  const attachments = uploads.flatMap((u) => (u.result ? [u.result] : []));
  const content = encodeMentions(text, inserted, Object.values(members)).trim();
  const tooLong = [...content].length > maxChars;
  const canSubmit =
    canSend && ready && !tooLong && cooldownLeft === 0 && (content.length > 0 || attachments.length > 0);

  const submit = () => {
    if (!canSubmit) return;
    void send(channel.id, {
      content,
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    setText("");
    setInserted([]);
    setUploads([]);
    saveDraft(channel.id, "");
    onCancelReply();
    const slow = channel.settings.slowmodeSecs ?? 0;
    if (slow > 0 && !has(perms, "MANAGE_MESSAGES")) {
      setCooldownUntil(Date.now() + slow * 1000);
      setNow(Date.now());
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0 && trigger) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(options[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(trigger.start);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && text === "") {
      e.preventDefault();
      onEditLast();
    } else if (e.key === "Escape" && replyTo) {
      onCancelReply();
    }
  };

  const onChange = (value: string, pos: number) => {
    setText(value);
    setCaret(pos);
    if (value.trim() && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      sendCommand("typing.start", { channelId: channel.id });
    }
  };

  if (!canSend) {
    return (
      <div className="border-t border-border px-4 py-3 text-sm text-text-muted" role="note">
        {t("composer.noPermission")}
      </div>
    );
  }

  const listId = `mention-list-${channel.id}`;
  const replyAuthor = replyTo
    ? memberName(members[replyTo.authorId], replyTo.author?.displayName ?? t("message.deletedUser"))
    : "";
  return (
    <div
      className={`relative border-t border-border px-4 pt-2 pb-3 ${dragging ? "bg-bg-selected" : ""}`}
      onDragOver={(e) => {
        if (canAttach) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {replyTo ? (
        <div className="mb-1 flex items-center gap-2 rounded-md bg-bg-sidebar px-3 py-1 text-sm">
          <span className="truncate">{t("composer.replyingTo", { name: replyAuthor })}</span>
          <button
            type="button"
            aria-label={t("composer.cancelReply")}
            onClick={onCancelReply}
            className="ms-auto rounded-md p-1 hover:bg-bg-hover"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      ) : null}
      {uploads.length > 0 ? (
        <ul className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
          {uploads.map((u) => (
            <li
              key={u.key}
              className="flex max-w-60 items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{u.file.name}</span>
                {u.error ? (
                  <span className="block text-xs text-danger-text">{u.error}</span>
                ) : u.result ? (
                  <span className="block text-xs text-text-muted">{formatSize(u.file.size)}</span>
                ) : (
                  <progress
                    value={u.progress}
                    max={1}
                    aria-label={t("composer.uploading", { name: u.file.name })}
                    className="h-1.5 w-full"
                  />
                )}
              </span>
              <button
                type="button"
                aria-label={t("composer.removeFile", { name: u.file.name })}
                onClick={() => {
                  u.abort.abort();
                  if (u.result) void api.deleteUpload(u.result.id).catch(() => undefined);
                  setUploads((cur) => cur.filter((x) => x.key !== u.key));
                }}
                className="rounded-md p-1 hover:bg-bg-hover"
              >
                <X aria-hidden="true" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative flex items-end gap-2 rounded-md border border-border-control bg-bg-input px-2 py-1">
        {canAttach ? (
          <>
            <button
              type="button"
              aria-label={t("composer.attach")}
              onClick={() => fileInput.current?.click()}
              className="mb-0.5 rounded-md p-1.5 hover:bg-bg-hover"
            >
              <Paperclip aria-hidden="true" size={18} />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label={t("composer.label", { name: channel.name })}
          placeholder={t("composer.placeholder", { name: channel.name })}
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? listId : undefined}
          aria-activedescendant={options.length > 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-56 min-h-9 flex-1 resize-none bg-transparent py-1.5 outline-none"
        />
        <button
          type="button"
          aria-label={t("composer.send")}
          disabled={!canSubmit}
          onClick={submit}
          className="mb-0.5 rounded-md p-1.5 text-accent-text hover:bg-bg-hover disabled:text-text-disabled"
        >
          <Send aria-hidden="true" size={18} />
        </button>
        {options.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={t("composer.suggestions")}
            className="elev-2 absolute start-0 bottom-full z-30 mb-1 max-h-60 w-72 list-none overflow-y-auto p-1"
          >
            {options.map((o, i) => (
              <li
                key={`${o.kind}-${o.id}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm ${i === active ? "bg-bg-selected" : "hover:bg-bg-hover"}`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {o.kind === "channel" ? "#" : "@"}
                  {o.label}
                </span>
                <span className="text-xs text-text-muted">{t(`composer.kind.${o.kind}`)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mt-1 flex min-h-5 items-center justify-between gap-2 text-xs text-text-muted">
        <span aria-live="polite">
          {cooldownLeft > 0 ? (
            t("composer.slowmode", { seconds: cooldownLeft })
          ) : tooLong ? (
            <span className="text-danger-text">
              {t("composer.tooLong", { count: [...content].length - maxChars })}
            </span>
          ) : (
            t("composer.hint")
          )}
        </span>
        {[...content].length > maxChars * 0.8 ? (
          <span>
            {[...content].length} / {maxChars}
          </span>
        ) : null}
      </div>
    </div>
  );
}
