// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { Navigate, NavLink, useNavigate } from "react-router-dom";
import { useSettingsParams } from "./params.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { useCan, useCommunity } from "../../core/state/community.js";
import { ChannelsPane, InvitesPane, ServerPane } from "./ChannelPanes.js";
import { MembersPane, RolesPane } from "./RolePanes.js";
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
  const invitesOn = useSession((s) => !!s.capabilities?.features.invites);
  const owner = useSession((s) => s.user?.isInstanceOwner ?? false);
  const canChannels = useCan("MANAGE_CHANNELS");
  const canRoles = useCan("MANAGE_ROLES");
  const canInvites = useCan("CREATE_INVITE");
  const canInstance = useCan("MANAGE_INSTANCE");
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
    ["storage", "settings.storage", uploads],
  ];
  const admin: [string, MessageKey, boolean][] = [
    ["server", "settings.server", owner || canInstance],
    ["channels", "settings.channels", canChannels],
    ["roles", "settings.roles", canRoles],
    ["members", "settings.members", canRoles || canInstance],
    ["invites", "settings.invites", invitesOn && canInvites],
  ];
  const allowed = [...user, ...admin].filter(([, , show]) => show).map(([k]) => k);
  if (ready && !allowed.includes(section)) return <Navigate to="/settings/account" replace />;

  const link = (key: string, label: MessageKey) => (
    <li key={key}>
      <NavLink
        to={`/settings/${key}`}
        className={({ isActive }) =>
          `block rounded-md px-3 py-1.5 text-text no-underline hover:bg-bg-hover ${isActive ? "bg-bg-selected font-medium" : ""}`
        }
      >
        {t(label)}
      </NavLink>
    </li>
  );

  const pane = {
    account: <AccountPane />,
    appearance: <AppearancePane />,
    notifications: <NotificationsPane />,
    storage: <StoragePane />,
    server: <ServerPane />,
    channels: <ChannelsPane />,
    roles: <RolesPane />,
    members: <MembersPane />,
    invites: <InvitesPane />,
  }[section];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg text-text md:flex-row">
      <nav
        aria-label={t("settings.nav")}
        className="flex shrink-0 flex-col gap-4 overflow-y-auto border-b border-border bg-bg-sidebar p-4 md:w-64 md:border-e md:border-b-0"
      >
        <button
          type="button"
          onClick={() => void navigate("/")}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-bg-hover"
        >
          <ArrowLeft aria-hidden="true" size={16} />
          {t("settings.back")}
        </button>
        <ul className="m-0 list-none p-0">
          <li className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t("settings.group.user")}
          </li>
          {user.filter(([, , show]) => show).map(([k, l]) => link(k, l))}
        </ul>
        {admin.some(([, , show]) => show) ? (
          <ul className="m-0 list-none p-0">
            <li className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t("settings.group.admin")}
            </li>
            {admin.filter(([, , show]) => show).map(([k, l]) => link(k, l))}
          </ul>
        ) : null}
      </nav>
      <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto p-6">
        {pane ?? <Navigate to="/settings/account" replace />}
      </main>
    </div>
  );
}
