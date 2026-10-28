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
}

export function Field({ label, hint, error, trailing, className = "", ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-stretch gap-2">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`min-h-9 min-w-0 flex-1 rounded-md border border-border-control bg-bg-input px-3 py-1.5 text-base text-text placeholder:text-text-muted ${className}`}
          {...input}
        />
        {trailing}
      </div>
      {hint ? (
        <p id={hintId} className="max-w-prose text-sm text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger-text">
          <AlertCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
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
          className="rounded-md px-3 text-sm text-accent-text hover:bg-bg-hover"
        >
          {shown ? t("field.hide") : t("field.show")}
        </button>
      }
    />
  );
}
