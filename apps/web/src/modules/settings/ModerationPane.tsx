// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, Ban } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { selectClass } from "../../ui/Controls.js";
import { toast, toastError } from "../../ui/toast.js";
import { Panel, PanelNote, Row, SettingsPage, SettingsSection } from "./layout.js";

const FILTERS = [
  ["", "audit.filter.all"],
  ["member.", "audit.filter.member"],
  ["voice.", "audit.filter.voice"],
  ["role.", "audit.filter.role"],
] as const;

/** Audit log (VIEW_AUDIT_LOG) and the list of banned people (BAN_MEMBERS) (11 §3, W-48). */
export function ModerationPane() {
  const t = useT();
  const canAudit = useCan("VIEW_AUDIT_LOG");
  const canBans = useCan("BAN_MEMBERS");
  return (
    <SettingsPage title={t("settings.moderation")} description={t("settings.moderation.description")}>
      {canBans ? <BansCard /> : null}
      {canAudit ? <AuditCard /> : null}
    </SettingsPage>
  );
}

function useNameOf() {
  const members = useCommunity((s) => s.members);
  return (id: string | null | undefined, fallback?: unknown) =>
    id && members[id] ? memberName(members[id]) : typeof fallback === "string" ? fallback : "?";
}

function AuditCard() {
  const t = useT();
  const nameOf = useNameOf();
  const [filter, setFilter] = useState<string>("");
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    (before?: string) =>
      api
        .auditLog({ ...(before ? { before } : {}), ...(filter ? { action: filter } : {}) })
        .then((page) => {
          setItems((cur) => (before ? [...cur, ...page.items] : page.items));
          setNext(page.next);
          setLoaded(true);
        })
        .catch(toastError),
    [filter],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const sentence = (e: AuditEntry): string => {
    const key = `audit.action.${e.action}` as MessageKey;
    const actor = nameOf(e.actorId);
    const target = nameOf(e.targetId, e.data.username);
    try {
      return t(key, { actor, target });
    } catch {
      return t("audit.unknown", { actor, action: e.action });
    }
  };

  return (
    <SettingsSection
      title={t("audit.title")}
      description={t("audit.description")}
      aside={
        <label className="flex flex-col gap-1">
          <span className="meta text-text-muted">{t("audit.filter")}</span>
          <select className={selectClass} value={filter} onChange={(e) => setFilter(e.target.value)}>
            {FILTERS.map(([v, label]) => (
              <option key={v} value={v}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <Panel
        label={t("audit.title")}
        footer={
          next ? (
            <Button variant="ghost" onClick={() => void load(next)}>
              {t("audit.more")}
            </Button>
          ) : undefined
        }
      >
        {loaded && items.length === 0 ? <PanelNote>{t("audit.empty")}</PanelNote> : null}
        {items.length > 0 ? (
          <ol className="m-0 flex list-none flex-col divide-y divide-border p-0">
            {items.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-5 py-3">
                <span className="text-sm">{sentence(e)}</span>
                <span className="meta flex flex-wrap gap-x-3 text-text-muted">
                  <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
                  {e.reason ? <span>{t("audit.reason", { reason: e.reason })}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </Panel>
    </SettingsSection>
  );
}

function BansCard() {
  const t = useT();
  const [bans, setBans] = useState<Ban[] | null>(null);
  const refresh = useCallback(() => void api.bans().then(setBans).catch(toastError), []);
  useEffect(refresh, [refresh]);
  return (
    <SettingsSection title={t("bans.title")} description={t("bans.description")}>
      <Panel label={t("bans.title")}>
        {bans && bans.length === 0 ? <PanelNote>{t("bans.empty")}</PanelNote> : null}
        {(bans ?? []).map((b) => (
          <Row
            key={b.userId}
            label={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <bdi className="truncate">{b.displayName}</bdi>
                <span className="meta text-text-muted">@{b.username}</span>
              </span>
            }
            description={
              <span className="meta flex flex-wrap gap-x-3">
                <span>{t("bans.since", { date: new Date(b.bannedAt).toLocaleDateString() })}</span>
                {b.reason ? <span>{b.reason}</span> : null}
              </span>
            }
            control={
              <Button
                variant="ghost"
                onClick={() =>
                  void api
                    .unban(b.userId)
                    .then(() => {
                      toast(t("mod.done"));
                      refresh();
                    })
                    .catch(toastError)
                }
              >
                {t("bans.unban")}
              </Button>
            }
          />
        ))}
      </Panel>
    </SettingsSection>
  );
}
