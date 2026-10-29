// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionInfo } from "@tincan/shared";
import { api, ApiError, type OwnAttachment } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import {
  notificationPermission,
  requestNotificationPermission,
  type PermissionState,
} from "../../core/notifications.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { ACCENT_NAMES } from "../../theme/tokens.js";
import { useAppearance } from "../../theme/store.js";
import { Avatar } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field, PasswordField } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import { formatSize } from "../chat/MessageItem.js";

function Pane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <h2 className="text-2xl">{title}</h2>
      {children}
    </section>
  );
}

const card = "flex flex-col gap-3 rounded-lg border border-border p-4";

// ---- My account (W-20, 11 §1.9) -----------------------------------------------------------------------

export function AccountPane() {
  const t = useT();
  const user = useSession((s) => s.user)!;
  const me = useCommunity((s) => s.members[user.id]);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [status, setStatus] = useState(me?.statusText ?? "");
  const [nick, setNick] = useState(me?.nickname ?? "");
  const file = useRef<HTMLInputElement>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", error: null as string | null });

  useEffect(() => {
    void api.sessions().then(setSessions).catch(toastError);
  }, []);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patchProfile({ displayName, statusText: status.trim() === "" ? null : status });
      await api.setNickname(user.id, nick.trim() === "" ? null : nick.trim());
      toast(t("settings.saved"));
    } catch (err) {
      toastError(err);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPw((p) => ({ ...p, error: null }));
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", error: null });
      toast(t("settings.password.changed"));
      void api.sessions().then(setSessions);
    } catch (err) {
      const fields =
        err instanceof ApiError ? (err.details?.fields as Record<string, string> | undefined) : undefined;
      setPw((p) => ({
        ...p,
        error: fields?.password ?? (err instanceof ApiError ? err.message : t("error.INTERNAL")),
      }));
    }
  };

  return (
    <Pane title={t("settings.account")}>
      <form className={card} onSubmit={(e) => void saveProfile(e)}>
        <h3 className="text-lg">{t("settings.profile")}</h3>
        <div className="flex items-center gap-4">
          <Avatar name={user.displayName} avatarKey={me?.avatarKey ?? user.avatarKey} size={72} />
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => file.current?.click()}>
              {t("settings.avatar.change")}
            </Button>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f)
                  void api
                    .setAvatar(f)
                    .then(() => toast(t("settings.saved")))
                    .catch(toastError);
              }}
            />
            {me?.avatarKey ? (
              <Button variant="ghost" onClick={() => void api.clearAvatar().catch(toastError)}>
                {t("settings.avatar.remove")}
              </Button>
            ) : null}
          </div>
        </div>
        <Field
          label={t("setup.account.displayName")}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={32}
          required
        />
        <Field
          label={t("settings.nickname")}
          hint={t("settings.nickname.hint")}
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          maxLength={32}
        />
        <Field
          label={t("settings.status")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          maxLength={128}
        />
        <div>
          <Button type="submit">{t("common.save")}</Button>
        </div>
      </form>

      <form className={card} onSubmit={(e) => void changePassword(e)}>
        <h3 className="text-lg">{t("settings.password")}</h3>
        <PasswordField
          label={t("settings.password.current")}
          autoComplete="current-password"
          value={pw.current}
          onChange={(e) => setPw({ ...pw, current: e.target.value })}
        />
        <PasswordField
          label={t("settings.password.new")}
          autoComplete="new-password"
          error={pw.error}
          value={pw.next}
          onChange={(e) => setPw({ ...pw, next: e.target.value })}
        />
        <div>
          <Button type="submit" disabled={!pw.current || !pw.next}>
            {t("settings.password.change")}
          </Button>
        </div>
      </form>

      <div className={card}>
        <h3 className="text-lg">{t("settings.sessions")}</h3>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {(sessions ?? []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{s.clientName}</span>
                {s.current ? (
                  <span className="ms-2 rounded-full border border-border px-2 text-xs">
                    {t("settings.sessions.current")}
                  </span>
                ) : null}
                <span className="block text-text-muted">
                  {t("settings.sessions.lastUsed", { date: new Date(s.lastUsedAt).toLocaleString() })}
                </span>
              </span>
              {!s.current ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void api
                      .revokeSession(s.id)
                      .then(() => setSessions((cur) => cur?.filter((x) => x.id !== s.id) ?? null))
                      .catch(toastError)
                  }
                >
                  {t("settings.sessions.revoke")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Pane>
  );
}

// ---- Appearance (W-26): saved on the server so it follows you (12 §8) ------------------------------------

export function AppearancePane() {
  const t = useT();
  const { theme, accent, setTheme, setAccent } = useAppearance();
  const sync = (key: string, value: string) =>
    void api.patchSettings({ [key]: value }).catch(() => undefined);
  return (
    <Pane title={t("settings.appearance")}>
      <fieldset className={card}>
        <legend className="px-1 text-lg">{t("appearance.title")}</legend>
        {(["system", "light", "dark", "hc"] as const).map((v) => (
          <label key={v} className="flex items-center gap-2">
            <input
              type="radio"
              name="theme"
              checked={theme === v}
              onChange={() => {
                setTheme(v);
                sync("appearance.theme", v === "hc" ? "dark" : v);
              }}
            />
            {t(`appearance.theme.${v}` as MessageKey)}
          </label>
        ))}
      </fieldset>
      <fieldset className={card}>
        <legend className="px-1 text-lg">{t("appearance.accent")}</legend>
        <div className="flex flex-wrap gap-3">
          {ACCENT_NAMES.map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="accent"
                checked={accent === v}
                onChange={() => {
                  setAccent(v);
                  sync("appearance.accent", v);
                }}
              />
              {t(`accent.${v}` as MessageKey)}
            </label>
          ))}
        </div>
      </fieldset>
    </Pane>
  );
}

