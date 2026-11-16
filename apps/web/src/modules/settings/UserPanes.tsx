// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Monitor, Moon, Contrast, Sun, type LucideIcon } from "lucide-react";
import type { SessionInfo } from "@tincan/shared";
import { api, ApiError, type OwnAttachment } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { requestNotificationPermission, useNotificationPermission } from "../../core/notifications.js";
import { usePushState } from "../../core/push.js";
import { useFeature, useSession } from "../../core/session/store.js";
import { playSfx, useSfxPrefs, type SfxCategory } from "../../core/sfx/sfx.js";
import { memberName, useCommunity } from "../../core/state/community.js";
import { ACCENT_NAMES, ACCENT_PRESETS } from "../../theme/tokens.js";
import { useAppearance, type ThemePreference } from "../../theme/store.js";
import { Avatar } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { Segmented, selectClass } from "../../ui/Controls.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field, PasswordField } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import { formatSize } from "../chat/MessageItem.js";
import { FooterNote, Panel, PanelNote, Row, SettingsPage, SettingsSection, SwitchRow } from "./layout.js";

// ---- My account (W-20, 11 §1.9) -----------------------------------------------------------------------

/** Sessions listed before "Show all": this device first, then the rest most recently used first (as the server sends them). */
const SESSIONS_SHOWN = 5;

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
  const [allSessions, setAllSessions] = useState(false);
  const ordered = [...(sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  const shownSessions = allSessions ? ordered : ordered.slice(0, SESSIONS_SHOWN);
  const profileDirty =
    displayName !== user.displayName || status !== (me?.statusText ?? "") || nick !== (me?.nickname ?? "");

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
    <SettingsPage title={t("settings.account")} description={t("settings.account.description")}>
      <SettingsSection title={t("settings.profile")} description={t("settings.profile.description")}>
        <Panel
          label={t("settings.profile")}
          onSubmit={(e) => void saveProfile(e)}
          footer={
            <>
              {profileDirty ? <FooterNote>{t("settings.unsaved")}</FooterNote> : null}
              <Button type="submit" disabled={!profileDirty || !displayName.trim()}>
                {t("common.save")}
              </Button>
            </>
          }
        >
          <Row
            label={t("settings.avatar")}
            description={t("settings.avatar.description")}
            control={
              <>
                <Avatar name={user.displayName} avatarKey={me?.avatarKey ?? user.avatarKey} size={48} />
                <Button variant="ghost" onClick={() => file.current?.click()}>
                  {t("settings.avatar.change")}
                </Button>
                {me?.avatarKey ? (
                  <Button variant="ghost" onClick={() => void api.clearAvatar().catch(toastError)}>
                    {t("settings.avatar.remove")}
                  </Button>
                ) : null}
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
              </>
            }
          />
          <Field
            layout="row"
            label={t("setup.account.displayName")}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={32}
            required
          />
          <Field
            layout="row"
            label={t("settings.nickname")}
            hint={t("settings.nickname.hint")}
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            maxLength={32}
          />
          <Field
            layout="row"
            label={t("settings.status")}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            maxLength={128}
          />
        </Panel>
      </SettingsSection>

      <SettingsSection title={t("settings.password")} description={t("settings.password.description")}>
        <Panel
          label={t("settings.password")}
          onSubmit={(e) => void changePassword(e)}
          footer={
            <Button type="submit" disabled={!pw.current || !pw.next}>
              {t("settings.password.change")}
            </Button>
          }
        >
          <PasswordField
            layout="row"
            label={t("settings.password.current")}
            autoComplete="current-password"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
          <PasswordField
            layout="row"
            label={t("settings.password.new")}
            autoComplete="new-password"
            error={pw.error}
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
          />
        </Panel>
      </SettingsSection>

      <SettingsSection title={t("settings.sessions")} description={t("settings.sessions.description")}>
        <Panel
          label={t("settings.sessions")}
          footer={
            (sessions?.length ?? 0) > SESSIONS_SHOWN ? (
              <Button
                variant="ghost"
                aria-expanded={allSessions}
                onClick={() => setAllSessions(!allSessions)}
              >
                {allSessions
                  ? t("settings.sessions.showFewer")
                  : t("settings.sessions.showAll", { count: sessions?.length ?? 0 })}
              </Button>
            ) : undefined
          }
        >
          {shownSessions.map((s) => (
            <Row
              key={s.id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {s.clientName}
                  {s.current ? <span className="tag">{t("settings.sessions.current")}</span> : null}
                </span>
              }
              description={
                <span className="meta">
                  {t("settings.sessions.lastUsed", { date: new Date(s.lastUsedAt).toLocaleString() })}
                </span>
              }
              control={
                !s.current ? (
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
                ) : null
              }
            />
          ))}
        </Panel>
      </SettingsSection>
    </SettingsPage>
  );
}

