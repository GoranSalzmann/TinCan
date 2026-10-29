// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { useT } from "../../core/i18n/index.js";
import { Button } from "../../ui/Button.js";
import { Modal } from "../../ui/Dialog.js";
import type { LinkCheck } from "./markdown.js";

interface LinkGateState {
  pending: { href: string; check: LinkCheck } | null;
  request: (href: string, check: LinkCheck) => void;
  close: () => void;
}

/** Opens a link in a new tab with no opener; suspicious ones ask first (12 §5.6, W-03). */
function openSafely(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}

export const useLinkGate = create<LinkGateState>((set) => ({
  pending: null,
  request(href, check) {
    if (check.suspicious) set({ pending: { href, check } });
    else openSafely(href);
  },
  close: () => set({ pending: null }),
}));

export function LinkConfirmDialog() {
  const t = useT();
  const { pending, close } = useLinkGate();
  return (
    <Modal
      open={pending !== null}
      onOpenChange={(o) => !o && close()}
      title={t("link.confirm.title")}
      description={t("link.confirm.body")}
    >
      {pending ? (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-muted">{t("link.confirm.shown")}</dt>
            <dd className="m-0 break-all">{pending.check.shownHost ?? pending.href}</dd>
            <dt className="text-text-muted">{t("link.confirm.goes")}</dt>
            <dd className="m-0 break-all font-medium">{pending.check.realHost ?? pending.href}</dd>
          </dl>
          <p className="text-sm text-text-muted">{t("link.confirm.warning")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                openSafely(pending.href);
                close();
              }}
            >
              {t("link.confirm.open")}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
