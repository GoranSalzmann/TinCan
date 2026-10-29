// SPDX-License-Identifier: AGPL-3.0-or-later
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, LogOut, Menu as MenuIcon, Settings, Users, X } from "lucide-react";
import { ACCENT_NAMES } from "../theme/tokens.js";
import { useAppearance, type ThemePreference } from "../theme/store.js";
import { PSEUDO_LOCALES, useLocale, useT, type Locale, type MessageKey } from "../core/i18n/index.js";
import { notificationPermission, badgeCount, requestNotificationPermission } from "../core/notifications.js";
import { sendCommand, useSession } from "../core/session/store.js";
import { useChat } from "../core/state/chat.js";
import { memberName, useCan, useCommunity } from "../core/state/community.js";
import { useUi } from "../core/state/ui.js";
import { ChannelList } from "../modules/channels/ChannelList.js";
import { VoiceDock } from "../modules/voice/VoiceDock.js";
import { MemberList } from "../modules/members/MemberList.js";
// The settings panes are used rarely; they load when first opened.
const SettingsLayer = lazy(() =>
  import("../modules/settings/SettingsLayer.js").then((m) => ({ default: m.SettingsLayer })),
);
import { Avatar, PresenceDot } from "../ui/Avatar.js";
import { ToastHost } from "../ui/toast.js";

/**
 * The main layout (W-01, 12 §4): channel list with the instance menu and user panel, a main column that
 * the router fills (a channel, or settings as a full-screen layer), and the member list. No instance
 * rail on the web (design U5).
 */

const menuContent = "elev-2 z-60 min-w-56 p-1 text-sm text-text";
const menuItem =
  "flex cursor-default items-center gap-2 rounded-md px-3 py-1.5 outline-none data-[highlighted]:bg-bg-hover data-[disabled]:text-text-disabled";

const REGION_IDS = ["region-sidebar", "main", "region-members"] as const;

