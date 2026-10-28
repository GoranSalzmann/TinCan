// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { checkPassword, passwordStrength, USERNAME_RE } from "@tincan/shared";
import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { ApiError } from "../core/api/client.js";
import { probeGateway } from "../core/gateway/probe.js";
import { useT, type MessageKey } from "../core/i18n/index.js";
import { useSession } from "../core/session/store.js";
import { Banner } from "../ui/Banner.js";
import { Button } from "../ui/Button.js";
import { Field, PasswordField } from "../ui/Field.js";
import { AuthCard } from "./AuthCard.js";
import { describeError } from "./errors.js";
import { api } from "../core/api/client.js";

/**
 * First-run setup (W-30, 11 §1.4): token → owner account → community name → server checks.
 * The token is checked first, so a stranger who finds the page learns nothing. Voice checks join in M3.
 */

const STEP_NAMES: MessageKey[] = [
  "setup.stepName.token",
  "setup.stepName.account",
  "setup.stepName.community",
  "setup.stepName.checks",
];

export function SetupPage() {
  const t = useT();
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("");

  return (
    <AuthCard
      title={t("setup.title")}
      subtitle={t("setup.step", { step, total: 4, name: t(STEP_NAMES[step - 1]!) })}
    >
      {step === 1 ? <TokenStep token={token} setToken={setToken} next={() => setStep(2)} /> : null}
      {step === 2 ? <AccountStep token={token} back={() => setStep(1)} next={() => setStep(3)} /> : null}
      {step === 3 ? <CommunityStep next={() => setStep(4)} /> : null}
      {step === 4 ? <ChecksStep /> : null}
    </AuthCard>
  );
}

function TokenStep({
  token,
  setToken,
  next,
}: {
  token: string;
  setToken: (v: string) => void;
  next: () => void;
}) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifySetupToken(token.trim());
      next();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "RATE_LIMITED"
          ? t("setup.token.tooMany")
          : err instanceof ApiError && err.code === "PERMISSION_DENIED"
            ? t("setup.token.mismatch")
            : describeError(t, err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      <p className="max-w-prose text-base">{t("setup.token.intro")}</p>
      <Field
        label={t("setup.token.label")}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        autoFocus
        className="font-mono"
      />
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || token.trim().length === 0}>
          {t("setup.next")}
        </Button>
      </div>
    </form>
  );
}

function AccountStep({ token, back, next }: { token: string; back: () => void; next: () => void }) {
  const t = useT();
  const setupCompleted = useSession((s) => s.setupCompleted);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{
    displayName?: string;
    username?: string;
    password?: string;
    form?: string;
  }>({});

  const strength = password ? passwordStrength(password) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next_: typeof errors = {};
    const name = displayName.trim();
    const user = username.trim().toLowerCase();
    if ([...name].length < 1 || [...name].length > 32) next_.displayName = t("field.displayName.invalid");
    if (!USERNAME_RE.test(user)) next_.username = t("field.username.invalid");
    const problem = checkPassword(password);
    if (problem) next_.password = t(`field.password.${problem}` as MessageKey);
    setErrors(next_);
    if (Object.keys(next_).length > 0) return;

    setBusy(true);
    try {
      const res = await api.setup({ token: token.trim(), username: user, displayName: name, password });
      setupCompleted(res.user); // the wizard stays on screen although the server no longer says "setup required"
      next();
    } catch (err) {
      const fields =
        err instanceof ApiError ? (err.details?.fields as Record<string, string> | undefined) : undefined;
      if (fields?.password) setErrors({ password: t(`field.password.${fields.password}` as MessageKey) });
      else setErrors({ form: describeError(t, err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      <p className="max-w-prose text-base">{t("setup.account.intro")}</p>
      <Field
        label={t("setup.account.displayName")}
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        error={errors.displayName}
        autoComplete="nickname"
        autoFocus
      />
      <Field
        label={t("setup.account.username")}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        error={errors.username}
        hint={t("setup.account.usernameHint")}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
      />
      <PasswordField
        label={t("setup.account.password")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        hint={`${t("field.password.hint")}${strength ? ` · ${t(`field.password.strength.${strength}` as MessageKey)}` : ""}`}
        autoComplete="new-password"
      />
      {errors.form ? <Banner tone="error">{errors.form}</Banner> : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={back} disabled={busy}>
          {t("setup.back")}
        </Button>
        <Button type="submit" disabled={busy}>
          {t("setup.account.submit")}
        </Button>
      </div>
    </form>
  );
}

function CommunityStep({ next }: { next: () => void }) {
  const t = useT();
  const current = useSession((s) => s.capabilities?.server.name ?? "");
  const setInstanceName = useSession((s) => s.setInstanceName);
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError(t("field.required"));
    setBusy(true);
    setError(null);
    try {
      if (trimmed !== current) {
        await api.renameInstance(trimmed);
        setInstanceName(trimmed);
      }
      next();
    } catch (err) {
      setError(describeError(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" noValidate>
      <Field
        label={t("setup.community.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint={t("setup.community.hint")}
        maxLength={64}
        autoFocus
      />
      {error ? <Banner tone="error">{error}</Banner> : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {t("setup.next")}
        </Button>
      </div>
    </form>
  );
}

type CheckState = "running" | "ok" | "failed" | "skipped";

function ChecksStep() {
  const t = useT();
  const navigate = useNavigate();
  const setWizardActive = useSession((s) => s.setWizardActive);
  const [https, setHttps] = useState<CheckState>("running");
  const [ws, setWs] = useState<CheckState>("running");

  const run = useCallback(async () => {
    setHttps("running");
    setWs("running");
    setHttps(window.location.protocol === "https:" ? "ok" : "failed");
    setWs((await probeGateway()) ? "ok" : "failed");
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  function finish() {
    setWizardActive(false);
    void navigate("/", { replace: true });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-base">{t("setup.checks.intro")}</p>
      <ul className="flex flex-col gap-2">
        <CheckRow label={t("setup.checks.https")} state={https} />
        <CheckRow label={t("setup.checks.websocket")} state={ws} />
        <CheckRow label={t("setup.checks.voice")} state="skipped" note={t("setup.checks.voiceLater")} />
      </ul>
      {https === "failed" ? <Banner tone="warning">{t("setup.checks.insecure")}</Banner> : null}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={() => void run()}>
          {t("setup.checks.again")}
        </Button>
        <Button onClick={finish}>{t("setup.checks.finish")}</Button>
      </div>
    </div>
  );
}

function CheckRow({ label, state, note }: { label: string; state: CheckState; note?: string }) {
  const t = useT();
  const text = {
    running: t("check.running"),
    ok: t("check.ok"),
    failed: t("check.failed"),
    skipped: t("check.skipped"),
  }[state];
  const Icon = state === "ok" ? CheckCircle2 : state === "failed" ? XCircle : CircleDashed;
  const colour =
    state === "ok" ? "text-success-text" : state === "failed" ? "text-danger-text" : "text-text-muted";
  return (
    <li className="flex items-start gap-2 text-base">
      <Icon aria-hidden="true" size={20} className={`mt-0.5 shrink-0 ${colour}`} />
      <div className="flex flex-col">
        <span>
          {label}: <span className={colour}>{text}</span>
        </span>
        {note ? <span className="text-sm text-text-muted">{note}</span> : null}
      </div>
    </li>
  );
}
