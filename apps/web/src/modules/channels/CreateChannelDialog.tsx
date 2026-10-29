// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { Channel } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useCommunity } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog, Modal } from "../../ui/Dialog.js";
import { Field } from "../../ui/Field.js";
import { toastError } from "../../ui/toast.js";

/** Create or edit a channel (W-02 menu: Edit channel). Voice channels exist from M2, joining arrives with voice (M3). */
export function CreateChannelDialog({
  categoryId,
  edit,
  onClose,
}: {
  categoryId: string | null;
  edit?: Channel;
  onClose: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const categories = useCommunity((s) => s.categories);
  const [type, setType] = useState<"text" | "voice">(edit?.type ?? "text");
  const [name, setName] = useState(edit?.name ?? "");
  const [topic, setTopic] = useState(edit?.topic ?? "");
  const [category, setCategory] = useState<string>(edit?.categoryId ?? categoryId ?? "");
  const [slow, setSlow] = useState(String(edit?.settings.slowmodeSecs ?? 0));
  const [limit, setLimit] = useState(edit?.settings.userLimit ? String(edit.settings.userLimit) : "");
  const [audioKbps, setAudioKbps] = useState(
    edit?.settings.bitrateKbps ? String(edit.settings.bitrateKbps) : "",
  );
  const [cameraOn, setCameraOn] = useState(edit?.settings.videoAllowed !== false);
  const [shareOn, setShareOn] = useState(edit?.settings.screenshareAllowed !== false);
  const [shareMbps, setShareMbps] = useState(
    edit?.settings.maxScreenshareKbps ? String(+(edit.settings.maxScreenshareKbps / 1000).toFixed(2)) : "",
  );
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      // A blank number clears the setting (null), so the server-wide default applies.
      const blankOr = (v: string, scale = 1) => (v.trim() === "" ? null : Math.round(Number(v) * scale));
      const settings =
        type === "text"
          ? { slowmodeSecs: Math.max(0, Number.parseInt(slow, 10) || 0) }
          : {
              userLimit: blankOr(limit),
              bitrateKbps: blankOr(audioKbps),
              videoAllowed: cameraOn,
              screenshareAllowed: shareOn,
              maxScreenshareKbps: blankOr(shareMbps, 1000),
            };
      if (edit) {
        await api.patchChannel(edit.id, {
          name,
          topic: topic.trim() === "" ? null : topic,
          categoryId: category === "" ? null : category,
          settings,
        });
      } else {
        const c = await api.createChannel({
          type,
          name,
          ...(topic.trim() ? { topic } : {}),
          categoryId: category === "" ? null : category,
          settings,
        });
        if (c.type === "text") void navigate(`/channels/${c.id}`);
      }
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open
        onOpenChange={(o) => !o && onClose()}
        title={edit ? t("channel.edit.title") : t("channel.create.title")}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {!edit ? (
            <fieldset className="flex gap-4">
              <legend className="mb-1 text-sm font-medium">{t("channel.type")}</legend>
              {(["text", "voice"] as const).map((v) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="type" checked={type === v} onChange={() => setType(v)} />
                  {t(`channel.type.${v}`)}
                </label>
              ))}
            </fieldset>
          ) : null}
          <Field
            label={t("channel.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            autoFocus
            required
          />
          {type === "text" ? (
            <>
              <Field
                label={t("channel.topic")}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                maxLength={1024}
              />
              <Field
                label={t("channel.slowmode")}
                hint={t("channel.slowmode.hint")}
                type="number"
                min={0}
                max={21600}
                value={slow}
                onChange={(e) => setSlow(e.target.value)}
              />
            </>
          ) : null}
          {type === "voice" ? (
            <fieldset className="flex flex-col gap-3 border-0 p-0">
              <legend className="mb-1 text-sm font-medium">{t("channel.voice.settings")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={cameraOn} onChange={(e) => setCameraOn(e.target.checked)} />
                {t("channel.voice.camera")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={shareOn} onChange={(e) => setShareOn(e.target.checked)} />
                {t("channel.voice.screenshare")}
              </label>
              <Field
                label={t("channel.voice.shareCap")}
                hint={t("channel.voice.shareCap.hint")}
                type="number"
                min={0.3}
                max={20}
                step="any"
                value={shareMbps}
                onChange={(e) => setShareMbps(e.target.value)}
                disabled={!shareOn}
              />
              <Field
                label={t("channel.voice.limit")}
                hint={t("channel.voice.default.hint")}
                type="number"
                min={1}
                max={99}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
              <Field
                label={t("channel.voice.audio")}
                hint={t("channel.voice.default.hint")}
                type="number"
                min={8}
                max={128}
                value={audioKbps}
                onChange={(e) => setAudioKbps(e.target.value)}
              />
            </fieldset>
          ) : null}
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("channel.category")}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="min-h-9 rounded-md border border-border-control bg-bg-input px-2 text-base font-normal"
            >
              <option value="">{t("channel.uncategorised")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-2 flex items-center justify-between gap-2">
            {edit ? (
              <Button variant="ghost" className="text-danger-text" onClick={() => setConfirmDelete(true)}>
                {t("channel.delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {edit ? t("common.save") : t("channel.create")}
              </Button>
            </div>
          </div>
        </form>
      </Modal>
      {edit ? (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("channel.delete.title", { name: edit.name })}
          body={t("channel.delete.body")}
          confirmLabel={t("channel.delete")}
          onConfirm={async () => {
            try {
              await api.deleteChannel(edit.id);
              void navigate("/");
              onClose();
            } catch (err) {
              toastError(err);
            }
          }}
        />
      ) : null}
    </>
  );
}
