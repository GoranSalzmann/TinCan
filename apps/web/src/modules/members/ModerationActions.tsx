// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, type FormEvent } from "react";
import type { Member } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { memberName, useCan, useCommunity } from "../../core/state/community.js";
import { useVoice } from "../../core/voice/store.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Dialog.js";
import { toast, toastError } from "../../ui/toast.js";

type Flow = "kick" | "ban" | "timeout" | "move" | null;

const DURATIONS: [string, number, MessageKey][] = [
  ["m1", 60, "mod.timeout.m1"],
  ["m10", 600, "mod.timeout.m10"],
  ["h1", 3600, "mod.timeout.h1"],
  ["d1", 86_400, "mod.timeout.d1"],
  ["d7", 7 * 86_400, "mod.timeout.d7"],
  ["d28", 28 * 86_400, "mod.timeout.d28"],
];

/**
 * Moderation buttons on a member card (11 §3). The buttons follow the permissions the client knows; the server checks
 * the permission and the role hierarchy again on every call, so a refused action shows its reason as an error toast.
 */
export function ModerationActions({ member, onDone }: { member: Member; onDone: () => void }) {
  const t = useT();
  const me = useSession((s) => s.user?.id);
  const canKick = useCan("KICK_MEMBERS");
  const canBan = useCan("BAN_MEMBERS");
  const canTimeout = useCan("TIMEOUT_MEMBERS");
  const canMute = useCan("MUTE_MEMBERS");
  const canMove = useCan("MOVE_MEMBERS");
  const voicePresence = useVoice((s) => s.presence);
  const [flow, setFlow] = useState<Flow>(null);

  if (!me || member.userId === me || member.isOwner) return null;
  let inChannel: string | null = null;
  let entry: { serverMuted?: boolean | undefined; serverDeafened?: boolean | undefined } | null = null;
  for (const [channelId, list] of Object.entries(voicePresence)) {
    const p = list.find((x) => x.userId === member.userId);
    if (p) {
      inChannel = channelId;
      entry = p;
    }
  }
  const timedOut = member.timeoutUntil ? new Date(member.timeoutUntil) : null;
  const run = (fn: () => Promise<unknown>) =>
    void fn()
      .then(() => {
        toast(t("mod.done"));
        onDone();
      })
      .catch(toastError);

  const any = canKick || canBan || canTimeout || (canMute && inChannel) || (canMove && inChannel);
  if (!any) return null;
  return (
    <section aria-label={t("mod.title")} className="flex flex-col gap-2 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-semibold">{t("mod.title")}</h3>
      {timedOut ? (
        <p className="m-0 text-sm text-text-muted">
          {t("mod.timedOutUntil", { time: timedOut.toLocaleString() })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canTimeout ? (
          timedOut ? (
            <Button variant="ghost" onClick={() => run(() => api.timeout(member.userId, null))}>
              {t("mod.timeout.end")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setFlow("timeout")}>
              {t("mod.timeout")}
            </Button>
          )
        ) : null}
        {canMute && inChannel ? (
          <>
            <Button
              variant="ghost"
              onClick={() => run(() => api.serverVoice(member.userId, { muted: !entry?.serverMuted }))}
            >
              {entry?.serverMuted ? t("mod.unmute") : t("mod.mute")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => run(() => api.serverVoice(member.userId, { deafened: !entry?.serverDeafened }))}
            >
              {entry?.serverDeafened ? t("mod.undeafen") : t("mod.deafen")}
            </Button>
          </>
        ) : null}
        {canMove && inChannel ? (
          <>
            <Button variant="ghost" onClick={() => setFlow("move")}>
              {t("mod.move")}
            </Button>
            <Button variant="ghost" onClick={() => run(() => api.disconnectMember(member.userId))}>
              {t("mod.disconnect")}
            </Button>
          </>
        ) : null}
        {canKick ? (
          <Button variant="danger" onClick={() => setFlow("kick")}>
            {t("mod.kick")}
          </Button>
        ) : null}
        {canBan ? (
          <Button variant="danger" onClick={() => setFlow("ban")}>
            {t("mod.ban")}
          </Button>
        ) : null}
      </div>
      {flow ? (
        <ActionDialog
          flow={flow}
          member={member}
          currentChannel={inChannel}
          onClose={() => setFlow(null)}
          onDone={() => {
            setFlow(null);
            onDone();
          }}
        />
      ) : null}
    </section>
  );
}

function ActionDialog({
  flow,
  member,
  currentChannel,
  onClose,
  onDone,
}: {
  flow: Exclude<Flow, null>;
  member: Member;
  currentChannel: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const channels = useCommunity((s) => s.channels);
  const voiceChannels = channels.filter(
    (c) => c.type === "voice" && c.id !== currentChannel && !c.archivedAt,
  );
  const [reason, setReason] = useState("");
  const [purge, setPurge] = useState(0);
  const [duration, setDuration] = useState(600);
  const [target, setTarget] = useState(voiceChannels[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const name = memberName(member);
  const why = reason.trim() === "" ? undefined : reason.trim();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const call =
      flow === "kick"
        ? api.kick(member.userId, why)
        : flow === "ban"
          ? api.ban(member.userId, { purgeDays: purge, ...(why ? { reason: why } : {}) })
          : flow === "timeout"
            ? api.timeout(member.userId, duration, why)
            : api.moveMember(member.userId, target);
    void call
      .then(() => {
        toast(t("mod.done"));
        onDone();
      })
      .catch(toastError)
      .finally(() => setBusy(false));
  };

  const title = t(`mod.${flow}` as MessageKey) + " — " + name;
  const select = "min-h-9 rounded-md border border-border-control bg-bg-input px-2 text-base text-text";
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {flow === "kick" ? <p className="m-0 text-sm">{t("mod.kick.body", { name })}</p> : null}
        {flow === "ban" ? <p className="m-0 text-sm">{t("mod.ban.body", { name })}</p> : null}
        {flow === "timeout" ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("mod.timeout.for")}
            <select className={select} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map(([k, secs, label]) => (
                <option key={k} value={secs}>
                  {t(label)}
                </option>
              ))}
            </select>
            <span className="font-normal text-text-muted">{t("mod.timeout.body")}</span>
          </label>
        ) : null}
        {flow === "ban" ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("mod.purge")}
            <select className={select} value={purge} onChange={(e) => setPurge(Number(e.target.value))}>
              <option value={0}>{t("mod.purge.0")}</option>
              <option value={1}>{t("mod.purge.1")}</option>
              <option value={7}>{t("mod.purge.7")}</option>
            </select>
          </label>
        ) : null}
        {flow === "move" ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("mod.move.to")}
            <select className={select} value={target} onChange={(e) => setTarget(e.target.value)}>
              {voiceChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {flow !== "move" ? (
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t("mod.reason")}
            <input
              className={select}
              value={reason}
              maxLength={512}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant={flow === "kick" || flow === "ban" ? "danger" : "primary"}
            disabled={busy || (flow === "move" && target === "")}
          >
            {t(`mod.${flow}` as MessageKey)}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
