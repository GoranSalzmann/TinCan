// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useT } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";
import { Button } from "../ui/Button.js";
import { AppLayout } from "./AppLayout.js";
import { AuthCard } from "./AuthCard.js";
import { LoginPage } from "./LoginPage.js";
import { SetupPage } from "./SetupPage.js";

/**
 * Decides which screen the visitor may see (11 §1.4, 04 §10):
 * setup required → /setup only; not logged in → /login; logged in → the app.
 */
function Gate() {
  const t = useT();
  const { boot, capabilities, user, wizardActive, bootstrap } = useSession();
  const location = useLocation();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (boot === "loading") {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center text-text-muted">
        {t("app.loading")}
      </div>
    );
  }
  if (boot === "unreachable") {
    return (
      <AuthCard title={t("connect.failed.title")} subtitle={t("connect.failed.body")}>
        <div className="flex justify-end">
          <Button onClick={() => void bootstrap()}>{t("connect.failed.retry")}</Button>
        </div>
      </AuthCard>
    );
  }
  if (boot === "too-new") {
    return (
      <AuthCard title={t("connect.tooNew.title")} subtitle={t("connect.tooNew.body")}>
        <div className="flex justify-end">
          <Button onClick={() => window.location.reload()}>{t("connect.tooNew.reload")}</Button>
        </div>
      </AuthCard>
    );
  }

  const path = location.pathname;
  if (capabilities?.auth.setupRequired)
    return path === "/setup" ? <Outlet /> : <Navigate to="/setup" replace />;
  if (path === "/setup") return wizardActive ? <Outlet /> : <Navigate to="/" replace />;
  if (!user) return path === "/login" ? <Outlet /> : <Navigate to="/login" replace />;
  if (path === "/login") return <Navigate to="/" replace />;
  return <Outlet />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Gate />}>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<AppLayout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
