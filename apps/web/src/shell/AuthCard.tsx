// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

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
          <h1 className="text-xl text-text">{title}</h1>
          {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}
