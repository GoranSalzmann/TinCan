// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

/** The two-cans logo, decorative: the instance name is the heading. The dark variant follows the theme (styles.css). */
function BrandMark() {
  return (
    <div aria-hidden="true" className="mb-2">
      <img src="/brand/logo.svg" alt="" width={72} height={72} className="brand-light" />
      <img src="/brand/logo-dark.svg" alt="" width={72} height={72} className="brand-dark" />
    </div>
  );
}

/** Centered card used by setup, login and the blocking screens. */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh items-center justify-center bg-bg-sidebar px-4 py-8"
    >
      <div className="elev-2 flex w-full max-w-md flex-col gap-5 p-6">
        <header className="flex flex-col gap-1">
          <BrandMark />
          <h1 className="text-xl text-text">{title}</h1>
          {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}
