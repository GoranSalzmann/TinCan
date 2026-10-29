// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsParams } from "./params.js";
import { Hash, Volume2 } from "lucide-react";
import type { Channel, Invite, Overwrite } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import { CreateChannelDialog } from "../channels/CreateChannelDialog.js";
import {
  TEXT_PERMISSIONS,
  VOICE_PERMISSIONS,
  toBig,
  toStr,
  triOf,
  withTri,
  type Tri,
} from "./permissions.js";

const card = "flex flex-col gap-3 rounded-lg border border-border p-4";

// ---- Server ------------------------------------------------------------------------------------------------------------

export function ServerPane() {
  const t = useT();
  const caps = useSession((s) => s.capabilities);
  const setName = useSession((s) => s.setInstanceName);
  const owner = useSession((s) => s.user?.isInstanceOwner ?? false);
  const [name, setNameDraft] = useState(caps?.server.name ?? "");
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <h2 className="text-2xl">{t("settings.server")}</h2>
      <form
        className={card}
        onSubmit={(e) => {
          e.preventDefault();
          void api
            .renameInstance(name.trim())
            .then((r) => {
              setName(r.name);
              toast(t("settings.saved"));
            })
            .catch(toastError);
        }}
      >
        <Field
          label={t("setup.community.name")}
          value={name}
          onChange={(e) => setNameDraft(e.target.value)}
          maxLength={64}
          disabled={!owner}
        />
        {!owner ? <p className="text-sm text-text-muted">{t("settings.server.ownerOnly")}</p> : null}
        <div>
          <Button type="submit" disabled={!owner || !name.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
      {owner ? <VideoLimitsCard /> : null}
      {owner ? <UploadLimitsCard /> : null}
      <p className="text-sm text-text-muted">
        {t("settings.server.source")}:{" "}
        <a href={caps?.server.sourceUrl} target="_blank" rel="noreferrer noopener">
          {caps?.server.sourceUrl}
        </a>
      </p>
    </section>
  );
}

/** The server-wide camera and screen share bitrate caps; a channel can lower the share cap further (18 §L). */
function VideoLimitsCard() {
  const t = useT();
  const voiceOn = useSession((s) => Boolean(s.capabilities?.features.voice));
  const [camera, setCamera] = useState("");
  const [share, setShare] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!voiceOn) return;
    void api
      .videoLimits()
      .then((l) => {
        setCamera(String(+(l.cameraMaxKbps / 1000).toFixed(2)));
        setShare(String(+(l.screenshareMaxKbps / 1000).toFixed(2)));
        setLoaded(true);
      })
      .catch(toastError);
  }, [voiceOn]);
  if (!voiceOn) return null;

  const cameraKbps = Math.round(Number(camera) * 1000);
  const shareKbps = Math.round(Number(share) * 1000);
  const cameraError =
    camera === "" || !Number.isFinite(cameraKbps) || cameraKbps < 150 || cameraKbps > 25_000
      ? t("settings.video.range", { min: 0.15, max: 25 })
      : null;
  const shareError =
    share === "" || !Number.isFinite(shareKbps) || shareKbps < 300 || shareKbps > 60_000
      ? t("settings.video.range", { min: 0.3, max: 60 })
      : null;

  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        void api
          .setVideoLimits({ cameraMaxKbps: cameraKbps, screenshareMaxKbps: shareKbps })
          .then(() => toast(t("settings.saved")))
          .catch(toastError);
      }}
    >
      <h3 className="m-0 text-lg">{t("settings.video")}</h3>
      <Field
        label={t("settings.video.screenshare")}
        type="number"
        min={0.3}
        max={60}
        step="any"
        value={share}
        onChange={(e) => setShare(e.target.value)}
        error={shareError}
        hint={t("settings.video.screenshare.hint")}
      />
      <Field
        label={t("settings.video.camera")}
        type="number"
        min={0.15}
        max={25}
        step="any"
        value={camera}
        onChange={(e) => setCamera(e.target.value)}
        error={cameraError}
        hint={t("settings.video.camera.hint")}
      />
      <div>
        <Button type="submit" disabled={!loaded || cameraError !== null || shareError !== null}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The owner's file size and per-person upload limits; they apply to the next upload, no restart (18 §L). */
