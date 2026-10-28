// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, LogOut, Menu as MenuIcon, Users, X } from "lucide-react";
import { ACCENT_NAMES } from "../theme/tokens.js";
import { useAppearance, type ThemePreference } from "../theme/store.js";
import { PSEUDO_LOCALES, useLocale, useT, type Locale, type MessageKey } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";

/**
 * The empty layout (W-01, 12 §4): channel list with the instance menu and user panel, a main column
 * with header and empty state, and a member list. No instance rail on the web (design U5). Channels,
 * messages and members fill these regions in M2; the shell only renders what modules contribute.
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

function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-text-on-accent"
    >
      <bdi>{[...name][0]?.toUpperCase() ?? "?"}</bdi>
    </span>
  );
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

export function AppLayout() {
  const t = useT();
  useRegionCycle();
  const user = useSession((s) => s.user)!;
  const caps = useSession((s) => s.capabilities);
  const logout = useSession((s) => s.logout);
  const wide = useMediaQuery("(min-width: 1280px)");
  const medium = useMediaQuery("(min-width: 768px)");
  const [drawer, setDrawer] = useState(false);
  const [members, setMembers] = useState<boolean | null>(null);
  const instanceName = caps?.server.name ?? "Tin Can";
  const showMembers = members ?? wide;
  const sidebarVisible = medium || drawer;
  const drawerButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (medium) setDrawer(false);
  }, [medium]);

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

          <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-sm font-medium">{t("layout.sidebar.empty")}</p>
            <p className="text-sm text-text-muted">{t("layout.sidebar.emptyHint")}</p>
          </div>

          <div
            className="flex h-13 items-center gap-2 border-t border-border px-3"
            aria-label={t("user.panel")}
            role="group"
          >
            <Avatar name={user.displayName} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">
                <bdi>{user.displayName}</bdi>
              </div>
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <span aria-hidden="true" className="inline-block size-2 rounded-full bg-presence-online" />
                {t("user.status.online")}
              </div>
            </div>
            <Menu.Root>
              <Menu.Trigger aria-label={t("user.menu")} className="rounded-md p-1.5 hover:bg-bg-hover">
                <ChevronDown aria-hidden="true" size={16} />
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content align="end" side="top" sideOffset={4} className={menuContent}>
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
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          {!medium ? (
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
          ) : null}
          <h1 className="flex-1 truncate text-lg">{t("layout.header.welcome")}</h1>
          <ConnectionStatus />
          <button
            type="button"
            aria-label={t("layout.members.toggle")}
            aria-pressed={showMembers}
            onClick={() => setMembers(!showMembers)}
            className={`rounded-md p-1.5 hover:bg-bg-hover ${showMembers ? "bg-bg-selected" : ""}`}
          >
            <Users aria-hidden="true" size={20} />
          </button>
        </header>

        <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center overflow-auto p-6">
          <div className="flex max-w-prose flex-col items-center gap-2 text-center">
            <h2 className="text-2xl">{t("layout.empty.title", { name: instanceName })}</h2>
            <p className="text-base text-text-muted">{t("layout.empty.body")}</p>
          </div>
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
          <p className="px-4 py-3 text-sm text-text-muted">{t("layout.members.count", { count: 1 })}</p>
          <div className="flex items-center gap-2 px-4">
            <Avatar name={user.displayName} />
            <span className="truncate text-sm">
              <bdi>{user.displayName}</bdi>
            </span>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