// ---- Notifications (12 §5.4, 12 §8) -------------------------------------------------------------------------

export function NotificationsPane() {
  const t = useT();
  const settings = useCommunity((s) => s.settings);
  const channels = useCommunity((s) => s.channels).filter((c) => c.type === "text");
  const [perm, setPerm] = useState<PermissionState>(notificationPermission());
  const level = (settings["notifications.default"] as string | undefined) ?? "all";
  const save = (patch: Record<string, unknown>) => void api.patchSettings(patch).catch(toastError);
  return (
    <Pane title={t("settings.notifications")}>
      <div className={card}>
        <h3 className="text-lg">{t("notifications.browser")}</h3>
        {perm === "unsupported" ? (
          <p className="text-text-muted">{t("notifications.unsupported")}</p>
        ) : perm === "granted" ? (
          <p>{t("notifications.on")}</p>
        ) : perm === "denied" ? (
          <p className="text-text-muted">{t("notifications.denied")}</p>
        ) : (
          <>
            <p className="text-text-muted">{t("notifications.ask")}</p>
            <div>
              <Button onClick={() => void requestNotificationPermission().then(setPerm)}>
                {t("notifications.enable")}
              </Button>
            </div>
          </>
        )}
      </div>
      <fieldset className={card}>
        <legend className="px-1 text-lg">{t("notifications.default")}</legend>
        {(["all", "mentions", "none"] as const).map((v) => (
          <label key={v} className="flex items-center gap-2">
            <input
              type="radio"
              name="default"
              checked={level === v}
              onChange={() => save({ "notifications.default": v })}
            />
            {t(`notifications.level.${v}`)}
          </label>
        ))}
      </fieldset>
      <div className={card}>
        <h3 className="text-lg">{t("notifications.perChannel")}</h3>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {channels.map((c) => {
            const pref = settings[`notifications.channel.${c.id}`] as { level?: string } | undefined;
            return (
              <li key={c.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate">#{c.name}</span>
                <select
                  aria-label={t("notifications.channelLevel", { name: c.name })}
                  value={pref?.level ?? "default"}
                  onChange={(e) =>
                    save({
                      [`notifications.channel.${c.id}`]:
                        e.target.value === "default" ? null : { level: e.target.value },
                    })
                  }
                  className="rounded-md border border-border-control bg-bg-input px-2 py-1"
                >
                  {(["default", "all", "mentions", "none"] as const).map((v) => (
                    <option key={v} value={v}>
                      {t(`notifications.level.${v}`)}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      </div>
    </Pane>
  );
}

// ---- Storage (W-23, design U16) --------------------------------------------------------------------------------

export function StoragePane() {
  const t = useT();
  const navigate = useNavigate();
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number } | null>(null);
  const [sort, setSort] = useState<"size" | "date">("size");
  const [items, setItems] = useState<OwnAttachment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState<OwnAttachment | null>(null);
  const channels = useCommunity((s) => s.channels);

  const load = (more: boolean, cur: string | null) =>
    api
      .ownAttachments({ sort, ...(more && cur ? { cursor: cur } : {}) })
      .then((p) => {
        setItems((prev) => (more ? [...prev, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setLoaded(true);
      })
      .catch(toastError);
  useEffect(() => {
    void api
      .storage()
      .then(setUsage)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void load(false, null);
  }, [sort]);

  const pct = usage && usage.quotaBytes > 0 ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100) : 0;
  return (
    <Pane title={t("settings.storage")}>
      {usage ? (
        <div className={card}>
          <p>
            {t("storage.used", { used: formatSize(usage.usedBytes), quota: formatSize(usage.quotaBytes) })}
          </p>
          <progress value={pct} max={100} aria-label={t("settings.storage")} className="h-2 w-full" />
          {pct >= 90 ? <p className="text-warning-text">{t("storage.nearlyFull")}</p> : null}
        </div>
      ) : null}
      <div className={card}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg">{t("storage.yours")}</h3>
          <label className="flex items-center gap-2 text-sm">
            {t("search.sort")}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "size" | "date")}
              className="rounded-md border border-border-control bg-bg-input px-2 py-1"
            >
              <option value="size">{t("storage.sort.size")}</option>
              <option value="date">{t("storage.sort.date")}</option>
            </select>
          </label>
        </div>
        {loaded && items.length === 0 ? <p className="text-text-muted">{t("storage.none")}</p> : null}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{a.filename}</span>
                <span className="block text-text-muted">
                  {formatSize(a.size)} · {new Date(a.createdAt).toLocaleDateString()}
                  {a.channelId ? <> · #{channels.find((c) => c.id === a.channelId)?.name ?? "?"}</> : null}
                </span>
              </span>
              {a.channelId && a.messageId ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    void navigate(`/channels/${a.channelId}`);
                  }}
                >
                  {t("storage.show")}
                </Button>
              ) : null}
              <Button variant="ghost" className="text-danger-text" onClick={() => setTarget(a)}>
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
        {cursor ? (
          <Button variant="ghost" onClick={() => void load(true, cursor)}>
            {t("search.more")}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t("storage.delete.title")}
        body={t("storage.delete.body")}
        confirmLabel={t("common.delete")}
        onConfirm={async () => {
          if (!target) return;
          try {
            await api.deleteUpload(target.id);
            setItems((cur) => cur.filter((x) => x.id !== target.id));
            void api.storage().then(setUsage);
          } catch (e) {
            toastError(e);
          }
        }}
      />
    </Pane>
  );
}

export { memberName };
