// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useState } from "react";
import { LINK_PREVIEW_DEFAULT_ALLOW } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { Button } from "../../ui/Button.js";
import { toast, toastError } from "../../ui/toast.js";
import { Panel, SettingsSection, SwitchRow } from "./layout.js";

const JOIN = String.fromCharCode(10);
const area =
  "min-h-28 w-full rounded-md border border-border-control bg-bg-input p-2.5 font-mono text-sm leading-relaxed hover:border-text-muted disabled:cursor-not-allowed disabled:text-text-disabled";
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;

const lines = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

/** The owner's switch for link previews and the sites they apply to (23 §8.5). */
export function LinkPreviewsCard() {
  const t = useT();
  const denyId = useId();
  const featureOn = useSession((s) => Boolean(s.capabilities?.features["link-previews"]));
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [allowAll, setAllowAll] = useState(false);
  const [allow, setAllow] = useState(LINK_PREVIEW_DEFAULT_ALLOW.join(JOIN));
  const [deny, setDeny] = useState("");

  useEffect(() => {
    if (!featureOn) return;
    void api
      .linkPreviewSettings()
      .then((s) => {
        setEnabled(s.enabled);
        setAllowAll(s.allowAll);
        setAllow(s.allowDomains.join("\n"));
        setDeny(s.denyDomains.join("\n"));
        setLoaded(true);
      })
      .catch(toastError);
  }, [featureOn]);
  if (!featureOn) return null;

  const allowList = lines(allow);
  const denyList = lines(deny);
  const bad = [...allowList, ...denyList].find((d) => !DOMAIN.test(d));

  return (
    <SettingsSection title={t("settings.linkPreviews")} description={t("settings.linkPreviews.description")}>
      <Panel
        label={t("settings.linkPreviews")}
        onSubmit={(e) => {
          e.preventDefault();
          if (bad) return;
          void api
            .setLinkPreviewSettings({ enabled, allowAll, allowDomains: allowList, denyDomains: denyList })
            .then((s) => {
              const caps = useSession.getState().capabilities;
              if (caps)
                useSession.setState({
                  capabilities: {
                    ...caps,
                    features: { ...caps.features, "link-previews": { enabled: s.enabled } },
                  },
                });
              toast(t("settings.saved"));
            })
            .catch(toastError);
        }}
        footer={
          <Button type="submit" disabled={!loaded || Boolean(bad)}>
            {t("common.save")}
          </Button>
        }
      >
        <SwitchRow
          label={t("settings.linkPreviews.enable")}
          description={t("settings.linkPreviews.hint")}
          checked={enabled}
          disabled={!loaded}
          onChange={setEnabled}
        />
        <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 px-5 py-4">
          <legend className="float-start mb-0.5 text-sm font-medium">
            {t("settings.linkPreviews.allowTitle")}
          </legend>
          <p className="clear-both m-0 max-w-prose text-sm text-text-muted">
            {allowAll ? t("settings.linkPreviews.allowAllOn") : t("settings.linkPreviews.allowNote")}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="meta text-text-muted">{t("settings.linkPreviews.allow")}</span>
            <textarea
              className={area}
              value={allow}
              disabled={!loaded || allowAll}
              spellCheck={false}
              onChange={(e) => setAllow(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              disabled={!loaded || allowAll}
              onClick={() => setAllow(LINK_PREVIEW_DEFAULT_ALLOW.join(JOIN))}
            >
              {t("settings.linkPreviews.restore")}
            </Button>
            {allowList.length === 0 && !allowAll ? (
              <p role="status" className="m-0 text-sm text-text-muted">
                {t("settings.linkPreviews.emptyList")}
              </p>
            ) : null}
          </div>
        </fieldset>
        <div>
          <SwitchRow
            label={t("settings.linkPreviews.allowAll")}
            checked={allowAll}
            disabled={!loaded}
            onChange={setAllowAll}
          />
          {allowAll ? (
            <p
              role="alert"
              className="mx-5 mb-4 border-s-2 border-danger bg-danger-bg-subtle px-3 py-2 text-sm text-danger-text"
            >
              {t("settings.linkPreviews.allowAllWarn")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 px-5 py-4">
          <label htmlFor={denyId} className="text-sm font-medium">
            {t("settings.linkPreviews.deny")}
          </label>
          <p id={`${denyId}-hint`} className="max-w-prose text-sm text-text-muted">
            {t("settings.linkPreviews.domainsHint")}
          </p>
          <textarea
            id={denyId}
            aria-describedby={`${denyId}-hint`}
            className={`${area} mt-1.5`}
            value={deny}
            disabled={!loaded}
            spellCheck={false}
            onChange={(e) => setDeny(e.target.value)}
          />
        </div>
        {bad ? (
          <p role="alert" className="px-5 py-3 text-sm text-danger-text">
            {t("settings.linkPreviews.invalid", { value: bad })}
          </p>
        ) : null}
      </Panel>
    </SettingsSection>
  );
}