function UploadLimitsCard() {
  const t = useT();
  const apply = useSession((s) => s.setUploadLimits);
  const [ceiling, setCeiling] = useState<number | null>(null);
  const [maxMb, setMaxMb] = useState("");
  const [quotaGb, setQuotaGb] = useState("");

  useEffect(() => {
    void api
      .uploadLimits()
      .then((l) => {
        setCeiling(l.ceilingBytes);
        setMaxMb(String(+(l.maxBytes / MB).toFixed(2)));
        setQuotaGb(String(+(l.userQuotaBytes / GB).toFixed(2)));
      })
      .catch(toastError);
  }, []);

  const maxBytes = Math.round(Number(maxMb) * MB);
  const userQuotaBytes = Math.round(Number(quotaGb) * GB);
  const maxError =
    maxMb === "" || !Number.isFinite(maxBytes) || maxBytes < 1024
      ? t("settings.uploads.invalid")
      : ceiling !== null && maxBytes > ceiling
        ? t("settings.uploads.aboveCeiling", { max: Math.floor(ceiling / MB) })
        : null;
  const quotaError =
    quotaGb === "" || !Number.isFinite(userQuotaBytes) || userQuotaBytes < 0
      ? t("settings.uploads.invalid")
      : null;

  return (
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        void api
          .setUploadLimits({ maxBytes, userQuotaBytes })
          .then((l) => {
            apply({ maxBytes: l.maxBytes, userQuotaBytes: l.userQuotaBytes });
            toast(t("settings.saved"));
          })
          .catch(toastError);
      }}
    >
      <h3 className="m-0 text-lg">{t("settings.uploads")}</h3>
      <Field
        label={t("settings.uploads.maxFile")}
        type="number"
        min={0.001}
        step="any"
        value={maxMb}
        onChange={(e) => setMaxMb(e.target.value)}
        error={maxError}
        hint={t("settings.uploads.maxFile.hint")}
      />
      <Field
        label={t("settings.uploads.quota")}
        type="number"
        min={0}
        step="any"
        value={quotaGb}
        onChange={(e) => setQuotaGb(e.target.value)}
        error={quotaError}
        hint={t("settings.uploads.quota.hint")}
      />
      <div>
        <Button type="submit" disabled={maxError !== null || quotaError !== null || ceiling === null}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

// ---- Channels and their permissions (W-41) ------------------------------------------------------------------------------

