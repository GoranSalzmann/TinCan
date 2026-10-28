// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-text-on-accent hover:bg-accent-hover",
  ghost: "bg-transparent text-text hover:bg-bg-hover border border-border-control",
  danger: "bg-danger text-text-on-danger hover:opacity-90",
};

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-8 items-center justify-center gap-2 rounded-md px-4 py-1.5 text-base font-medium disabled:cursor-not-allowed disabled:bg-bg-hover disabled:text-text-disabled ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
