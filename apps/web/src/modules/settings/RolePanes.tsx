// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsParams } from "./params.js";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { PERM, namesOf, type Member, type PermissionName, type Role } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Avatar } from "../../ui/Avatar.js";
import { Button } from "../../ui/Button.js";
import { selectClass } from "../../ui/Controls.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import {
  DetailHeader,
  EmptyDetail,
  FooterNote,
  MasterDetail,
  Panel,
  PanelNote,
  Row,
  SaveBar,
  SettingsPage,
  SubHeading,
  SwitchRow,
  listItemClass,
} from "./layout.js";
import { SERVER_PERMISSIONS, TEXT_PERMISSIONS, VOICE_PERMISSIONS, toBig, toStr } from "./permissions.js";

const PALETTE = ["#3ba55d", "#e5a23d", "#5865f2", "#eb459e", "#ed4245", "#2ea4b8", "#8b6cef", "#8a93a2"];

/** A role's colour as a small square; hollow when it has none (style guide §3: role colours never colour text). */
function RoleDot({ color, size = "size-2.5" }: { color: string | null; size?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`${size} shrink-0 rounded-sm border border-border-control`}
      style={color ? { background: color, borderColor: color } : undefined}
    />
  );
}

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
    <Panel key={title} label={t(title)}>
      <div className="meta px-5 pt-3 pb-1 text-text-muted">{t(title)}</div>
      {names.map((n) => {
        const on = (value & PERM[n]) !== 0n;
        const can = disabled ? false : on || (holdable & PERM[n]) !== 0n;
        return (
          <SwitchRow
            key={n}
            label={t(`perm.${n}` as MessageKey)}
            description={t(`perm.${n}.hint` as MessageKey)}
            checked={on}
            disabled={!can}
            onChange={(next) => onChange(next ? value | PERM[n] : value & ~PERM[n])}
          />
        );
      })}
    </Panel>
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
  const { id } = useSettingsParams();
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
    <SettingsPage
      wide
      title={t("settings.roles")}
      description={t("settings.roles.description")}
      actions={
        canManage ? (
          <Button onClick={() => void create()}>
            <Plus aria-hidden="true" size={16} />
            {t("roles.create")}
          </Button>
        ) : null
      }
    >
      <MasterDetail
        list={
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={t("settings.roles")}>
            {ordered.map((r) => (
              <li key={r.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void navigate(`/settings/roles/${r.id}`)}
                  aria-current={selected?.id === r.id ? "true" : undefined}
                  className={listItemClass(selected?.id === r.id)}
                >
                  <RoleDot color={r.color} />
                  <bdi className="truncate">{r.name}</bdi>
                </button>
                {canManage && !r.isDefault ? (
                  <span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label={t("roles.moveUp", { name: r.name })}
                      className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
                      onClick={() => void move(r, 1)}
                    >
                      <ArrowUp aria-hidden="true" size={14} />
                    </button>
                    <button
                      type="button"
                      aria-label={t("roles.moveDown", { name: r.name })}
                      className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
                      onClick={() => void move(r, -1)}
                    >
                      <ArrowDown aria-hidden="true" size={14} />
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        }
      >
        {selected ? (
          <RoleEditor key={selected.id} role={selected} canManage={canManage} holdable={myPerms} />
        ) : (
          <EmptyDetail>{t("roles.pick")}</EmptyDetail>
        )}
      </MasterDetail>
    </SettingsPage>
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
  const reset = () => {
    setName(role.name);
    setColor(role.color ?? "");
    setHoist(role.hoist);
    setPerms(toBig(role.permissions));
  };

  return (
    <>
      <DetailHeader
        icon={<RoleDot color={color || null} size="size-11" />}
        title={<bdi>{name || role.name}</bdi>}
        subtitle={role.isDefault ? t("roles.everyone.note") : undefined}
        actions={
          canManage && !role.isDefault ? (
            <Button variant="ghost" className="text-danger-text" onClick={() => setConfirm(true)}>
              <Trash2 aria-hidden="true" size={14} />
              {t("roles.delete")}
            </Button>
          ) : null
        }
      />
      {!role.isDefault ? (
        <div className="flex flex-col gap-4">
          <SubHeading title={t("roles.display")} description={t("roles.display.description")} />
          <Panel label={t("roles.display")}>
            <Field
              layout="row"
              label={t("roles.name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              disabled={readOnly}
            />
            <Row
              label={t("roles.color")}
              description={t("roles.color.note")}
              control={
                <div
                  role="group"
                  aria-label={t("roles.color")}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      aria-pressed={color.toLowerCase() === c}
                      disabled={readOnly}
                      onClick={() => setColor(c)}
                      style={{ background: c }}
                      className={`size-6 rounded-sm outline-offset-2 ${color.toLowerCase() === c ? "outline-2 outline-text" : ""}`}
                    />
                  ))}
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-pressed={color === ""}
                    onClick={() => setColor("")}
                    className={`meta ms-1 rounded-md border px-2 py-1 ${color === "" ? "border-text text-text" : "border-border text-text-muted hover:text-text"}`}
                  >
                    {t("roles.color.none")}
                  </button>
                </div>
              }
            />
            <SwitchRow label={t("roles.hoist")} checked={hoist} disabled={readOnly} onChange={setHoist} />
          </Panel>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        <SubHeading title={t("roles.permissions")} description={t("roles.permissions.description")} />
        <PermissionToggles value={perms} onChange={setPerms} disabled={readOnly} holdable={holdable} />
      </div>
      {canManage && dirty ? (
        <SaveBar>
          <FooterNote>{t("settings.unsaved")}</FooterNote>
          <Button variant="ghost" onClick={reset}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common.save")}</Button>
        </SaveBar>
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
    </>
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
    <Panel label={t("members.preview")}>
      <Row
        label={t("members.preview.in")}
        htmlFor="preview-channel"
        control={
          <select
            id="preview-channel"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className={`${selectClass} w-56`}
          >
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.type === "voice" ? "🔊 " : "# "}
                {c.name}
              </option>
            ))}
          </select>
        }
      />
      {result ? (
        <>
          <ol className="m-0 flex list-none flex-col gap-2 px-5 py-4">
            {result.steps.map((s, i) => {
              const gained = namesOf(toBig(s.after) & ~toBig(s.before));
              const lost = namesOf(toBig(s.before) & ~toBig(s.after));
              return (
                <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 text-sm">
                  <span className="meta pt-0.5 text-text-muted">{i + 1}</span>
                  <span>{s.step}</span>
                  {gained.length ? (
                    <span className="meta col-start-2 text-success-text">+ {gained.join(", ")}</span>
                  ) : null}
                  {lost.length ? (
                    <span className="meta col-start-2 text-danger-text">− {lost.join(", ")}</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <div className="flex flex-col gap-1.5 px-5 py-4">
            <span className="text-sm font-medium">{t("members.preview.can")}</span>
            {allowed.length ? (
              <span className="flex flex-wrap gap-1.5">
                {allowed.map((p) => (
                  <span key={p} className="meta rounded-sm border border-border px-1.5 py-0.5 text-text">
                    {p}
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-sm text-text-muted">{t("members.preview.nothing")}</span>
            )}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

export function MembersPane() {
  const t = useT();
  const members = useCommunity((s) => s.members);
  const roles = useCommunity((s) => s.roles).filter((r) => !r.isDefault);
  const canRoles = useCan("MANAGE_ROLES");
  const canReset = useCan("MANAGE_INSTANCE");
  const { id } = useSettingsParams();
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
    <SettingsPage wide title={t("settings.members")} description={t("settings.members.description")}>
      <MasterDetail
        list={
          <>
            <Field
              label={t("members.filter")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              type="search"
            />
            <ul className="m-0 flex max-h-[60dvh] list-none flex-col gap-0.5 overflow-y-auto p-0">
              {list.map((m) => (
                <li key={m.userId}>
                  <button
                    type="button"
                    aria-current={selected?.userId === m.userId ? "true" : undefined}
                    onClick={() => void navigate(`/settings/members/${m.userId}`)}
                    className={listItemClass(selected?.userId === m.userId)}
                  >
                    <Avatar name={memberName(m)} avatarKey={m.avatarKey} size={24} />
                    <bdi className="min-w-0 flex-1 truncate">{memberName(m)}</bdi>
                    {m.isOwner ? <span className="tag">{t("member.owner")}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        }
      >
        {selected ? (
          <>
            <DetailHeader
              icon={<Avatar name={memberName(selected)} avatarKey={selected.avatarKey} size={48} />}
              title={<bdi>{selected.displayName}</bdi>}
              subtitle={
                <span className="flex flex-wrap items-center gap-2">
                  @{selected.username}
                  {selected.isOwner ? <span className="tag">{t("member.owner")}</span> : null}
                </span>
              }
            />
            <div className="flex flex-col gap-4">
              <SubHeading title={t("member.roles")} description={t("members.roles.description")} />
              <Panel label={t("member.roles")}>
                {roles.length === 0 ? <PanelNote>{t("members.noRoles")}</PanelNote> : null}
                {[...roles]
                  .sort((a, b) => b.position - a.position)
                  .map((r) => (
                    <SwitchRow
                      key={r.id}
                      label={
                        <span className="flex items-center gap-2">
                          <RoleDot color={r.color} />
                          {r.name}
                        </span>
                      }
                      checked={selected.roleIds.includes(r.id)}
                      disabled={!canRoles || selected.isOwner}
                      onChange={(on) => void toggle(selected, r.id, on)}
                    />
                  ))}
              </Panel>
            </div>
            {canReset ? (
              <div className="flex flex-col gap-4">
                <Panel label={t("members.reset.title")}>
                  <Row
                    label={t("members.reset.title")}
                    description={t("members.reset.description")}
                    control={
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
                    }
                  />
                  {code?.userId === selected.userId ? (
                    <div className="flex flex-col gap-1 bg-bg-sidebar px-5 py-4" role="status">
                      <p className="text-sm">{t("members.reset.shown")}</p>
                      <p className="font-mono text-2xl tracking-wider select-all">{code.code}</p>
                      <p className="meta text-text-muted">
                        {t("members.reset.expires", { time: new Date(code.expiresAt).toLocaleTimeString() })}
                      </p>
                    </div>
                  ) : null}
                </Panel>
              </div>
            ) : null}
            {canRoles ? (
              <div className="flex flex-col gap-4">
                <SubHeading title={t("members.preview")} description={t("members.preview.description")} />
                <Preview member={selected} />
              </div>
            ) : null}
          </>
        ) : (
          <EmptyDetail>{t("members.pick")}</EmptyDetail>
        )}
      </MasterDetail>
    </SettingsPage>
  );
}
