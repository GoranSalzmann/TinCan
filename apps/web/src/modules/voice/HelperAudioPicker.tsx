// SPDX-License-Identifier: AGPL-3.0-or-later
import { Check, Copy, Download, ExternalLink, LoaderCircle, Music2, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../core/i18n/index.js";
import {
  checkHelper,
  hasHelperToken,
  helperErrorCode,
  helperSources,
  HELPER_URL,
  pairHelper,
  supportsHelperAudio,
  type HelperErrorCode,
  type HelperSelection,
  type HelperSource,
} from "../../core/voice/audio-helper.js";
import { Button } from "../../ui/Button.js";

export function HelperErrorMessage({ code }: { code: HelperErrorCode }) {
  const t = useT();
  return (
    <p role="alert" className="m-0 text-sm text-danger-text">
      {t(`voice.helper.error.${code}`)}
    </p>
  );
}

export function HelperAudioPicker({
  onChange,
  disabled = false,
}: {
  onChange: (selection: HelperSelection | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [status, setStatus] = useState<"checking" | "offline" | "pair" | "pairing" | "ready">("checking");
  const [error, setError] = useState<HelperErrorCode | null>(null);
  const [sources, setSources] = useState<HelperSource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const pairing = useRef<AbortController | null>(null);
  const supported = supportsHelperAudio();
  const command = `curl -fsSL '${location.origin}/helpers/install.sh' | sh -s -- '${location.origin}/helpers'`;

  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    if (!supported) return;
    const refresh = async (initial: boolean) => {
      try {
        if (initial) {
          setStatus("checking");
          setError(null);
          await checkHelper(abort.signal);
        }
        if (!hasHelperToken()) {
          if (!abort.signal.aborted) setStatus("pair");
          return;
        }
        const next = await helperSources(abort.signal);
        if (abort.signal.aborted) return;
        setSources(next);
        setStatus("ready");
        setError(null);
        failures = 0;
        timer = setTimeout(() => void refresh(false), 3000);
      } catch (err) {
        if (abort.signal.aborted) return;
        const code = helperErrorCode(err);
        // Transient failures keep polling in the background; only the third
        // consecutive one drops the picker offline. Pairing and the initial
        // load still surface immediately.
        if (!initial && code !== "not_paired" && ++failures < 3) {
          timer = setTimeout(() => void refresh(false), 3000);
          return;
        }
        setError(code);
        setStatus(code === "not_paired" ? "pair" : "offline");
      }
    };
    void refresh(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [attempt, supported]);

  useEffect(
    () => () => {
      pairing.current?.abort();
    },
    [],
  );
  const missing = selected.some((id) => !sources.some((s) => s.id === id));
  useEffect(() => {
    onChange(
      status === "ready" && selected.length > 0 && !missing
        ? {
            sources: selected,
            names: [...new Set(sources.filter((s) => selected.includes(s.id)).map((s) => s.name))],
          }
        : null,
    );
  }, [status, selected, sources, missing, onChange]);

  const connect = async () => {
    pairing.current?.abort();
    const abort = new AbortController();
    pairing.current = abort;
    setStatus("pairing");
    setError(null);
    try {
      await pairHelper(abort.signal);
      if (!abort.signal.aborted) setAttempt((n) => n + 1);
    } catch (err) {
      if (abort.signal.aborted) return;
      setError(helperErrorCode(err));
      setStatus("pair");
    }
  };

  const visible = sources.filter((s) =>
    `${s.name} ${s.detail}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <fieldset
      disabled={disabled}
      aria-label={t("voice.helper.title")}
      className="m-0 min-w-0 flex flex-col gap-3 rounded-lg border border-border bg-bg-sidebar p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium" role="status">
        {supported && (status === "checking" || status === "pairing") ? (
          <LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        ) : status === "ready" ? (
          <Check size={16} aria-hidden="true" className="text-success-text" />
        ) : (
          <Music2 size={16} aria-hidden="true" />
        )}
        {t(`voice.helper.status.${supported ? status : "unsupported"}`)}
      </div>
      {!supported ? (
        <HelperErrorMessage code="browser_unsupported" />
      ) : (
        <>
          {error && error !== "not_paired" ? <HelperErrorMessage code={error} /> : null}
          {status === "offline" ? (
            <>
              <p className="m-0 text-sm text-text-muted">{t("voice.helper.installHint")}</p>
              <a
                href="/helpers/tincan-audio-linux-amd64.tar.gz"
                download
                className="inline-flex items-center gap-2 self-start rounded-md px-2 py-1 text-sm text-link hover:underline"
              >
                <Download size={16} aria-hidden="true" />
                {t("voice.helper.download")}
              </a>
              <p className="m-0 text-xs text-text-muted">{t("voice.helper.downloadHint")}</p>
              <details className="text-sm">
                <summary className="cursor-pointer rounded py-1">{t("voice.helper.installTerminal")}</summary>
                <p className="my-2 text-text-muted">{t("voice.helper.installDescription")}</p>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 select-all break-all rounded bg-bg-input p-2 text-xs">
                    {command}
                  </code>
                  <Button
                    variant="ghost"
                    aria-label={t("voice.helper.copy")}
                    onClick={() => {
                      void (
                        navigator.clipboard?.writeText(command) ??
                        Promise.reject(new Error("Clipboard unavailable"))
                      )
                        .then(() => {
                          setCopied(true);
                          setCopyFailed(false);
                        })
                        .catch(() => setCopyFailed(true));
                    }}
                  >
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {t(copied ? "voice.helper.copied" : "voice.helper.copy")}
                  </Button>
                </div>
                {copyFailed ? <p role="status">{t("voice.helper.copyManual")}</p> : null}
              </details>
              <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCw size={16} aria-hidden="true" />
                {t("voice.helper.retry")}
              </Button>
            </>
          ) : null}
          {status === "pair" ? (
            <>
              <p className="m-0 text-sm text-text-muted">{t("voice.helper.pairHint")}</p>
              <Button onClick={() => void connect()}>
                <ExternalLink size={16} aria-hidden="true" />
                {t("voice.helper.connect")}
              </Button>
            </>
          ) : null}
          {status === "pairing" ? (
            <>
              <p className="m-0 text-sm text-text-muted">{t("voice.helper.pairingHint")}</p>
              <Button
                variant="ghost"
                onClick={() => {
                  pairing.current?.abort();
                  setStatus("pair");
                }}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : null}
          {status === "ready" ? (
            <>
              <p className="m-0 text-sm text-text-muted">{t("voice.helper.chooseHint")}</p>
              {sources.length > 5 ? (
                <label className="flex items-center gap-2 rounded-md border border-border-control bg-bg-input px-2">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label={t("voice.helper.search")}
                    placeholder={t("voice.helper.search")}
                    className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
                  />
                </label>
              ) : null}
              <div className="max-h-48 overflow-y-auto overscroll-contain rounded-md border border-border">
                {visible.length === 0 ? (
                  <p className="m-0 p-4 text-sm text-text-muted" role="status">
                    {t(sources.length === 0 ? "voice.helper.empty" : "voice.helper.noMatches")}
                  </p>
                ) : (
                  visible.map((source) => (
                    <label
                      key={source.id}
                      className={`flex cursor-pointer items-center gap-3 border-b border-border p-3 last:border-b-0 hover:bg-bg-hover ${selected.includes(source.id) ? "bg-bg-hover" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(source.id)}
                        disabled={!selected.includes(source.id) && selected.length >= 32}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked ? [...prev, source.id] : prev.filter((id) => id !== source.id),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          <bdi>{source.name}</bdi>
                        </span>
                        {source.detail ? (
                          <span className="block truncate text-xs text-text-muted">
                            <bdi>{source.detail}</bdi>
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t(source.running ? "voice.helper.playing" : "voice.helper.idle")}
                      </span>
                    </label>
                  ))
                )}
              </div>
              {missing ? (
                <div className="flex flex-col gap-2">
                  <p role="status" className="m-0 text-sm text-warning-text">
                    {t("voice.helper.selectionGone")}
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() => setSelected((ids) => ids.filter((id) => sources.some((s) => s.id === id)))}
                  >
                    {t("voice.helper.clearMissing")}
                  </Button>
                </div>
              ) : (
                <p role="status" className="m-0 text-xs text-text-muted">
                  {t("voice.helper.selected", { count: selected.length })}
                </p>
              )}
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-text-muted">{t("voice.helper.callExcluded")}</span>
                <a href={HELPER_URL} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  {t("voice.helper.manage")}
                </a>
              </div>
            </>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
