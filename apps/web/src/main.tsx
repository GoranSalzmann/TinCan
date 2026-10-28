// SPDX-License-Identifier: AGPL-3.0-or-later
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { DirectionProvider } from "@radix-ui/react-direction";
import "./styles.css";
import { directionOf, useLocale } from "./core/i18n/index.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { AppRoutes } from "./shell/AuthGate.js";
import { initAppearance } from "./theme/store.js";

function Root() {
  const locale = useLocale((s) => s.locale);
  return (
    <DirectionProvider dir={directionOf(locale)}>
      <ErrorBoundary>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ErrorBoundary>
    </DirectionProvider>
  );
}

initAppearance();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
