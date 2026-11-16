// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InputHTMLAttributes, ReactNode } from "react";

/** The look of every native select (style guide §7): same height, outline and fill as a text field. */
export const selectClass =
  "min-h-9 max-w-full rounded-md border border-border-control bg-bg-input ps-2.5 pe-1.5 text-sm text-text hover:border-text-muted disabled:cursor-not-allowed disabled:text-text-disabled";

/**
 * An on/off switch. It is a real checkbox with `role="switch"`, so labels, forms and keyboard behave as usual and
 * the state is announced as on/off; the `switch` utility in styles.css draws the track and knob.
 */
export function Switch({
  className = "",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return <input type="checkbox" role="switch" className={`switch ${className}`} {...rest} />;
}

/**
 * A row of mutually exclusive choices (theme, notification level, transmit mode). Real radio inputs underneath:
 * arrow keys move between options and the group is announced as a radio group (style guide §11).
 */
export function Segmented<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  name: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex max-w-full flex-wrap rounded-md border border-border-control bg-bg-input p-0.5"
    >
      {options.map((o) => (
        <label
          key={o.value}
          className="relative flex min-h-8 cursor-pointer items-center rounded-sm px-3 text-sm text-text-muted select-none hover:text-text has-checked:bg-bg-selected has-checked:font-medium has-checked:text-text has-disabled:cursor-not-allowed has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus"
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}
