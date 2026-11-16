// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ArrowLeft,
  Bell,
  Gavel,
  Hash,
  HardDrive,
  Link2,
  Mic,
  Palette,
  Server,
  Shield,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect } from "react";
import { Navigate, NavLink, useNavigate } from "react-router-dom";
import { useSettingsParams } from "./params.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { useCan, useCommunity } from "../../core/state/community.js";
import { ChannelsPane, InvitesPane, ServerPane } from "./ChannelPanes.js";
import { ModerationPane } from "./ModerationPane.js";
import { MembersPane, RolesPane } from "./RolePanes.js";
import { VoicePane } from "./VoicePane.js";
import { AccountPane, AppearancePane, NotificationsPane, StoragePane } from "./UserPanes.js";

/**
 * Settings as a full-screen layer (design U9, W-20). The chat keeps running underneath; admin panes
 * appear only for those whose permissions allow them (the server decides again on every call).
 */
export function SettingsLayer() {
  const t = useT();
  const navigate = useNavigate();
  const { section } = useSettingsParams();
  const uploads = useSession((s) => !!s.capabilities?.features.uploads);
  const voiceOn = useSession((s) => !!s.capabilities?.features.voice);
  const invitesOn = useSession((s) => !!s.capabilities?.features.invites);
  const moderationOn = useSession((s) => !!s.capabilities?.features.moderation);
  const owner = useSession((s) => s.user?.isInstanceOwner ?? false);
  const canChannels = useCan("MANAGE_CHANNELS");
  const canRoles = useCan("MANAGE_ROLES");
  const canInvites = useCan("CREATE_INVITE");
  const canInstance = useCan("MANAGE_INSTANCE");
  const canAudit = useCan("VIEW_AUDIT_LOG");
  const canBans = useCan("BAN_MEMBERS");
  const ready = useCommunity((s) => s.ready);

  // Esc closes the layer back to the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) void navigate("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const user: [string, MessageKey, boolean][] = [
    ["account", "settings.account", true],
    ["appearance", "settings.appearance", true],
    ["notifications", "settings.notifications", true],
    ["voice", "settings.voice", voiceOn],
    ["storage", "settings.storage", uploads],
  ];
  const admin: [string, MessageKey, boolean][] = [
    ["server", "settings.server", owner || canInstance],
    ["channels", "settings.channels", canChannels],
    ["roles", "settings.roles", canRoles],
    ["members", "settings.members", canRoles || canInstance],
    ["invites", "settings.invites", invitesOn && canInvites],
    ["moderation", "settings.moderation", moderationOn && (canAudit || canBans)],
  ];
  const allowed = [...user, ...admin].filter(([, , show]) => show).map(([k]) => k);
  if (ready && !allowed.includes(section)) return <Navigate to="/settings/account" replace />;

  const link = (key: string, label: MessageKey) => {
    const Icon = ICONS[key] ?? Hash;
    return (
      <li key={key} className="shrink-0">
        <NavLink
          to={`/settings/${key}`}
          className={({ isActive }) =>
            `relative flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm whitespace-nowrap no-underline hover:bg-bg-hover hover:text-text ${isActive ? "bg-bg-selected font-medium text-text before:absolute before:start-0 before:bg-accent max-md:before:inset-x-2 max-md:before:bottom-0 max-md:before:h-0.5 md:before:inset-y-1.5 md:before:w-0.5" : "text-text-muted"}`
          }
        >
          <Icon aria-hidden="true" size={16} strokeWidth={1.75} className="shrink-0" />
          {t(label)}
        </NavLink>
      </li>
    );
  };

  const pane = {
    account: <AccountPane />,
    appearance: <AppearancePane />,
    notifications: <NotificationsPane />,
    voice: <VoicePane />,
    storage: <StoragePane />,
    server: <ServerPane />,
    channels: <ChannelsPane />,
    roles: <RolesPane />,
    members: <MembersPane />,
    invites: <InvitesPane />,
    moderation: <ModerationPane />,
  }[section];

  const group = (title: MessageKey, items: [string, MessageKey, boolean][]) =>
    items.some(([, , show]) => show) ? (
      <div className="flex shrink-0 items-center gap-1 md:flex-col md:items-stretch md:gap-0.5">
        <h3 className="meta px-3 pb-1.5 text-text-muted max-md:sr-only">{t(title)}</h3>
        <ul className="m-0 flex list-none gap-1 p-0 md:flex-col md:gap-0.5">
          {items.filter(([, , show]) => show).map(([k, l]) => link(k, l))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg text-text md:flex-row">
      <nav
        aria-label={t("settings.nav")}
        className="flex shrink-0 flex-col border-b border-border bg-bg-sidebar md:w-64 md:border-e md:border-b-0"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:h-auto md:flex-col md:items-stretch md:gap-3 md:px-4 md:pt-5 md:pb-5">
          <button
            type="button"
            onClick={() => void navigate("/")}
            className="meta flex items-center gap-2 rounded-md px-2 py-1.5 text-start text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <ArrowLeft aria-hidden="true" size={14} className="rtl:-scale-x-100" />
            {t("settings.back")}
          </button>
          <p className="truncate px-2 font-display text-xl font-bold tracking-tight max-md:hidden">
            {t("settings.nav")}
          </p>
        </div>
        <div className="flex gap-4 overflow-x-auto px-2 py-2 md:flex-col md:gap-6 md:overflow-y-auto md:px-3 md:py-5">
          {group("settings.group.user", user)}
          {group("settings.group.admin", admin)}
        </div>
      </nav>
      <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-5 py-8 md:px-12 md:py-12">
        {pane ?? <Navigate to="/settings/account" replace />}
      </main>
    </div>
  );
}

/** One icon per page, so the list scans by shape as well as by word. */
const ICONS: Record<string, LucideIcon> = {
  account: UserRound,
  appearance: Palette,
  notifications: Bell,
  voice: Mic,
  storage: HardDrive,
  server: Server,
  channels: Hash,
  roles: Shield,
  members: Users,
  invites: Link2,
  moderation: Gavel,
};
