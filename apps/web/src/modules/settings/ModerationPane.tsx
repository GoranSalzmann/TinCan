// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, Ban } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { toast, toastError } from "../../ui/toast.js";

const card = "flex max-w-3xl flex-col gap-3 rounded-lg border border-border p-4";
const FILTERS = [
  ["", "audit.filter.all"],
  ["member.", "audit.filter.member"],
  ["voice.", "audit.filter.voice"],
  ["role.", "audit.filter.role"],
] as const;

/** Audit log (VIEW_AUDIT_LOG) and the list of banned people (BAN_MEMBERS) (11 §3, W-48). */
export function ModerationPane() {
  const canAudit = useCan("VIEW_AUDIT_LOG");
  const canBans = useCan("BAN_MEMBERS");
  return (
    <section className="flex flex-col gap-6">
      {canAudit ? <AuditCard /> : null}
      {canBans ? <BansCard /> : null}
    </section>
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
    <div className={card}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-lg">{t("audit.title")}</h3>
        <label className="flex items-center gap-2 text-sm">
          {t("audit.filter")}
          <select
            className="min-h-9 rounded-md border border-border-control bg-bg-input px-2 text-base text-text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            {FILTERS.map(([v, label]) => (
              <option key={v} value={v}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loaded && items.length === 0 ? <p className="m-0 text-text-muted">{t("audit.empty")}</p> : null}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((e) => (
          <li key={e.id} className="border-b border-border pb-2 last:border-b-0">
            <div className="text-sm">{sentence(e)}</div>
            <div className="text-xs text-text-muted">
              <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
              {e.reason ? ` · ${t("audit.reason", { reason: e.reason })}` : ""}
            </div>
          </li>
        ))}
      </ol>
      {next ? (
        <div>
          <Button variant="ghost" onClick={() => void load(next)}>
            {t("audit.more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BansCard() {
  const t = useT();
  const [bans, setBans] = useState<Ban[] | null>(null);
  const refresh = useCallback(() => void api.bans().then(setBans).catch(toastError), []);
  useEffect(refresh, [refresh]);
  return (
    <div className={card}>
      <h3 className="m-0 text-lg">{t("bans.title")}</h3>
      {bans && bans.length === 0 ? <p className="m-0 text-text-muted">{t("bans.empty")}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {(bans ?? []).map((b) => (
          <li key={b.userId} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate">
                <bdi>{b.displayName}</bdi> <span className="text-text-muted">@{b.username}</span>
              </div>
              <div className="text-xs text-text-muted">
                {t("bans.since", { date: new Date(b.bannedAt).toLocaleDateString() })}
                {b.reason ? ` · ${b.reason}` : ""}
              </div>
            </div>
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
          </li>
        ))}
      </ul>
    </div>
  );
}
