// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettingsParams } from "./params.js";
import { Hash, Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import type { Channel, Invite, Overwrite } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { Switch, selectClass } from "../../ui/Controls.js";
import { ConfirmDialog } from "../../ui/Dialog.js";
import { Field } from "../../ui/Field.js";
import { toast, toastError } from "../../ui/toast.js";
import { CreateChannelDialog } from "../channels/CreateChannelDialog.js";
import { LinkPreviewsCard } from "./LinkPreviewsCard.js";
import {
  DetailHeader,
  EmptyDetail,
  FooterNote,
  MasterDetail,
  Panel,
  PanelNote,
  Row,
  SettingsPage,
  SettingsSection,
  SubHeading,
  SwitchRow,
  listItemClass,
} from "./layout.js";
import {
  TEXT_PERMISSIONS,
  VOICE_PERMISSIONS,
  toBig,
  toStr,
  triOf,
  withTri,
  type Tri,
} from "./permissions.js";

// ---- Server ------------------------------------------------------------------------------------------------------------

export function ServerPane() {
  const t = useT();
  const caps = useSession((s) => s.capabilities);
  const setName = useSession((s) => s.setInstanceName);
  const owner = useSession((s) => s.user?.isInstanceOwner ?? false);
  const voiceOn = useSession((s) => Boolean(s.capabilities?.features.voice));
  const [name, setNameDraft] = useState(caps?.server.name ?? "");
  const dirty = name.trim() !== (caps?.server.name ?? "");
  return (
    <SettingsPage title={t("settings.server")} description={t("settings.server.description")}>
      <SettingsSection
        title={t("settings.server.general")}
        description={t("settings.server.general.description")}
      >
        <Panel
          label={t("settings.server.general")}
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
          footer={
            owner ? (
              <>
                {dirty ? <FooterNote>{t("settings.unsaved")}</FooterNote> : null}
                <Button type="submit" disabled={!dirty || !name.trim()}>
                  {t("common.save")}
                </Button>
              </>
            ) : (
              <FooterNote>{t("settings.server.ownerOnly")}</FooterNote>
            )
          }
        >
          <Field
            layout="row"
            label={t("setup.community.name")}
            value={name}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={64}
            disabled={!owner}
          />
          <Row
            label={t("settings.server.source")}
            control={
              <a
                href={caps?.server.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="meta max-w-80 truncate"
              >
                {caps?.server.sourceUrl}
              </a>
            }
          />
        </Panel>
      </SettingsSection>
      {owner && voiceOn ? (
        <SettingsSection title={t("settings.voiceVideo")} description={t("settings.voiceVideo.description")}>
          <E2eeCard />
          <VideoLimitsCard />
        </SettingsSection>
      ) : null}
      {owner ? (
        <SettingsSection title={t("settings.uploads")} description={t("settings.uploads.description")}>
          <UploadLimitsCard />
        </SettingsSection>
      ) : null}
      {owner ? <LinkPreviewsCard /> : null}
    </SettingsPage>
  );
}

/** The server default for voice encryption (10 §5, 18 T17): on for new installs; channels can override it. */
function E2eeCard() {
  const t = useT();
  const voiceOn = useSession((s) => Boolean(s.capabilities?.features.voice));
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!voiceOn) return;
    void api
      .e2eeDefault()
      .then((r) => setEnabled(r.enabled))
      .catch(toastError);
  }, [voiceOn]);
  if (!voiceOn) return null;
  return (
    <Panel label={t("settings.e2ee")}>
      <SwitchRow
        label={t("settings.e2ee.default")}
        description={t("settings.e2ee.hint")}
        checked={enabled === true}
        disabled={enabled === null}
        onChange={(next) => {
          void api
            .setE2eeDefault(next)
            .then((r) => {
              setEnabled(r.enabled);
              const caps = useSession.getState().capabilities;
              if (caps)
                useSession.setState({
                  capabilities: {
                    ...caps,
                    features: {
                      ...caps.features,
                      voice: { ...(caps.features.voice as object), e2ee: r.enabled },
                    },
                  },
                });
              toast(t("settings.saved"));
            })
            .catch(toastError);
        }}
      />
    </Panel>
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
    <Panel
      label={t("settings.video")}
      onSubmit={(e) => {
        e.preventDefault();
        void api
          .setVideoLimits({ cameraMaxKbps: cameraKbps, screenshareMaxKbps: shareKbps })
          .then(() => toast(t("settings.saved")))
          .catch(toastError);
      }}
      footer={
        <Button type="submit" disabled={!loaded || cameraError !== null || shareError !== null}>
          {t("common.save")}
        </Button>
      }
    >
      <Field
        layout="row"
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
        layout="row"
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
    </Panel>
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
    <Panel
      label={t("settings.uploads")}
      footer={
        <Button type="submit" disabled={maxError !== null || quotaError !== null || ceiling === null}>
          {t("common.save")}
        </Button>
      }
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
      <Field
        layout="row"
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
        layout="row"
        label={t("settings.uploads.quota")}
        type="number"
        min={0}
        step="any"
        value={quotaGb}
        onChange={(e) => setQuotaGb(e.target.value)}
        error={quotaError}
        hint={t("settings.uploads.quota.hint")}
      />
    </Panel>
  );
}