/** F6 / Shift+F6 move between landmarks (style guide §11). */
function useRegionCycle() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F6") return;
      e.preventDefault();
      const regions = REGION_IDS.map((id) => document.getElementById(id)).filter(
        (el): el is HTMLElement => el !== null,
      );
      if (regions.length === 0) return;
      const current = regions.findIndex((r) => r.contains(document.activeElement));
      const next = (current + (e.shiftKey ? -1 : 1) + regions.length) % regions.length;
      regions[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function AppearanceItems() {
  const t = useT();
  const { theme, accent, setTheme, setAccent } = useAppearance();
  const { locale, setLocale } = useLocale();
  return (
    <>
      <Menu.Label className="px-3 py-1 text-xs font-semibold text-text-muted">
        {t("appearance.title")}
      </Menu.Label>
      <Menu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePreference)}>
        {(["system", "light", "dark", "hc"] as const).map((v) => (
          <Menu.RadioItem key={v} value={v} className={menuItem}>
            <span className="inline-block w-4 text-center" aria-hidden="true">
              <Menu.ItemIndicator>•</Menu.ItemIndicator>
            </span>
            {t(`appearance.theme.${v}` as MessageKey)}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
      <Menu.Separator className="my-1 h-px bg-border" />
      <Menu.Label className="px-3 py-1 text-xs font-semibold text-text-muted">
        {t("appearance.accent")}
      </Menu.Label>
      <Menu.RadioGroup value={accent} onValueChange={(v) => setAccent(v as (typeof ACCENT_NAMES)[number])}>
        {ACCENT_NAMES.map((v) => (
          <Menu.RadioItem key={v} value={v} className={menuItem}>
            <span className="inline-block w-4 text-center" aria-hidden="true">
              <Menu.ItemIndicator>•</Menu.ItemIndicator>
            </span>
            {t(`accent.${v}` as MessageKey)}
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
      {PSEUDO_LOCALES.length > 0 ? (
        <>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Label className="px-3 py-1 text-xs font-semibold text-text-muted">Locale (dev)</Menu.Label>
          <Menu.RadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            {(["en", ...PSEUDO_LOCALES] as Locale[]).map((v) => (
              <Menu.RadioItem key={v} value={v} className={menuItem}>
                <span className="inline-block w-4 text-center" aria-hidden="true">
                  <Menu.ItemIndicator>•</Menu.ItemIndicator>
                </span>
                {v}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </>
      ) : null}
    </>
  );
}

function ConnectionStatus() {
  const t = useT();
  const gw = useSession((s) => s.gateway);
  const key: MessageKey =
    gw === "ready"
      ? "layout.connection.ready"
      : gw === "reconnecting"
        ? "layout.connection.reconnecting"
        : gw === "connecting"
          ? "layout.connection.connecting"
          : "layout.connection.offline";
  // Shape plus text, never colour alone: filled circle when connected, hollow ring otherwise.
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-text-muted">
      <span
        aria-hidden="true"
        className={`inline-block size-2.5 rounded-full border-2 ${gw === "ready" ? "border-presence-online bg-presence-online" : "border-presence-offline"}`}
      />
      {t(key)}
    </span>
  );
}

/** The browser tab shows unread and mentions, like the desktop badge will (12 §5.4). */
function useTabBadge(name: string) {
  const read = useChat((s) => s.read);
  const settings = useCommunity((s) => s.settings);
  useEffect(() => {
    const { mentions, unread } = badgeCount(read, settings, Date.now());
    document.title = mentions > 0 ? `(${mentions}) ${name}` : unread ? `• ${name}` : name;
  }, [read, settings, name]);
  useEffect(() => () => void (document.title = name), [name]);
}

/** Tells the stores when the window is looked at, and lets notifications open a channel. */
function useFocusAndNavigator() {
  const navigate = useNavigate();
  const setFocused = useUi((s) => s.setFocused);
  const setNavigator = useUi((s) => s.setNavigator);
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && document.visibilityState === "visible");
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [setFocused]);
  useEffect(() => {
    setNavigator((channelId, messageId) => {
      void navigate(`/channels/${channelId}`);
      if (messageId) void useChat.getState().jumpTo(channelId, messageId);
    });
    return () => setNavigator(null);
  }, [navigate, setNavigator]);
}

/** `/` goes to the channel you were last in, or the first text channel you can see. */
export function Landing() {
  const t = useT();
  const ready = useCommunity((s) => s.ready);
  const channels = useCommunity((s) => s.channels).filter((c) => c.type === "text");
  const canManage = useCan("MANAGE_CHANNELS");
  if (!ready)
    return (
      <div className="flex flex-1 items-center justify-center text-text-muted" role="status">
        {t("app.loading")}
      </div>
    );
  let last: string | null = null;
  try {
    last = localStorage.getItem("tincan.lastChannel");
  } catch {
    // no storage: fall back to the first channel
  }
  const target = channels.find((c) => c.id === last) ?? channels[0];
  if (target) return <Navigate to={`/channels/${target.id}`} replace />;
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center">
      <div className="flex max-w-prose flex-col gap-2">
        <h2 className="text-2xl">{t("channel.none.title")}</h2>
        <p className="text-text-muted">{canManage ? t("channel.none.admin") : t("channel.none.body")}</p>
      </div>
    </div>
  );
}

export function AppLayout() {
  const t = useT();
  useRegionCycle();
  useFocusAndNavigator();
  const navigate = useNavigate();
  const location = useLocation();
  const user = useSession((s) => s.user)!;
  const caps = useSession((s) => s.capabilities);
  const logout = useSession((s) => s.logout);
  const me = useCommunity((s) => s.members[user.id]);
  const presence = useCommunity((s) => s.presence[user.id] ?? "offline");
  const canManageChannels = useCan("MANAGE_CHANNELS");
  const canInvite = useCan("CREATE_INVITE");
  const invitesOn = !!caps?.features.invites;
  const inSettings = useMatch("/settings/*") !== null;
  const wide = useMediaQuery("(min-width: 1280px)");
  const medium = useMediaQuery("(min-width: 768px)");
  const [drawer, setDrawer] = useState(false);
  const [members, setMembers] = useState<boolean | null>(null);
  const [perm, setPerm] = useState(notificationPermission());
  const instanceName = caps?.server.name ?? "Tin Can";
  const showMembers = (members ?? wide) && !inSettings;
  const sidebarVisible = medium || drawer;
  const drawerButton = useRef<HTMLButtonElement>(null);
  useTabBadge(instanceName);

  useEffect(() => {
    if (medium) setDrawer(false);
  }, [medium]);
  // Choosing a channel closes the drawer; remember it for next time.
  useEffect(() => {
    setDrawer(false);
    const m = /^\/channels\/([^/]+)/.exec(location.pathname);
    if (m) {
      try {
        localStorage.setItem("tincan.lastChannel", m[1]!);
      } catch {
        // convenience only
      }
    }
  }, [location.pathname]);

  const chosen = presence === "offline" ? "online" : presence;

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-text">
      <a
        href="#main"
        className="absolute start-2 top-2 z-80 -translate-y-16 rounded-md bg-bg-elevated px-3 py-2 text-sm focus:translate-y-0"
      >
        {t("app.skip")}
      </a>

      {drawer && !medium ? (
        <button
          type="button"
          aria-label={t("layout.menu.close")}
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-40 bg-overlay"
        />
      ) : null}

      {sidebarVisible ? (
        <nav
          id="region-sidebar"
          tabIndex={-1}
          aria-label={t("layout.sidebar")}
          className={`flex w-60 shrink-0 flex-col bg-bg-sidebar ${medium ? "border-e border-border" : "elev-2 fixed inset-y-0 start-0 z-50 rounded-none"}`}
        >
          <Menu.Root>
            <Menu.Trigger
              aria-label={t("instance.menu")}
              className="flex h-12 items-center justify-between gap-2 border-b border-border px-4 text-start text-lg hover:bg-bg-hover"
            >
              <bdi className="truncate">{instanceName}</bdi>
              <ChevronDown aria-hidden="true" size={16} className="shrink-0" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="start" sideOffset={4} className={menuContent}>
                {invitesOn && canInvite ? (
                  <Menu.Item className={menuItem} onSelect={() => void navigate("/settings/invites")}>
                    {t("instance.invite")}
                  </Menu.Item>
                ) : null}
                {canManageChannels ? (
                  <Menu.Item className={menuItem} onSelect={() => void navigate("/settings/channels")}>
                    {t("settings.channels")}
                  </Menu.Item>
                ) : null}
                <Menu.Item className={menuItem} onSelect={() => void navigate("/settings/account")}>
                  {t("instance.settings")}
                </Menu.Item>
                {perm === "default" ? (
                  <Menu.Item
                    className={menuItem}
                    onSelect={() => void requestNotificationPermission().then(setPerm)}
                  >
                    {t("notifications.enable")}
                  </Menu.Item>
                ) : null}
                <Menu.Separator className="my-1 h-px bg-border" />
                <AppearanceItems />
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Item asChild className={menuItem}>
                  <a
                    href={caps?.server.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="no-underline"
                  >
                    {t("instance.source")}
                  </a>
                </Menu.Item>
                <Menu.Label className="px-3 py-1 text-xs text-text-muted">
                  {t("instance.version", { version: caps?.server.version ?? "" })}
                </Menu.Label>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>

          <ChannelList />

          <VoiceDock />

          <div
            className="flex h-13 items-center gap-2 border-t border-border px-3"
            aria-label={t("user.panel")}
            role="group"
          >
            <span className="relative">
              <Avatar
                name={memberName(me, user.displayName)}
                avatarKey={me?.avatarKey ?? user.avatarKey}
                size={32}
              />
              <PresenceDot status={presence} className="absolute -end-0.5 -bottom-0.5 bg-bg-sidebar" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">
                <bdi>{memberName(me, user.displayName)}</bdi>
              </div>
              <div className="truncate text-xs text-text-muted">{t(`user.status.${presence}`)}</div>
            </div>
            <button
              type="button"
              aria-label={t("instance.settings")}
              onClick={() => void navigate("/settings/account")}
              className="rounded-md p-1.5 hover:bg-bg-hover"
            >
              <Settings aria-hidden="true" size={16} />
            </button>
            <Menu.Root>
              <Menu.Trigger aria-label={t("user.menu")} className="rounded-md p-1.5 hover:bg-bg-hover">
                <ChevronDown aria-hidden="true" size={16} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content align="end" side="top" sideOffset={4} className={menuContent}>
                  <Menu.Label className="px-3 py-1 text-xs font-semibold text-text-muted">
                    {t("user.status")}
                  </Menu.Label>
                  <Menu.RadioGroup
                    value={presence === "offline" ? "invisible" : chosen}
                    onValueChange={(v) => sendCommand("presence.set", { status: v })}
                  >
                    {(["online", "idle", "dnd", "invisible"] as const).map((v) => (
                      <Menu.RadioItem key={v} value={v} className={menuItem}>
                        <span className="inline-block w-4 text-center" aria-hidden="true">
                          <Menu.ItemIndicator>•</Menu.ItemIndicator>
                        </span>
                        {t(`user.status.${v}`)}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                  <Menu.Separator className="my-1 h-px bg-border" />
                  <Menu.Item className={`${menuItem} text-danger-text`} onSelect={() => void logout()}>
                    <LogOut aria-hidden="true" size={16} />
                    {t("user.logout")}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </nav>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 md:hidden">
          <button
            ref={drawerButton}
            type="button"
            aria-label={drawer ? t("layout.menu.close") : t("layout.menu.open")}
            aria-expanded={drawer}
            onClick={() => setDrawer((d) => !d)}
            className="rounded-md p-1.5 hover:bg-bg-hover"
          >
            {drawer ? <X aria-hidden="true" size={20} /> : <MenuIcon aria-hidden="true" size={20} />}
          </button>
          <span className="flex-1 truncate">{instanceName}</span>
          <ConnectionStatus />
        </div>
        <div className="hidden h-0 md:block" />
        <main id="main" tabIndex={-1} className="relative flex min-h-0 flex-1 flex-col">
          <div className="absolute end-14 top-3 z-10 hidden md:block">
            <ConnectionStatus />
          </div>
          {!inSettings ? (
            <button
              type="button"
              aria-label={t("layout.members.toggle")}
              aria-pressed={showMembers}
              onClick={() => setMembers(!showMembers)}
              className={`absolute end-4 top-2 z-10 hidden rounded-md p-1.5 hover:bg-bg-hover md:block ${showMembers ? "bg-bg-selected" : ""}`}
            >
              <Users aria-hidden="true" size={20} />
            </button>
          ) : null}
          <Outlet />
        </main>
      </div>

      {showMembers ? (
        <aside
          id="region-members"
          tabIndex={-1}
          aria-label={t("layout.members")}
          className={`flex w-60 shrink-0 flex-col bg-bg-sidebar ${wide ? "border-s border-border" : "elev-2 fixed inset-y-0 end-0 z-50 rounded-none"}`}
        >
          <div className="flex h-12 items-center border-b border-border px-4 text-sm font-semibold">
            {t("layout.members")}
          </div>
          <MemberList />
        </aside>
      ) : null}
      {inSettings ? (
        <Suspense fallback={null}>
          <SettingsLayer />
        </Suspense>
      ) : null}
      <ToastHost />
    </div>
  );
}
