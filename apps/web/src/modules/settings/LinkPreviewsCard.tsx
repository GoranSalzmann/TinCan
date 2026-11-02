// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useSession } from "../../core/session/store.js";
import { Button } from "../../ui/Button.js";
import { toast, toastError } from "../../ui/toast.js";

const card = "flex flex-col gap-3 rounded-lg border border-border p-4";
const area = "min-h-20 w-full rounded-md border border-border-control bg-bg-input p-2 font-mono text-sm";
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;

const lines = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);

/** The owner's switch for link previews and the sites they apply to (23 §8.5). */
export function LinkPreviewsCard() {
  const t = useT();
  const featureOn = useSession((s) => Boolean(s.capabilities?.features["link-previews"]));
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");

  useEffect(() => {
    if (!featureOn) return;
    void api
      .linkPreviewSettings()
      .then((s) => {
        setEnabled(s.enabled);
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
    <form
      className={card}
      onSubmit={(e) => {
        e.preventDefault();
        if (bad) return;
        void api
          .setLinkPreviewSettings({ enabled, allowDomains: allowList, denyDomains: denyList })
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
    >
      <h3 className="m-0 text-lg">{t("settings.linkPreviews")}</h3>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t("settings.linkPreviews.enable")}
      </label>
      <p className="m-0 text-sm text-text-muted">{t("settings.linkPreviews.hint")}</p>
      <label className="flex flex-col gap-1 text-sm">
        {t("settings.linkPreviews.allow")}
        <textarea
          className={area}
          value={allow}
          disabled={!loaded}
          spellCheck={false}
          onChange={(e) => setAllow(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {t("settings.linkPreviews.deny")}
        <textarea
          className={area}
          value={deny}
          disabled={!loaded}
          spellCheck={false}
          onChange={(e) => setDeny(e.target.value)}
        />
      </label>
      <p className="m-0 text-sm text-text-muted">{t("settings.linkPreviews.domainsHint")}</p>
      {bad ? (
        <p role="alert" className="m-0 text-sm text-danger-text">
          {t("settings.linkPreviews.invalid", { value: bad })}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!loaded || Boolean(bad)}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