// ---- Channels and their permissions (W-41) ------------------------------------------------------------------------------

const TRI_LOOK: Record<Tri, string> = {
  deny: "has-checked:bg-danger-bg-subtle has-checked:text-danger-text",
  inherit: "has-checked:bg-bg-selected has-checked:text-text",
  allow: "has-checked:bg-success-bg-subtle has-checked:text-success-text",
};

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
  const targetName = target
    ? target.type === "role"
      ? (roles.find((r) => r.id === target.id)?.name ?? "")
      : memberName(members[target.id])
    : "";
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-3">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label={t("channel.overwrites")}>
          {(rows ?? []).map((o) => {
            const active = target?.type === o.targetType && target.id === o.targetId;
            return (
              <li key={`${o.targetType}:${o.targetId}`}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => setTarget({ type: o.targetType, id: o.targetId })}
                  className={listItemClass(active)}
                >
                  <bdi className="min-w-0 flex-1 truncate">{nameOf(o)}</bdi>
                  <span className="meta text-text-muted">{t(`channel.overwrites.${o.targetType}`)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <label className="flex flex-col gap-1.5">
          <span className="meta text-text-muted">{t("channel.overwrites.add")}</span>
          <select
            value={add}
            onChange={(e) => {
              const [type, id] = e.target.value.split(":") as ["role" | "member", string];
              setAdd("");
              if (type && id) setTarget({ type, id });
            }}
            className={`${selectClass} w-full`}
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
        <Panel
          label={targetName}
          footer={
            <>
              <FooterNote>{t("channel.overwrites.note")}</FooterNote>
              {current ? (
                <Button variant="ghost" className="text-danger-text" onClick={() => void remove(current)}>
                  {t("channel.overwrites.remove")}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="flex items-center gap-2 px-5 py-3">
            <bdi className="font-display text-base font-bold tracking-tight">{targetName}</bdi>
            <span className="tag">{t(`channel.overwrites.${target.type}`)}</span>
          </div>
          {names.map((n) => {
            const tri = triOf(allow, deny, n);
            return (
              <Row
                key={n}
                label={t(`perm.${n}` as MessageKey)}
                control={
                  <div
                    role="radiogroup"
                    aria-label={t(`perm.${n}` as MessageKey)}
                    className="inline-flex rounded-md border border-border-control bg-bg-input p-0.5"
                  >
                    {(["deny", "inherit", "allow"] as Tri[]).map((v) => (
                      <label
                        key={v}
                        className={`flex min-h-7 cursor-pointer items-center rounded-sm px-2.5 text-xs text-text-muted select-none hover:text-text has-checked:font-medium has-focus-visible:outline-2 has-focus-visible:outline-focus ${TRI_LOOK[v]}`}
                      >
                        <input
                          type="radio"
                          name={`tri-${n}`}
                          className="sr-only"
                          checked={tri === v}
                          onChange={() => {
                            const next = withTri(allow, deny, n, v);
                            void set(next.allow, next.deny);
                          }}
                        />
                        {t(`channel.tri.${v}`)}
                      </label>
                    ))}
                  </div>
                }
              />
            );
          })}
        </Panel>
      ) : (
        <EmptyDetail>{t("channel.overwrites.pick")}</EmptyDetail>
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
  const pick = (c: Channel) => void navigate(`/settings/channels/${c.id}`);

  const group = (key: string, title: string | null, items: Channel[], catId?: string) => (
    <div key={key} className="flex flex-col gap-0.5">
      {title !== null ? (
        <div className="flex min-h-7 items-center gap-2 ps-2.5">
          <h3 className="meta min-w-0 truncate text-text-muted">{title}</h3>
          <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
          {canManage && catId ? (
            <button
              type="button"
              aria-label={t("channel.category.deleteNamed", { name: title })}
              className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-danger-text"
              onClick={() => setDelCat(catId)}
            >
              <Trash2 aria-hidden="true" size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {items.map((c) => (
          <ChannelButton key={c.id} c={c} active={selected?.id === c.id} onPick={() => pick(c)} />
        ))}
      </ul>
    </div>
  );

  return (
    <SettingsPage
      wide
      title={t("settings.channels")}
      description={t("settings.channels.description")}
      actions={
        canManage ? (
          <Button onClick={() => setDialog({})}>
            <Plus aria-hidden="true" size={16} />
            {t("channel.create")}
          </Button>
        ) : null
      }
    >
      <MasterDetail
        list={
          <nav aria-label={t("channel.list.label")} className="flex flex-col gap-4">
            {channels.some((c) => c.categoryId === null)
              ? group(
                  "loose",
                  null,
                  channels.filter((c) => c.categoryId === null),
                )
              : null}
            {categories.map((cat) =>
              group(
                cat.id,
                cat.name,
                channels.filter((c) => c.categoryId === cat.id),
                cat.id,
              ),
            )}
            {canManage ? (
              <form
                className="flex items-end gap-2 border-t border-border pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (catName.trim())
                    void api
                      .createCategory(catName.trim())
                      .then(() => setCatName(""))
                      .catch(toastError);
                }}
              >
                <div className="min-w-0 flex-1">
                  <Field
                    label={t("channel.category.new")}
                    value={catName}
                    onChange={(e) => setCatName(e.target.value)}
                    maxLength={64}
                  />
                </div>
                <Button type="submit" variant="ghost" className="min-h-10" disabled={!catName.trim()}>
                  {t("common.add")}
                </Button>
              </form>
            ) : null}
          </nav>
        }
      >
        {selected ? (
          <>
            <DetailHeader
              icon={
                <span className="flex size-11 shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent/12 text-accent-text">
                  {selected.type === "voice" ? (
                    <Volume2 aria-hidden="true" size={20} />
                  ) : (
                    <Hash aria-hidden="true" size={20} />
                  )}
                </span>
              }
              title={<bdi>{selected.name}</bdi>}
              subtitle={
                <>
                  {t(selected.type === "voice" ? "channel.detail.voice" : "channel.detail.text")}
                  {selected.topic ? <span className="text-text-muted"> / {selected.topic}</span> : null}
                </>
              }
              actions={
                canManage ? (
                  <Button variant="ghost" onClick={() => setDialog({ edit: selected })}>
                    <Pencil aria-hidden="true" size={14} />
                    {t("channel.edit")}
                  </Button>
                ) : null
              }
            />
            <div className="flex flex-col gap-4">
              <SubHeading title={t("channel.overwrites")} description={t("channel.overwrites.description")} />
              {canManage ? (
                <OverwriteEditor channel={selected} />
              ) : (
                <Panel>
                  <PanelNote>{t("channel.overwrites.denied")}</PanelNote>
                </Panel>
              )}
            </div>
          </>
        ) : (
          <EmptyDetail>{t("channel.pick")}</EmptyDetail>
        )}
      </MasterDetail>
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
    </SettingsPage>
  );
}

function ChannelButton({ c, active, onPick }: { c: Channel; active: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onPick}
        className={listItemClass(active)}
      >
        {c.type === "voice" ? (
          <Volume2 aria-hidden="true" size={15} className={active ? "text-accent-text" : ""} />
        ) : (
          <Hash aria-hidden="true" size={15} className={active ? "text-accent-text" : ""} />
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
    <SettingsPage title={t("settings.invites")} description={t("settings.invites.description")}>
      <SettingsSection title={t("invites.create")} description={t("invites.create.description")}>
        <Panel
          label={t("invites.create")}
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          footer={<Button type="submit">{t("invites.create.submit")}</Button>}
        >
          <Row
            label={t("invites.expires")}
            htmlFor="invite-expires"
            control={
              <select
                id="invite-expires"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                className={`${selectClass} w-56`}
              >
                <option value="1800">{t("invites.expires.30m")}</option>
                <option value="86400">{t("invites.expires.1d")}</option>
                <option value="604800">{t("invites.expires.7d")}</option>
                <option value="2592000">{t("invites.expires.30d")}</option>
                <option value="">{t("invites.expires.never")}</option>
              </select>
            }
          />
          <Field
            layout="row"
            label={t("invites.maxUses")}
            hint={t("invites.maxUses.hint")}
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
          <Row
            label={t("invites.role")}
            htmlFor="invite-role"
            control={
              <select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={`${selectClass} w-56`}
              >
                <option value="">{t("invites.role.none")}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            }
          />
        </Panel>
      </SettingsSection>
      <SettingsSection
        title={t("invites.active")}
        description={t("invites.active.description")}
        aside={
          canAll ? (
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              {t("invites.showAll")}
            </label>
          ) : null
        }
      >
        <Panel label={t("invites.active")}>
          {invites && invites.length === 0 ? <PanelNote>{t("invites.none")}</PanelNote> : null}
          {(invites ?? []).map((i) => (
            <Row
              key={i.id}
              label={<span className="meta block text-sm break-all text-text">{link(i.code)}</span>}
              description={
                <span className="meta flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>
                    {i.uses}
                    {i.maxUses ? ` / ${i.maxUses}` : ""} {t("invites.uses")}
                  </span>
                  <span>
                    {i.expiresAt
                      ? t("invites.until", { date: new Date(i.expiresAt).toLocaleString() })
                      : t("invites.expires.never")}
                  </span>
                  {showAll && i.createdBy ? <span>{memberName(members[i.createdBy], "?")}</span> : null}
                  {i.defaultRoleId ? (
                    <span className="tag">{roles.find((r) => r.id === i.defaultRoleId)?.name ?? ""}</span>
                  ) : null}
                </span>
              }
              control={
                <>
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
                </>
              }
            />
          ))}
        </Panel>
      </SettingsSection>
    </SettingsPage>
  );
}
