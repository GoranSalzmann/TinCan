// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { useT } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";

/** The two-cans logo, decorative: the instance name is the heading. The dark variant follows the theme (styles.css). */
function BrandMark({ size }: { size: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <img src="/brand/logo.svg" alt="" width={size} height={size} className="brand-light" />
      <img src="/brand/logo-dark.svg" alt="" width={size} height={size} className="brand-dark" />
    </span>
  );
}

/**
 * The place you are signing in to, set large over the grille (style guide §5.4): the instance name and the host it
 * is served from, so a look-alike address is easy to spot before typing a password.
 */
function Hero() {
  const t = useT();
  const name = useSession((s) => s.capabilities?.server.name) ?? t("app.name");
  return (
    <div className="relative isolate flex min-h-64 flex-col justify-between overflow-hidden border-b border-border bg-bg-rail p-6 md:min-h-dvh md:border-e md:border-b-0 md:p-10">
      <div aria-hidden="true" className="glow absolute inset-0 -z-10" />
      <div aria-hidden="true" className="grille absolute inset-0 -z-10" />
      <div className="flex items-center gap-2.5">
        <BrandMark size={28} />
        <span className="font-display text-base font-bold tracking-tight">{t("app.name")}</span>
      </div>
      <div className="flex flex-col gap-5 pt-10">
        <p className="display-hero font-display font-bold text-text">
          <bdi>{name}</bdi>
        </p>
        <p className="meta flex items-center gap-3 text-text-muted">
          <span aria-hidden="true" className="h-px w-12 shrink-0 bg-accent" />
          <bdi className="truncate">{window.location.host}</bdi>
        </p>
      </div>
    </div>
  );
}

/** Setup, login, invites and the blocking screens: the place on one side, the form on the other. */
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
      className="grid min-h-dvh bg-bg md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"
    >
      <Hero />
      <div className="flex items-start justify-center px-6 py-10 md:items-center md:px-10">
        <div className="flex w-full max-w-sm flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl leading-tight font-bold text-text">{title}</h1>
            {subtitle ? <p className="text-sm text-text-muted">{subtitle}</p> : null}
          </header>
          {children}
        </div>
      </div>
    </main>
  );
}
