// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PERM, namesOf, type Member, type PermissionName, type Role } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Avatar } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import { SERVER_PERMISSIONS, TEXT_PERMISSIONS, VOICE_PERMISSIONS, toBig, toStr } from "./permissions.js";

const card = "flex flex-col gap-3 rounded-lg border border-border p-4";
const PALETTE = ["#3ba55d", "#e5a23d", "#5865f2", "#eb459e", "#ed4245", "#2ea4b8", "#8b6cef", "#8a93a2"];

function PermissionToggles({
  value,
  onChange,
  disabled,
  holdable,
}: {
  value: bigint;
  onChange: (next: bigint) => void;
  disabled: boolean;
  /** What the editor may switch on (their own permissions); the server enforces it too (11 §2.4). */
  holdable: bigint;
}) {
  const t = useT();
  const group = (title: MessageKey, names: PermissionName[]) => (
    <fieldset key={title} className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-semibold">{t(title)}</legend>
      {names.map((n) => {
        const on = (value & PERM[n]) !== 0n;
        const can = disabled ? false : on || (holdable & PERM[n]) !== 0n;
        return (
          <label
            key={n}
            className={`flex items-start gap-2 rounded-md px-1 py-0.5 ${can ? "" : "opacity-60"}`}
          >
            <input
              type="checkbox"
              role="switch"
              checked={on}
              disabled={!can}
              onChange={(e) => onChange(e.target.checked ? value | PERM[n] : value & ~PERM[n])}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">{t(`perm.${n}` as MessageKey)}</span>
              <span className="block text-xs text-text-muted">{t(`perm.${n}.hint` as MessageKey)}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
  return (
    <div className="flex flex-col gap-4">
      {group("perm.group.text", TEXT_PERMISSIONS)}
      {group("perm.group.voice", VOICE_PERMISSIONS)}
      {group("perm.group.server", SERVER_PERMISSIONS)}
    </div>
  );
}

// ---- Roles (W-40) ------------------------------------------------------------------------------------------------------

export function RolesPane() {
  const t = useT();
  const roles = useCommunity((s) => s.roles);
  const myPerms = useCommunity((s) => s.permissions);
  const canManage = useCan("MANAGE_ROLES");
  const { id } = useParams();
  const navigate = useNavigate();
  const selected = roles.find((r) => r.id === id) ?? null;
  const ordered = [...roles].sort((a, b) => b.position - a.position);

  const create = async () => {
    try {
      const r = await api.createRole({ name: t("roles.new") });
      void navigate(`/settings/roles/${r.id}`);
    } catch (e) {
      toastError(e);
    }
  };
  const move = async (r: Role, dir: -1 | 1) => {
    try {
      await api.patchRole(r.id, { position: r.position + dir });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl">{t("settings.roles")}</h2>
      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        <div className={card}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={t("settings.roles")}>
            {ordered.map((r) => (
              <li key={r.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void navigate(`/settings/roles/${r.id}`)}
                  aria-current={selected?.id === r.id ? "true" : undefined}
                  className={`flex min-h-8 flex-1 items-center gap-2 rounded-md px-2 text-start hover:bg-bg-hover ${selected?.id === r.id ? "bg-bg-selected" : ""}`}
                >
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 rounded-full border border-border-control"
                    style={r.color ? { background: r.color } : undefined}
                  />
                  <bdi className="truncate">{r.name}</bdi>
                </button>
                {canManage && !r.isDefault ? (
                  <>
                    <button
                      type="button"
                      aria-label={t("roles.moveUp", { name: r.name })}
                      className="rounded-md p-1 hover:bg-bg-hover"
                      onClick={() => void move(r, 1)}
                    >
                      <ArrowUp aria-hidden="true" size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("roles.moveDown", { name: r.name })}
                      className="rounded-md p-1 hover:bg-bg-hover"
                      onClick={() => void move(r, -1)}
                    >
                      <ArrowDown aria-hidden="true" size={14} />
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {canManage ? <Button onClick={() => void create()}>{t("roles.create")}</Button> : null}
        </div>
        {selected ? (
          <RoleEditor key={selected.id} role={selected} canManage={canManage} holdable={myPerms} />
        ) : (
          <p className="text-text-muted">{t("roles.pick")}</p>
        )}
      </div>
    </section>
  );
}

function RoleEditor({ role, canManage, holdable }: { role: Role; canManage: boolean; holdable: bigint }) {
  const t = useT();
  const navigate = useNavigate();
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? "");
  const [hoist, setHoist] = useState(role.hoist);
  const [perms, setPerms] = useState(toBig(role.permissions));
  const [confirm, setConfirm] = useState(false);
  const dirty =
    name !== role.name ||
    (color || null) !== role.color ||
    hoist !== role.hoist ||
    toStr(perms) !== role.permissions;
  const readOnly = !canManage;

  const save = async () => {
    try {
      await api.patchRole(role.id, {
        ...(role.isDefault ? {} : { name, color: color || null, hoist }),
        permissions: toStr(perms),
      });
      toast(t("settings.saved"));
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className={card}>
      {role.isDefault ? <p className="text-sm text-text-muted">{t("roles.everyone.note")}</p> : null}
      {!role.isDefault ? (
        <>
          <Field
            label={t("roles.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            disabled={readOnly}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{t("roles.color")}</legend>
            <div className="flex flex-wrap items-center gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={color.toLowerCase() === c}
                  disabled={readOnly}
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={`size-6 rounded-full border-2 ${color.toLowerCase() === c ? "border-text" : "border-transparent"}`}
                />
              ))}
              <button
                type="button"
                disabled={readOnly}
                onClick={() => setColor("")}
                className="rounded-md px-2 text-sm underline"
              >
                {t("roles.color.none")}
              </button>
            </div>
            <p className="text-xs text-text-muted">{t("roles.color.note")}</p>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={hoist}
              disabled={readOnly}
              onChange={(e) => setHoist(e.target.checked)}
            />
            {t("roles.hoist")}
          </label>
        </>
      ) : null}
      <PermissionToggles value={perms} onChange={setPerms} disabled={readOnly} holdable={holdable} />
      {canManage ? (
        <div className="flex justify-between gap-2">
          {!role.isDefault ? (
            <Button variant="ghost" className="text-danger-text" onClick={() => setConfirm(true)}>
              {t("roles.delete")}
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={!dirty} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("roles.delete.title", { name: role.name })}
        body={t("roles.delete.body")}
        confirmLabel={t("roles.delete")}
        onConfirm={async () => {
          try {
            await api.deleteRole(role.id);
            void navigate("/settings/roles");
          } catch (e) {
            toastError(e);
          }
        }}
      />
    </div>
  );
}

// ---- Members and "preview as member" (W-42) -------------------------------------------------------------------------

function Preview({ member }: { member: Member }) {
  const t = useT();
  const channels = useCommunity((s) => s.channels);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [result, setResult] = useState<{
    permissions: string;
    steps: { step: string; before: string; after: string }[];
  } | null>(null);
  useEffect(() => {
    if (!channelId) return;
    void api.explain(member.userId, channelId).then(setResult).catch(toastError);
  }, [member.userId, channelId]);
  const allowed = result ? namesOf(toBig(result.permissions)) : [];
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        {t("members.preview.in")}
        <select
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="rounded-md border border-border-control bg-bg-input px-2 py-1"
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.type === "voice" ? "🔊 " : "# "}
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {result ? (
        <>
          <ol className="m-0 ps-5 text-sm">
            {result.steps.map((s, i) => {
              const gained = namesOf(toBig(s.after) & ~toBig(s.before));
              const lost = namesOf(toBig(s.before) & ~toBig(s.after));
              return (
                <li key={i}>
                  {s.step}
                  {gained.length ? (
                    <span className="block text-xs text-success-text">+ {gained.join(", ")}</span>
                  ) : null}
                  {lost.length ? (
                    <span className="block text-xs text-danger-text">− {lost.join(", ")}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <p className="text-sm">
            <span className="font-medium">{t("members.preview.can")}</span>{" "}
            {allowed.length ? allowed.join(", ") : t("members.preview.nothing")}
          </p>
        </>
      ) : null}
    </div>
  );
}

export function MembersPane() {
  const t = useT();
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles).filter((r) => !r.isDefault);
  const canRoles = useCan("MANAGE_ROLES");
  const canReset = useCan("MANAGE_INSTANCE");
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [code, setCode] = useState<{ userId: string; code: string; expiresAt: string } | null>(null);
  const list = useMemo(
    () =>
      Object.values(members)
        .filter((m) => `${memberName(m)} ${m.username}`.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => memberName(a).localeCompare(memberName(b))),
    [members, filter],
  );
  const selected = id ? members[id] : undefined;

  const toggle = async (m: Member, roleId: string, on: boolean) => {
    try {
      if (on) await api.assignRole(m.userId, roleId);
      else await api.unassignRole(m.userId, roleId);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl">{t("settings.members")}</h2>
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <div className={card}>
          <Field
            label={t("members.filter")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            type="search"
          />
          <ul className="m-0 flex max-h-[60dvh] list-none flex-col gap-1 overflow-y-auto p-0">
            {list.map((m) => (
              <li key={m.userId}>
                <button
                  type="button"
                  aria-current={selected?.userId === m.userId ? "true" : undefined}
                  onClick={() => void navigate(`/settings/members/${m.userId}`)}
                  className={`flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-bg-hover ${selected?.userId === m.userId ? "bg-bg-selected" : ""}`}
                >
                  <Avatar name={memberName(m)} avatarKey={m.avatarKey} size={24} />
                  <bdi className="truncate">{memberName(m)}</bdi>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {selected ? (
          <div className={card}>
            <div className="flex items-center gap-3">
              <Avatar name={memberName(selected)} avatarKey={selected.avatarKey} size={48} />
              <div>
                <div className="text-lg font-semibold">
                  <bdi>{selected.displayName}</bdi>
                </div>
                <div className="text-sm text-text-muted">
                  @{selected.username}
                  {selected.isOwner ? ` · ${t("member.owner")}` : ""}
                </div>
              </div>
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-semibold">{t("member.roles")}</legend>
              {roles.length === 0 ? <p className="text-sm text-text-muted">{t("members.noRoles")}</p> : null}
              {[...roles]
                .sort((a, b) => b.position - a.position)
                .map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.roleIds.includes(r.id)}
                      disabled={!canRoles || selected.isOwner}
                      onChange={(e) => void toggle(selected, r.id, e.target.checked)}
                    />
                    <span
                      aria-hidden="true"
                      className="size-3 rounded-full border border-border-control"
                      style={r.color ? { background: r.color } : undefined}
                    />
                    {r.name}
                  </label>
                ))}
            </fieldset>
            {canReset ? (
              <div className="flex flex-col gap-2">
                <div>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void api
                        .resetToken(selected.userId)
                        .then((r) => setCode({ userId: selected.userId, ...r }))
                        .catch(toastError)
                    }
                  >
                    {t("members.reset")}
                  </Button>
                </div>
                {code?.userId === selected.userId ? (
                  <div className="rounded-md border border-border bg-bg-sidebar p-3" role="status">
                    <p className="text-sm">{t("members.reset.shown")}</p>
                    <p className="my-1 font-mono text-xl tracking-wider select-all">{code.code}</p>
                    <p className="text-xs text-text-muted">
                      {t("members.reset.expires", { time: new Date(code.expiresAt).toLocaleTimeString() })}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : null}
            {canRoles ? (
              <div>
                <h3 className="mb-1 text-sm font-semibold">{t("members.preview")}</h3>
                <Preview member={selected} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-text-muted">{t("members.pick")}</p>
        )}
      </div>
    </section>
  );
}