// ---- Appearance (W-26): saved on the server so it follows you (12 §8) ------------------------------------

const THEME_ICONS: Record<ThemePreference, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
  hc: Contrast,
};

/** A small picture of the theme: page, sidebar and accent, in that theme's own colours. */
function ThemeSwatch({ theme }: { theme: ThemePreference }) {
  const one = (bg: string, side: string, line: string, accent: string) => (
    <span className="flex h-full flex-1" style={{ background: bg }}>
      <span className="w-1/3" style={{ background: side }} />
      <span className="flex flex-1 flex-col gap-1 p-1.5">
        <span className="h-1 w-3/4" style={{ background: line }} />
        <span className="h-1 w-1/2" style={{ background: line }} />
        <span className="mt-auto h-1.5 w-1/3" style={{ background: accent }} />
      </span>
    </span>
  );
  const light = one("#F8F6F2", "#EFEBE4", "#C9C3BA", "#C24E00");
  const dark = one("#151412", "#0F0E0C", "#3A3631", "#E86101");
  const hc = one("#000000", "#000000", "#FFFFFF", "#FF9F43");
  return (
    <span aria-hidden="true" className="flex h-16 w-full overflow-hidden rounded-sm border border-border">
      {theme === "system" ? (
        <>
          {light}
          {dark}
        </>
      ) : theme === "light" ? (
        light
      ) : theme === "dark" ? (
        dark
      ) : (
        hc
      )}
    </span>
  );
}

