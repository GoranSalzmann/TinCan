// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

type Tone = "error" | "warning" | "success";

const TONES: Record<Tone, { box: string; Icon: typeof XCircle }> = {
  error: { box: "bg-danger-bg-subtle text-text", Icon: XCircle },
  warning: { box: "bg-warning-bg-subtle text-text", Icon: AlertTriangle },
  success: { box: "bg-success-bg-subtle text-text", Icon: CheckCircle2 },
};

const ICON_COLOUR: Record<Tone, string> = {
  error: "text-danger-text",
  warning: "text-warning-text",
  success: "text-success-text",
};

/** Never colour alone: every tone has an icon and the message is text (style guide §4). */
export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  const { box, Icon } = TONES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${box}`}
    >
      <Icon aria-hidden="true" size={16} className={`mt-0.5 shrink-0 ${ICON_COLOUR[tone]}`} />
      <div>{children}</div>
    </div>
  );
}
