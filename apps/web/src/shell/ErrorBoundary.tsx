// SPDX-License-Identifier: AGPL-3.0-or-later
import { Component, type ErrorInfo, type ReactNode } from "react";
import { format, useLocale } from "../core/i18n/index.js";
import { Button } from "../ui/Button.js";
import { AuthCard } from "./AuthCard.js";

interface Props {
  children: ReactNode;
}

/** One boundary around the shell; each feature slot gets its own later so a crashing panel cannot take the rest down (12 §11). */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error", error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <Fallback onRetry={() => this.setState({ failed: false })} />;
  }
}

function Fallback({ onRetry }: { onRetry: () => void }) {
  const locale = useLocale((s) => s.locale);
  const t = (k: Parameters<typeof format>[1]) => format(locale, k);
  return (
    <AuthCard title={t("app.error.title")} subtitle={t("app.error.body")}>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => window.location.reload()}>
          {t("app.error.reload")}
        </Button>
        <Button onClick={onRetry}>{t("app.error.retry")}</Button>
      </div>
    </AuthCard>
  );
}
