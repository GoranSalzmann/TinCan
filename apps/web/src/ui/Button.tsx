// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "border border-accent bg-accent text-text-on-accent hover:border-accent-hover hover:bg-accent-hover",
  ghost: "border border-border-control bg-transparent text-text hover:border-text-muted hover:bg-bg-hover",
  danger: "border border-danger bg-danger text-text-on-danger hover:opacity-90",
};

/** `btn` and `btn-<variant>` carry no styles of their own: they are hooks for the themes in styles.css. */
export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm font-semibold tracking-[0.005em] transition-colors duration-(--duration-fast) disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-hover disabled:text-text-disabled ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
