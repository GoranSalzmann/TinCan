// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, type FormEvent, type ReactNode } from "react";
import { Switch } from "../../ui/Controls.js";

/**
 * The settings grammar (W-20). A page has a title and one line on what it covers; it is made of sections, each with
 * its heading and explanation at the start and its settings in one panel at the end; a panel is a list of rows, each
 * row one setting (label and help at the start, the control at the end). A panel that needs saving has one footer
 * with the Save button, so a page never has a button after every field.
 */

export function SettingsPage({
  title,
  description,
  actions,
  wide = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Buttons for the whole page, at the end of the header. */
  actions?: ReactNode;
  /** List-and-detail pages (channels, roles, members) use the full width. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex w-full flex-col gap-10 pb-16 ${wide ? "" : "max-w-5xl"}`}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-border pb-6">
        <div className="flex max-w-prose min-w-0 flex-col gap-2">
          <h2 className="text-4xl leading-none font-bold">{title}</h2>
          {description ? <p className="text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Extra controls under the explanation, e.g. a filter for the list in the panel. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:gap-10"
    >
      <div className="flex min-w-0 flex-col gap-1.5 lg:pt-4">
        <h3 id={id} className="text-lg leading-snug font-bold">
          {title}
        </h3>
        {description ? <p className="text-sm text-text-muted">{description}</p> : null}
        {aside ? <div className="mt-2 flex flex-col items-start gap-2">{aside}</div> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

const panelClass = "flex flex-col overflow-hidden rounded-lg border border-border bg-bg-elevated";

/** One surface of rows. With `onSubmit` it is a form and its footer submits it. */
export function Panel({
  children,
  footer,
  onSubmit,
  label,
}: {
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: (e: FormEvent) => void;
  label?: string;
}) {
  const body = (
    <>
      <div className="flex flex-col divide-y divide-border">{children}</div>
      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border bg-bg-sidebar px-5 py-3">
          {footer}
        </div>
      ) : null}
    </>
  );
  return onSubmit ? (
    <form className={panelClass} onSubmit={onSubmit} aria-label={label} noValidate>
      {body}
    </form>
  ) : (
    <div className={panelClass} role={label ? "group" : undefined} aria-label={label}>
      {body}
    </div>
  );
}

/** Text at the start of a panel footer, e.g. "Unsaved changes". */
export function FooterNote({ children }: { children: ReactNode }) {
  return <p className="meta me-auto text-text-muted">{children}</p>;
}

/** A setting: label and help at the start, the control at the end; `children` spans the row below both. */
export function Row({
  label,
  description,
  htmlFor,
  control,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** The control's id, so the label names it. */
  htmlFor?: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm font-medium text-text">
              {label}
            </label>
          ) : (
            <div className="text-sm font-medium text-text">{label}</div>
          )}
          {description ? <div className="max-w-prose text-sm text-text-muted">{description}</div> : null}
        </div>
        {control ? <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A row whose control is a switch; the label names the switch and the description describes it. */
export function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-text">
          {label}
        </label>
        {description ? (
          <div id={`${id}-d`} className="max-w-prose text-sm text-text-muted">
            {description}
          </div>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
    </div>
  );
}

/** A plain line inside a panel: an empty list, a note, a status. */
export function PanelNote({ children, role }: { children: ReactNode; role?: "status" | "alert" }) {
  return (
    <p role={role} className="px-5 py-4 text-sm text-text-muted">
      {children}
    </p>
  );
}

// ---- List and detail (channels, roles, members) ------------------------------------------------------------------

/** The list column at the start and the selected item at the end; stacked on narrow screens. */
export function MasterDetail({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-10">
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0">{list}</div>
      <div className="flex min-w-0 flex-col gap-8">{children}</div>
    </div>
  );
}

/** A row in a list column; `aria-current` marks the open item with the accent bar (style guide §5.3). */
export const listItemClass = (active: boolean) =>
  `relative flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-start text-sm no-underline hover:bg-bg-hover hover:text-text ${
    active
      ? "bg-bg-selected font-medium text-text before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:bg-accent"
      : "text-text-muted"
  }`;

/** What the detail column says before anything is picked. */
export function EmptyDetail({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-64 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border p-8 text-center">
      <div aria-hidden="true" className="grille-soft absolute inset-0" />
      <p className="relative max-w-xs text-sm text-text-muted">{children}</p>
    </div>
  );
}

/** The title of the open item in a detail column, with its actions at the end. */
export function DetailHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="truncate text-2xl leading-tight font-bold">{title}</h3>
        {subtitle ? <div className="meta text-text-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A small heading inside a detail column, above a panel. */
export function SubHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="font-display text-base font-bold tracking-tight">{title}</h4>
      {description ? <p className="max-w-prose text-sm text-text-muted">{description}</p> : null}
    </div>
  );
}

/** Pinned to the bottom of the page while a long editor has unsaved changes (the role editor). */
export function SaveBar({ children }: { children: ReactNode }) {
  return (
    <div className="elev-2 sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 px-4 py-3">
      {children}
    </div>
  );
}
