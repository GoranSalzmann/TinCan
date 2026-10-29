// SPDX-License-Identifier: AGPL-3.0-or-later
import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../core/i18n/index.js";
import { Button } from "./Button.js";

/** Modal dialog on Radix: focus trap, Esc, labelled by its title (style guide §11). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-60 bg-overlay" />
        <RadixDialog.Content
          aria-describedby={description ? undefined : undefined}
          className={`elev-2 fixed start-1/2 top-1/2 z-70 max-h-[90dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 rtl:translate-x-1/2 ${wide ? "max-w-2xl" : "max-w-md"}`}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <RadixDialog.Title className="text-lg font-semibold">{title}</RadixDialog.Title>
            <RadixDialog.Close aria-label={t("dialog.close")} className="rounded-md p-1 hover:bg-bg-hover">
              <X aria-hidden="true" size={18} />
            </RadixDialog.Close>
          </div>
          {description ? (
            <RadixDialog.Description className="mb-3 text-sm text-text-muted">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** "Are you sure" for destructive actions; the confirm button is the danger variant. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}) {
  const t = useT();
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={body}>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={() => {
            void Promise.resolve(onConfirm()).finally(() => onOpenChange(false));
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