export function AppearancePane() {
  const t = useT();
  const { theme, accent, setTheme, setAccent } = useAppearance();
  const sync = (key: string, value: string) =>
    void api.patchSettings({ [key]: value }).catch(() => undefined);
  return (
    <SettingsPage title={t("settings.appearance")} description={t("settings.appearance.description")}>
      <SettingsSection title={t("appearance.theme")} description={t("appearance.theme.description")}>
        <div
          role="radiogroup"
          aria-label={t("appearance.theme")}
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          {(["system", "light", "dark", "hc"] as const).map((v) => {
            const Icon = THEME_ICONS[v];
            return (
              <label
                key={v}
                className="flex cursor-pointer flex-col gap-2.5 rounded-lg border border-border bg-bg-elevated p-2.5 hover:border-text-muted has-checked:border-accent has-checked:outline-1 has-checked:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus"
              >
                <input
                  type="radio"
                  name="theme"
                  className="sr-only"
                  checked={theme === v}
                  onChange={() => {
                    setTheme(v);
                    sync("appearance.theme", v === "hc" ? "dark" : v);
                  }}
                />
                <ThemeSwatch theme={v} />
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon aria-hidden="true" size={14} className="text-text-muted" />
                  {t(`appearance.theme.${v}` as MessageKey)}
                </span>
              </label>
            );
          })}
        </div>
      </SettingsSection>
      <SettingsSection title={t("appearance.accent")} description={t("appearance.accent.description")}>
        <div
          role="radiogroup"
          aria-label={t("appearance.accent")}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {ACCENT_NAMES.map((v) => (
            <label
              key={v}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border bg-bg-elevated px-3 text-sm hover:border-text-muted has-checked:border-accent has-checked:font-medium has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus"
            >
              <input
                type="radio"
                name="accent"
                className="sr-only"
                checked={accent === v}
                disabled={theme === "hc"}
                onChange={() => {
                  setAccent(v);
                  sync("appearance.accent", v);
                }}
              />
              <span aria-hidden="true" className="flex size-5 shrink-0 overflow-hidden rounded-sm">
                <span className="flex-1" style={{ background: ACCENT_PRESETS[v].light.accent }} />
                <span className="flex-1" style={{ background: ACCENT_PRESETS[v].dark.accent }} />
              </span>
              {t(`accent.${v}` as MessageKey)}
            </label>
          ))}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

// ---- Notifications (12 §5.4, 12 §8) -------------------------------------------------------------------------

const SFX_CATEGORIES: readonly SfxCategory[] = ["messages", "voice", "controls", "alerts"];

function SoundsSection() {
  const t = useT();
  const { prefs, set, setCategory } = useSfxPrefs();
  return (
    <SettingsSection title={t("sfx.title")} description={t("sfx.hint")}>
      <Panel label={t("sfx.title")}>
        <SwitchRow label={t("sfx.enabled")} checked={prefs.enabled} onChange={(v) => set({ enabled: v })} />
        <Row
          label={t("sfx.volume")}
          htmlFor="sfx-volume"
          control={
            <>
              <input
                id="sfx-volume"
                type="range"
                min={0}
                max={100}
                value={Math.round(prefs.volume * 100)}
                disabled={!prefs.enabled}
                onChange={(e) => set({ volume: Number(e.target.value) / 100 })}
                onPointerUp={() => playSfx("message")}
                onKeyUp={() => playSfx("message")}
                className="w-40"
              />
              <span className="meta w-9 text-end text-text-muted">{Math.round(prefs.volume * 100)}%</span>
              <Button
                variant="ghost"
                disabled={!prefs.enabled}
                onClick={() => playSfx("mention", { force: true })}
              >
                {t("sfx.test")}
              </Button>
            </>
          }
        />
      </Panel>
      <Panel label={t("sfx.categories")}>
        <div className="meta px-5 pt-3 pb-1 text-text-muted">{t("sfx.categories")}</div>
        {SFX_CATEGORIES.map((c) => (
          <SwitchRow
            key={c}
            label={t(`sfx.category.${c}` as MessageKey)}
            checked={prefs.categories[c]}
            disabled={!prefs.enabled}
            onChange={(v) => setCategory(c, v)}
          />
        ))}
      </Panel>
    </SettingsSection>
  );
}

export function NotificationsPane() {
  const t = useT();
  const settings = useCommunity((s) => s.settings);
  const channels = useCommunity((s) => s.channels).filter((c) => c.type === "text");
  const perm = useNotificationPermission();
  const push = usePushState();
  const pushFeature = useFeature("push");
  const level = (settings["notifications.default"] as "all" | "mentions" | "none" | undefined) ?? "all";
  const save = (patch: Record<string, unknown>) => void api.patchSettings(patch).catch(toastError);
  const levels = (["all", "mentions", "none"] as const).map((v) => ({
    value: v,
    label: t(`notifications.level.${v}`),
  }));
  return (
    <SettingsPage title={t("settings.notifications")} description={t("settings.notifications.description")}>
      <SettingsSection
        title={t("notifications.browser")}
        description={t("notifications.browser.description")}
      >
        <Panel label={t("notifications.browser")}>
          {perm === "unsupported" ? (
            <PanelNote>{t("notifications.unsupported")}</PanelNote>
          ) : perm === "granted" ? (
            <>
              <Row label={t("notifications.status")} description={t("notifications.on")} />
              {pushFeature && push.supported ? (
                <SwitchRow
                  label={t("notifications.push")}
                  checked={push.on}
                  disabled={push.busy}
                  onChange={() => push.toggle()}
                />
              ) : null}
            </>
          ) : perm === "denied" ? (
            <Row label={t("notifications.status")} description={t("notifications.denied")} />
          ) : (
            <Row
              label={t("notifications.status")}
              description={t("notifications.ask")}
              control={
                <Button onClick={() => void requestNotificationPermission()}>
                  {t("notifications.enable")}
                </Button>
              }
            />
          )}
        </Panel>
      </SettingsSection>

      <SettingsSection
        title={t("notifications.default")}
        description={t("notifications.default.description")}
      >
        <div>
          <Segmented
            label={t("notifications.default")}
            name="notify-default"
            value={level}
            options={levels}
            onChange={(v) => save({ "notifications.default": v })}
          />
        </div>
      </SettingsSection>

      <SoundsSection />

      {channels.length > 0 ? (
        <SettingsSection
          title={t("notifications.perChannel")}
          description={t("notifications.perChannel.description")}
        >
          <Panel label={t("notifications.perChannel")}>
            {channels.map((c) => {
              const pref = settings[`notifications.channel.${c.id}`] as { level?: string } | undefined;
              return (
                <Row
                  key={c.id}
                  label={
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="text-text-muted">
                        #
                      </span>
                      <bdi className="truncate">{c.name}</bdi>
                    </span>
                  }
                  control={
                    <select
                      aria-label={t("notifications.channelLevel", { name: c.name })}
                      value={pref?.level ?? "default"}
                      onChange={(e) =>
                        save({
                          [`notifications.channel.${c.id}`]:
                            e.target.value === "default" ? null : { level: e.target.value },
                        })
                      }
                      className={selectClass}
                    >
                      {(["default", "all", "mentions", "none"] as const).map((v) => (
                        <option key={v} value={v}>
                          {t(`notifications.level.${v}`)}
                        </option>
                      ))}
                    </select>
                  }
                />
              );
            })}
          </Panel>
        </SettingsSection>
      ) : null}
    </SettingsPage>
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
    <SettingsPage title={t("settings.storage")} description={t("settings.storage.description")}>
      {usage ? (
        <SettingsSection title={t("storage.usage")} description={t("storage.usage.description")}>
          <Panel label={t("storage.usage")}>
            <div className="flex flex-col gap-3 px-5 py-5">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-display text-3xl leading-none font-bold tracking-tight">
                  {formatSize(usage.usedBytes)}
                </span>
                <span className="meta text-text-muted">
                  {t("storage.ofQuota", { quota: formatSize(usage.quotaBytes) })}
                </span>
              </p>
              <div
                role="meter"
                aria-label={t("settings.storage")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
                aria-valuetext={t("storage.used", {
                  used: formatSize(usage.usedBytes),
                  quota: formatSize(usage.quotaBytes),
                })}
                className="h-2 w-full overflow-hidden rounded-sm bg-bg-selected"
              >
                <div
                  className={`h-full ${pct >= 90 ? "bg-warning" : "bg-accent"}`}
                  style={{ width: `${Math.max(pct, 0.5)}%` }}
                />
              </div>
              {pct >= 90 ? <p className="text-sm text-warning-text">{t("storage.nearlyFull")}</p> : null}
            </div>
          </Panel>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={t("storage.yours")}
        description={t("storage.yours.description")}
        aside={
          <label className="flex flex-col gap-1 text-sm">
            <span className="meta text-text-muted">{t("search.sort")}</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as "size" | "date")}
              className={selectClass}
            >
              <option value="size">{t("storage.sort.size")}</option>
              <option value="date">{t("storage.sort.date")}</option>
            </select>
          </label>
        }
      >
        <Panel
          label={t("storage.yours")}
          footer={
            cursor ? (
              <Button variant="ghost" onClick={() => void load(true, cursor)}>
                {t("search.more")}
              </Button>
            ) : undefined
          }
        >
          {loaded && items.length === 0 ? <PanelNote>{t("storage.none")}</PanelNote> : null}
          {items.map((a) => (
            <Row
              key={a.id}
              label={<span className="block truncate">{a.filename}</span>}
              description={
                <span className="meta flex flex-wrap gap-x-3">
                  <span>{formatSize(a.size)}</span>
                  <span>{new Date(a.createdAt).toLocaleDateString()}</span>
                  {a.channelId ? (
                    <span>#{channels.find((c) => c.id === a.channelId)?.name ?? "?"}</span>
                  ) : null}
                </span>
              }
              control={
                <>
                  {a.channelId && a.messageId ? (
                    <Button variant="ghost" onClick={() => void navigate(`/channels/${a.channelId}`)}>
                      {t("storage.show")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" className="text-danger-text" onClick={() => setTarget(a)}>
                    {t("common.delete")}
                  </Button>
                </>
              }
            />
          ))}
        </Panel>
      </SettingsSection>
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
    </SettingsPage>
  );
}

export { memberName };
