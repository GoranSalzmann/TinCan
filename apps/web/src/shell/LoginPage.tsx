// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../core/api/client.js";
import { useT } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";
import { Banner } from "../ui/Banner.js";
import { Button } from "../ui/Button.js";
import { Field, PasswordField } from "../ui/Field.js";
import { AuthCard } from "./AuthCard.js";

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const login = useSession((s) => s.login);
  const name = useSession((s) => s.capabilities?.server.name ?? "Tin Can");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);

  const secondsLeft = until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
  const limited = secondsLeft > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || limited) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      void navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        const ms = err.retryAfterMs ?? 30_000;
        setNow(Date.now());
        setUntil(Date.now() + ms);
        setError(null);
      } else if (err instanceof ApiError && err.code === "ACCOUNT_DISABLED") {
        setError(t("login.disabled"));
      } else if (err instanceof ApiError && err.code === "UNAUTHENTICATED") {
        setError(t("login.invalid"));
      } else {
        setError(t("login.generic"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t("login.title", { name })}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
        <Field
          label={t("login.username")}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
        />
        <PasswordField
          label={t("login.password")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || limited || !username || !password}>
            {t("login.submit")}
          </Button>
        </div>
        {error ? <Banner tone="error">{error}</Banner> : null}
        {limited ? <Banner tone="warning">{t("login.rateLimited", { seconds: secondsLeft })}</Banner> : null}
      </form>
    </AuthCard>
  );
}
