// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../core/api/client.js";
import { useT } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";
import { Banner } from "../ui/Banner.js";
import { Button } from "../ui/Button.js";
import { Field, PasswordField } from "../ui/Field.js";
import { AuthCard } from "./AuthCard.js";

/** The invite page and registration (W-32, W-33, 11 §1.5). */
export function InvitePage() {
  const t = useT();
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const user = useSession((s) => s.user);
  const signedIn = useSession((s) => s.signedIn);
  const [preview, setPreview] = useState<{ instanceName: string; memberCount: number } | "invalid" | null>(
    null,
  );
  const [form, setForm] = useState({ displayName: "", username: "", password: "" });
  const [errors, setErrors] = useState<{ username?: string; password?: string; general?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .invitePreview(code)
      // Expired, used up, revoked and unknown all look the same, so the page leaks nothing (W-32).
      .then(setPreview)
      .catch(() => setPreview("invalid"));
  }, [code]);

  if (user && preview && preview !== "invalid") {
    return (
      <AuthCard title={t("invite.already", { name: preview.instanceName })}>
        <div className="flex justify-end">
          <Button onClick={() => void navigate("/")}>{t("invite.open")}</Button>
        </div>
      </AuthCard>
    );
  }
  if (preview === null) {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center text-text-muted">
        {t("app.loading")}
      </div>
    );
  }
  if (preview === "invalid") {
    return (
      <AuthCard title={t("invite.invalid.title")} subtitle={t("invite.invalid.body")}>
        <div className="flex justify-end">
          <Link to="/login">{t("invite.login")}</Link>
        </div>
      </AuthCard>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await api.register({ inviteCode: code, ...form });
      signedIn(res.user);
      void navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = err.details?.fields as Record<string, string> | undefined;
        if (err.code === "CONFLICT") setErrors({ username: t("invite.usernameTaken") });
        else if (err.code === "VALIDATION_FAILED" && fields?.password)
          setErrors({ password: fields.password });
        else if (err.code === "VALIDATION_FAILED") setErrors({ general: t("invite.check") });
        else if (err.code === "RATE_LIMITED") setErrors({ general: t("error.RATE_LIMITED") });
        else if (err.code === "NOT_FOUND" || err.code === "INVITE_EXPIRED" || err.code === "INVITE_EXHAUSTED")
          setPreview("invalid");
        else setErrors({ general: t("error.INTERNAL") });
      } else setErrors({ general: t("error.INTERNAL") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={t("invite.title", { name: preview.instanceName })}
      subtitle={t("invite.members", { count: preview.memberCount })}
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
        <Field
          label={t("setup.account.displayName")}
          value={form.displayName}
          onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          maxLength={32}
          autoFocus
          required
        />
        <Field
          label={t("setup.account.username")}
          hint={t("setup.account.usernameHint")}
          error={errors.username ?? null}
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <PasswordField
          label={t("setup.account.password")}
          hint={t("invite.passwordHint")}
          error={errors.password ?? null}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          autoComplete="new-password"
          required
        />
        {errors.general ? <Banner tone="error">{errors.general}</Banner> : null}
        <div className="flex items-center justify-between gap-2">
          <Link to="/login" className="text-sm">
            {t("invite.haveAccount")}
          </Link>
          <Button type="submit" disabled={busy || !form.displayName || !form.username || !form.password}>
            {t("invite.join", { name: preview.instanceName })}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

/** "Use a reset code" (W-33, 11 §1.6): an admin-issued one-time code sets a new password. */
export function ResetPage() {
  const t = useT();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.redeemReset(code, password);
      setDone(true);
    } catch (err) {
      const fields =
        err instanceof ApiError ? (err.details?.fields as Record<string, string> | undefined) : undefined;
      setError(
        fields?.password ??
          (err instanceof ApiError && err.code === "NOT_FOUND"
            ? t("reset.invalid")
            : err instanceof ApiError && err.code === "RATE_LIMITED"
              ? t("error.RATE_LIMITED")
              : t("error.INTERNAL")),
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title={t("reset.done.title")} subtitle={t("reset.done.body")}>
        <div className="flex justify-end">
          <Button onClick={() => void navigate("/login")}>{t("login.submit")}</Button>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={t("reset.title")} subtitle={t("reset.intro")}>
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
        <Field
          label={t("reset.code")}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          required
        />
        <PasswordField
          label={t("reset.newPassword")}
          error={error}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <p className="text-sm text-text-muted">{t("reset.warning")}</p>
        <div className="flex items-center justify-between">
          <Link to="/login" className="text-sm">
            {t("reset.back")}
          </Link>
          <Button type="submit" disabled={busy || !code || !password}>
            {t("reset.submit")}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}