function OverwriteEditor({ channel }: { channel: Channel }) {
  const t = useT();
  const roles = useCommunity((s) => s.roles);
  const members = useCommunity((s) => s.members);
  const [rows, setRows] = useState<Overwrite[] | null>(null);
  const [target, setTarget] = useState<{ type: "role" | "member"; id: string } | null>(null);
  const [add, setAdd] = useState("");

  const load = () => api.overwrites(channel.id).then(setRows).catch(toastError);
  useEffect(() => {
    setRows(null);
    setTarget(null);
    void load();
  }, [channel.id]);

  const nameOf = (o: { targetType: "role" | "member"; targetId: string }) =>
    o.targetType === "role"
      ? (roles.find((r) => r.id === o.targetId)?.name ?? "?")
      : memberName(members[o.targetId]);

  const current = target
    ? rows?.find((o) => o.targetType === target.type && o.targetId === target.id)
    : undefined;
  const allow = current ? toBig(current.allow) : 0n;
  const deny = current ? toBig(current.deny) : 0n;

  const set = async (a: bigint, d: bigint) => {
    if (!target) return;
    try {
      const saved = await api.putOverwrite(channel.id, target.type, target.id, toStr(a), toStr(d));
      setRows((cur) => [
        ...(cur ?? []).filter((o) => !(o.targetType === target.type && o.targetId === target.id)),
        saved,
      ]);
    } catch (e) {
      toastError(e);
    }
  };
  const remove = async (o: Overwrite) => {
    try {
      await api.deleteOverwrite(channel.id, o.targetType, o.targetId);
      setRows((cur) => (cur ?? []).filter((x) => x !== o));
      setTarget(null);
    } catch (e) {
      toastError(e);
    }
  };

  const names = channel.type === "text" ? TEXT_PERMISSIONS : VOICE_PERMISSIONS;
  const usedKeys = new Set((rows ?? []).map((o) => `${o.targetType}:${o.targetId}`));
  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <div className={card}>
        <h3 className="text-sm font-semibold">{t("channel.overwrites")}</h3>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {(rows ?? []).map((o) => (
            <li key={`${o.targetType}:${o.targetId}`}>
              <button
                type="button"
                aria-current={target?.type === o.targetType && target.id === o.targetId ? "true" : undefined}
                onClick={() => setTarget({ type: o.targetType, id: o.targetId })}
                className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-bg-hover ${target?.type === o.targetType && target.id === o.targetId ? "bg-bg-selected" : ""}`}
              >
                <span className="rounded-sm border border-border px-1 text-xs">
                  {t(`channel.overwrites.${o.targetType}`)}
                </span>
                <bdi className="truncate">{nameOf(o)}</bdi>
              </button>
            </li>
          ))}
        </ul>
        <label className="flex flex-col gap-1 text-sm">
          {t("channel.overwrites.add")}
          <select
            value={add}
            onChange={(e) => {
              const [type, id] = e.target.value.split(":") as ["role" | "member", string];
              setAdd("");
              if (type && id) setTarget({ type, id });
            }}
            className="rounded-md border border-border-control bg-bg-input px-2 py-1.5"
          >
            <option value="">{t("channel.overwrites.choose")}</option>
            <optgroup label={t("settings.roles")}>
              {roles
                .filter((r) => !usedKeys.has(`role:${r.id}`))
                .map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>
                    {r.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label={t("settings.members")}>
              {Object.values(members)
                .filter((m) => !usedKeys.has(`member:${m.userId}`))
                .map((m) => (
                  <option key={m.userId} value={`member:${m.userId}`}>
                    {memberName(m)}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
      </div>
      {target ? (
        <div className={card}>
          <h3 className="text-lg">
            {target.type === "role"
              ? (roles.find((r) => r.id === target.id)?.name ?? "")
              : memberName(members[target.id])}
          </h3>
          <p className="text-sm text-text-muted">{t("channel.overwrites.note")}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {names.map((n) => {
              const tri = triOf(allow, deny, n);
              return (
                <li key={n} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-sm">{t(`perm.${n}` as MessageKey)}</span>
                  <div
                    role="radiogroup"
                    aria-label={t(`perm.${n}` as MessageKey)}
                    className="flex overflow-hidden rounded-md border border-border-control"
                  >
                    {(["deny", "inherit", "allow"] as Tri[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        aria-checked={tri === v}
                        onClick={() => {
                          const next = withTri(allow, deny, n, v);
                          void set(next.allow, next.deny);
                        }}
                        className={`px-2 py-1 text-xs ${tri === v ? (v === "allow" ? "bg-success-bg-subtle text-success-text" : v === "deny" ? "bg-danger-bg-subtle text-danger-text" : "bg-bg-selected") : "hover:bg-bg-hover"}`}
                      >
                        {t(`channel.tri.${v}`)}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {current ? (
            <div>
              <Button variant="ghost" className="text-danger-text" onClick={() => void remove(current)}>
                {t("channel.overwrites.remove")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-text-muted">{t("channel.overwrites.pick")}</p>
      )}
    </div>
  );
}

export function ChannelsPane() {
  const t = useT();
  const channels = useCommunity((s) => s.channels);
  const categories = useCommunity((s) => s.categories);
  const canManage = useCan("MANAGE_CHANNELS");
  const { id } = useSettingsParams();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ edit?: Channel } | null>(null);
  const [catName, setCatName] = useState("");
  const [delCat, setDelCat] = useState<string | null>(null);
  const selected = channels.find((c) => c.id === id) ?? null;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl">{t("settings.channels")}</h2>
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <div className={card}>
          {categories.map((cat) => (
            <div key={cat.id}>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{cat.name}</h3>
                {canManage ? (
                  <button type="button" className="text-xs underline" onClick={() => setDelCat(cat.id)}>
                    {t("common.delete")}
                  </button>
                ) : null}
              </div>
              <ul className="m-0 list-none p-0">
                {channels
                  .filter((c) => c.categoryId === cat.id)
                  .map((c) => (
                    <ChannelButton
                      key={c.id}
                      c={c}
                      active={selected?.id === c.id}
                      onPick={() => void navigate(`/settings/channels/${c.id}`)}
                    />
                  ))}
              </ul>
            </div>
          ))}
          {channels.some((c) => c.categoryId === null) ? (
            <ul className="m-0 list-none p-0">
              {channels
                .filter((c) => c.categoryId === null)
                .map((c) => (
                  <ChannelButton
                    key={c.id}
                    c={c}
                    active={selected?.id === c.id}
                    onPick={() => void navigate(`/settings/channels/${c.id}`)}
                  />
                ))}
            </ul>
          ) : null}
          {canManage ? (
            <>
              <Button onClick={() => setDialog({})}>{t("channel.create")}</Button>
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (catName.trim())
                    void api
                      .createCategory(catName.trim())
                      .then(() => setCatName(""))
                      .catch(toastError);
                }}
              >
                <Field
                  label={t("channel.category.new")}
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  maxLength={64}
                />
                <Button type="submit" variant="ghost" disabled={!catName.trim()}>
                  {t("common.add")}
                </Button>
              </form>
            </>
          ) : null}
        </div>
        {selected ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-xl">
                {selected.type === "voice" ? "" : "#"}
                {selected.name}
              </h3>
              {canManage ? (
                <Button variant="ghost" onClick={() => setDialog({ edit: selected })}>
                  {t("channel.edit")}
                </Button>
              ) : null}
            </div>
            {canManage ? (
              <OverwriteEditor channel={selected} />
            ) : (
              <p className="text-text-muted">{t("channel.overwrites.denied")}</p>
            )}
          </div>
        ) : (
          <p className="text-text-muted">{t("channel.pick")}</p>
        )}
      </div>
      {dialog ? (
        <CreateChannelDialog
          categoryId={dialog.edit?.categoryId ?? null}
          {...(dialog.edit ? { edit: dialog.edit } : {})}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ConfirmDialog
        open={delCat !== null}
        onOpenChange={(o) => !o && setDelCat(null)}
        title={t("channel.category.delete.title")}
        body={t("channel.category.delete.body")}
        confirmLabel={t("common.delete")}
        onConfirm={() => (delCat ? api.deleteCategory(delCat).catch(toastError) : undefined)}
      />
    </section>
  );
}

function ChannelButton({ c, active, onPick }: { c: Channel; active: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onPick}
        className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-bg-hover ${active ? "bg-bg-selected" : ""}`}
      >
        {c.type === "voice" ? (
          <Volume2 aria-hidden="true" size={14} />
        ) : (
          <Hash aria-hidden="true" size={14} />
        )}
        <bdi className="truncate">{c.name}</bdi>
      </button>
    </li>
  );
}

// ---- Invites (W-43) ------------------------------------------------------------------------------------------------------

export function InvitesPane() {
  const t = useT();
  const roles = useCommunity((s) => s.roles).filter((r) => !r.isDefault);
  const canAll = useCan("MANAGE_INVITES");
  const members = useCommunity((s) => s.members);
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [expires, setExpires] = useState("604800");
  const [maxUses, setMaxUses] = useState("");
  const [role, setRole] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = () =>
    api
      .invites(canAll && showAll)
      .then(setInvites)
      .catch(toastError);
  useEffect(() => {
    void load();
  }, [showAll, canAll]);

  const link = (code: string) => `${window.location.origin}/invite/${code}`;
  const create = async () => {
    try {
      const inv = await api.createInvite({
        ...(expires ? { expiresInSecs: Number(expires) } : {}),
        ...(maxUses ? { maxUses: Math.max(1, Number.parseInt(maxUses, 10) || 1) } : {}),
        ...(role ? { defaultRoleId: role } : {}),
      });
      setInvites((cur) => [inv, ...(cur ?? [])]);
      await navigator.clipboard
        ?.writeText(link(inv.code))
        .then(() => toast(t("invites.copied")))
        .catch(() => undefined);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <h2 className="text-2xl">{t("settings.invites")}</h2>
      <form
        className={card}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h3 className="text-lg">{t("invites.create")}</h3>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("invites.expires")}
          <select
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
            className="min-h-9 rounded-md border border-border-control bg-bg-input px-2 font-normal"
          >
            <option value="1800">{t("invites.expires.30m")}</option>
            <option value="86400">{t("invites.expires.1d")}</option>
            <option value="604800">{t("invites.expires.7d")}</option>
            <option value="2592000">{t("invites.expires.30d")}</option>
            <option value="">{t("invites.expires.never")}</option>
          </select>
        </label>
        <Field
          label={t("invites.maxUses")}
          hint={t("invites.maxUses.hint")}
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("invites.role")}
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="min-h-9 rounded-md border border-border-control bg-bg-input px-2 font-normal"
          >
            <option value="">{t("invites.role.none")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <Button type="submit">{t("invites.create.submit")}</Button>
        </div>
      </form>
      <div className={card}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg">{t("invites.active")}</h3>
          {canAll ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {t("invites.showAll")}
            </label>
          ) : null}
        </div>
        {invites && invites.length === 0 ? <p className="text-text-muted">{t("invites.none")}</p> : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {(invites ?? []).map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono">{link(i.code)}</span>
                <span className="block text-text-muted">
                  {i.uses}
                  {i.maxUses ? ` / ${i.maxUses}` : ""} {t("invites.uses")} ·{" "}
                  {i.expiresAt
                    ? t("invites.until", { date: new Date(i.expiresAt).toLocaleString() })
                    : t("invites.expires.never")}
                  {showAll && i.createdBy ? ` · ${memberName(members[i.createdBy], "?")}` : ""}
                  {i.defaultRoleId ? ` · ${roles.find((r) => r.id === i.defaultRoleId)?.name ?? ""}` : ""}
                </span>
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard?.writeText(link(i.code)).then(() => toast(t("invites.copied")))
                }
              >
                {t("invites.copy")}
              </Button>
              <Button
                variant="ghost"
                className="text-danger-text"
                onClick={() =>
                  void api
                    .revokeInvite(i.id)
                    .then(() => setInvites((cur) => cur?.filter((x) => x.id !== i.id) ?? null))
                    .catch(toastError)
                }
              >
                {t("invites.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
