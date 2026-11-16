// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { useT } from "../core/i18n/index.js";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: ReactNode;
  /** Shown under the field with an icon, linked with aria-describedby (style guide §4). */
  error?: string | null;
  /** Content to the end of the input, e.g. the Show button. */
  trailing?: ReactNode;
  /**
   * `stack` puts the label above the input (forms on their own). `row` is a settings row: label and hint at the start,
   * the input at the end, inside a settings panel (modules/settings/layout.tsx).
   */
  layout?: "stack" | "row";
}

export function Field({
  label,
  hint,
  error,
  trailing,
  layout = "stack",
  className = "",
  ...input
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const control = (
    <div className="flex items-stretch gap-2">
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`min-h-10 min-w-0 flex-1 rounded-md border border-border-control bg-bg-input px-3 py-2 text-base text-text placeholder:text-text-muted hover:border-text-muted aria-invalid:border-danger ${layout === "row" ? "min-h-9 py-1.5 text-sm" : ""} ${className}`}
        {...input}
      />
      {trailing}
    </div>
  );
  const errorLine = error ? (
    <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger-text">
      <AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
      <span>{error}</span>
    </p>
  ) : null;

  if (layout === "row") {
    return (
      <div className="flex flex-col gap-2 px-5 py-4 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] sm:items-start sm:gap-8">
        <div className="flex min-w-0 flex-col gap-0.5 sm:pt-2">
          <label htmlFor={id} className="text-sm font-medium text-text">
            {label}
          </label>
          {hint ? (
            <p id={hintId} className="max-w-prose text-sm text-text-muted">
              {hint}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          {control}
          {errorLine}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="max-w-prose text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
      {errorLine}
    </div>
  );
}

/** Password field with a Show button; never blocks paste (password managers). */
export function PasswordField(props: Omit<FieldProps, "type" | "trailing">) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <Field
      {...props}
      type={shown ? "text" : "password"}
      trailing={
        <button
          type="button"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="meta rounded-md border border-border px-3 text-accent-text hover:bg-bg-hover"
        >
          {shown ? t("field.hide") : t("field.show")}
        </button>
      }
    />
  );
}
