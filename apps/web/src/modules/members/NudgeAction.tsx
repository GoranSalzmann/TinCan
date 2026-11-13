// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import type { Member } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { useT } from "../../core/i18n/index.js";
import { useFeature, useSession } from "../../core/session/store.js";
import { memberName } from "../../core/state/community.js";
import { Button } from "../../ui/Button.js";
import { toast, toastError } from "../../ui/toast.js";

/**
 * "Anstupsen" on a member card (module `nudge`, issue #34): a ping that reaches the other member as a
 * sound and a notification, or as a Web Push while their app is closed. The server holds the per-pair
 * cooldown; a refused call shows its reason as an error toast like every other member action.
 */
export function NudgeAction({ member }: { member: Member }) {
  const t = useT();
  const me = useSession((s) => s.user?.id);
  const on = useFeature("nudge");
  const push = useFeature("push");
  const [busy, setBusy] = useState(false);
  if (!on || !me || member.userId === me) return null;
  const name = memberName(member);
  return (
    <Button
      variant="ghost"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api
          .nudge(member.userId)
          .then(({ online }) =>
            toast(t(online ? "nudge.sent" : push ? "nudge.sentPushed" : "nudge.sentOffline", { name })),
          )
          .catch(toastError)
          .finally(() => setBusy(false));
      }}
    >
      {t("nudge.send", { name })}
    </Button>
  );
}
