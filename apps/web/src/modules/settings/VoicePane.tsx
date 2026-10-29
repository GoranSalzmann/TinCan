// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useT, type MessageKey } from "../../core/i18n/index.js";
import {
  diagnosticsText,
  emptyReport,
  runConnectionTest,
  STEP_ORDER,
  type Report,
  type StepId,
} from "../../core/voice/diagnostics.js";
import { useDevices, useSavedDeviceMissing } from "../../core/voice/devices.js";
import { createPipeline, type Pipeline } from "../../core/voice/pipeline.js";
import { PRESETS, useAudioPrefs, type NoiseTier, type Preset } from "../../core/voice/prefs.js";
import { useVoice } from "../../core/voice/store.js";
import { Banner } from "../../ui/Banner.js";
import { CameraSection } from "./CameraSection.js";
import { Button } from "../../ui/Button.js";
import { toast, toastError } from "../../ui/toast.js";

const PRESET_ORDER: Preset[] = ["standard", "aggressive", "natural", "studio", "custom"];
const GLYPH = { wait: "[  ]", run: "[..]", ok: "[ok]", fail: "[!!]", skip: "[--]" } as const;

function Meter({ level, label }: { level: number; label: string }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      className="h-3 w-full max-w-md overflow-hidden rounded bg-bg-input"
    >
      <div
        className={`h-full ${level > 0.95 ? "bg-danger" : "bg-success"}`}
        style={{ width: `${Math.round(level * 100)}%` }}
      />
    </div>
  );
}

/** Records 5 s through the real pipeline, keeps raw and processed copies in memory and plays either back (09 §9). */
function MicTest() {
  const t = useT();
  const prefs = useAudioPrefs((s) => s.prefs);
  const [secs, setSecs] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const [clips, setClips] = useState<{ processed: string; raw: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  const record = async () => {
    setError(null);
    for (const u of urls.current.splice(0)) URL.revokeObjectURL(u);
    setClips(null);
    let pipeline: Pipeline | null = null;
    try {
      pipeline = await createPipeline(prefs);
      const rec = (stream: MediaStream) =>
        new Promise<string>((resolve) => {
          const chunks: BlobPart[] = [];
          const mr = new MediaRecorder(stream);
          mr.ondataavailable = (e) => chunks.push(e.data);
          mr.onstop = () => {
            const url = URL.createObjectURL(new Blob(chunks, { type: mr.mimeType }));
            urls.current.push(url);
            resolve(url);
          };
          mr.start();
          setTimeout(() => mr.stop(), 5000);
        });
      const pending = Promise.all([rec(pipeline.processedStream), rec(pipeline.rawStream)]);
      const buf = new Float32Array(pipeline.analyser.fftSize);
      const start = Date.now();
      const tick = setInterval(() => {
        pipeline?.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        setSecs(Math.max(0, 5 - Math.floor((Date.now() - start) / 1000)));
      }, 100);
      const [processed, raw] = await pending;
      clearInterval(tick);
      setClips({ processed, raw });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pipeline?.stop();
      setSecs(null);
      setLevel(0);
    }
  };

  return (
    <section aria-labelledby="mic-test" className="flex flex-col gap-2">
      <h3 id="mic-test" className="m-0 text-base font-semibold">
        {t("voice.pane.micTest")}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={secs !== null} onClick={() => void record()}>
          {secs !== null ? t("voice.pane.recording", { s: secs }) : t("voice.pane.record")}
        </Button>
        {clips ? (
          <>
            <span className="flex items-center gap-1 text-sm">
              {t("voice.pane.playProcessed")}
              <audio controls src={clips.processed} className="h-8" />
            </span>
            <span className="flex items-center gap-1 text-sm">
              {t("voice.pane.playRaw")}
              <audio controls src={clips.raw} className="h-8" />
            </span>
          </>
        ) : null}
      </div>
      <Meter level={level} label={t("voice.pane.level")} />
      {error ? <Banner tone="error">{t("voice.pane.micError", { reason: error })}</Banner> : null}
      <p className="m-0 text-sm text-text-muted">{t("voice.pane.micTestNote")}</p>
    </section>
  );
}

function ConnectionTest() {
  const t = useT();
  const [report, setReport] = useState<Report>(emptyReport());
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);

  const run = async () => {
    setRunning(true);
    setStarted(true);
    try {
      await runConnectionTest(setReport);
    } catch (e) {
      toastError(e);
    } finally {
      setRunning(false);
    }
  };
  const label = (id: StepId): MessageKey => `voice.test.${id === "server" ? "server" : id}` as MessageKey;
  const detail = (id: StepId) => {
    const s = report.steps[id];
    if (s.state === "wait") return started ? t("voice.test.waiting") : t("voice.test.notRun");
    if (s.state === "run") return t("voice.test.checking");
    if (s.state === "ok") return s.detail ?? t("voice.test.ok");
    if (s.state === "fail")
      return s.detail === "blocked" ? t("voice.test.blocked") : (s.detail ?? t("voice.test.blocked"));
    return s.detail ?? "–";
  };

  return (
    <section aria-labelledby="conn-test" className="flex flex-col gap-3">
      <h3 id="conn-test" className="m-0 text-base font-semibold">
        {t("voice.test.title")}
      </h3>
      <p className="m-0 text-sm text-text-muted">{t("voice.test.intro")}</p>
      <div>
        <Button disabled={running} onClick={() => void run()}>
          {started ? t("voice.test.again") : t("voice.test.run")}
        </Button>
      </div>
      <ul className="m-0 list-none p-0 font-mono text-sm" aria-live="polite">
        {STEP_ORDER.map((id) => (
          <li key={id} className="flex gap-3">
            <span aria-hidden="true">{GLYPH[report.steps[id].state]}</span>
            <span className="w-64">{t(label(id))}</span>
            <span>{detail(id)}</span>
          </li>
        ))}
      </ul>
      {report.transport ? (
        <p className="m-0 text-sm text-text-muted">
          {report.rttMs !== null ? `Ping ${report.rttMs} ms · ` : ""}
          {t(`voice.transport.${report.transport}` as MessageKey)}
        </p>
      ) : null}
      {report.summary ? (
        <Banner
          tone={
            report.summary === "none"
              ? "error"
              : report.summary === "udp" || report.summary === "off"
                ? "success"
                : "warning"
          }
        >
          {t(`voice.test.summary.${report.summary}` as MessageKey)}
        </Banner>
      ) : null}
      {report.summary ? (
        <div>
          <Button
            variant="ghost"
            onClick={() =>
              void navigator.clipboard
                .writeText(diagnosticsText(report))
                .then(() => toast(t("voice.test.copied")))
                .catch(toastError)
            }
          >
            {t("voice.test.copy")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function VoicePane() {
  const t = useT();
  const { prefs, set, setPreset, setAdvanced } = useAudioPrefs();
  const devices = useDevices();
  const missing = useSavedDeviceMissing(devices);
  const status = useVoice((s) => s.status);
  const localLevel = useVoice((s) => s.localLevel);
  const [capturing, setCapturing] = useState(false);
  const canSink = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const tier = useVoice.getState().notice === "denoiser_downgraded" ? "browser" : prefs.noiseTier;
  const effective = prefs.preset === "custom" ? prefs : { ...prefs, ...PRESETS[prefs.preset] };

  // Pressing a key sets the push-to-talk key.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== "Escape") set({ pttKey: e.code });
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, set]);

  const select = "min-h-8 rounded-md border border-border-control bg-bg-input px-2";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h2 className="m-0 text-xl font-semibold">{t("voice.pane.title")}</h2>

      <section className="grid grid-cols-[12rem_1fr] items-center gap-3">
        <label htmlFor="in-dev">{t("voice.pane.input")}</label>
        <select
          id="in-dev"
          className={select}
          value={prefs.inputDeviceId ?? ""}
          onChange={(e) => set({ inputDeviceId: e.target.value || null })}
        >
          <option value="">{t("voice.pane.default")}</option>
          {devices.inputs
            .filter((d) => d.deviceId !== "default")
            .map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || d.deviceId.slice(0, 8)}
              </option>
            ))}
        </select>
        <label htmlFor="out-dev">{t("voice.pane.output")}</label>
        <div className="flex flex-col gap-1">
          <select
            id="out-dev"
            className={select}
            disabled={!canSink}
            value={prefs.outputDeviceId ?? ""}
            onChange={(e) => set({ outputDeviceId: e.target.value || null })}
          >
            <option value="">{t("voice.pane.default")}</option>
            {devices.outputs
              .filter((d) => d.deviceId !== "default")
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId.slice(0, 8)}
                </option>
              ))}
          </select>
          {!canSink ? (
            <span className="text-sm text-text-muted">{t("voice.pane.outputUnsupported")}</span>
          ) : null}
        </div>
        <span>{t("voice.pane.level")}</span>
        <Meter level={status === "connected" ? localLevel : 0} label={t("voice.pane.level")} />
        <label htmlFor="gain">{t("voice.pane.gain")}</label>
        <div className="flex items-center gap-2">
          <input
            id="gain"
            type="range"
            min={-12}
            max={12}
            step={1}
            value={prefs.inputGainDb}
            onChange={(e) => set({ inputGainDb: Number(e.target.value) })}
          />
          <span className="text-sm tabular-nums">
            {prefs.inputGainDb > 0 ? "+" : ""}
            {prefs.inputGainDb} dB
          </span>
        </div>
      </section>
      {missing ? <Banner tone="warning">{t("voice.pane.default")}</Banner> : null}

      <MicTest />

      <section aria-labelledby="profile" className="flex flex-col gap-2">
        <h3 id="profile" className="m-0 text-base font-semibold">
          {t("voice.pane.profile")}
        </h3>
        <div role="radiogroup" aria-labelledby="profile" className="flex flex-wrap gap-2">
          {PRESET_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={prefs.preset === p}
              onClick={() => setPreset(p)}
              className={`rounded-md border px-3 py-1.5 ${prefs.preset === p ? "border-accent bg-bg-selected font-medium" : "border-border-control hover:bg-bg-hover"}`}
            >
              {t(`voice.preset.${p}` as MessageKey)}
            </button>
          ))}
        </div>
        <p className="m-0 text-sm text-text-muted">{t(`voice.preset.${prefs.preset}.hint` as MessageKey)}</p>
        {prefs.preset === "studio" ? <Banner tone="warning">{t("voice.preset.studio.hint")}</Banner> : null}

        <details>
          <summary className="cursor-pointer">{t("voice.pane.advanced")}</summary>
          <div className="mt-3 grid grid-cols-[12rem_1fr] items-center gap-3">
            <label htmlFor="noise">{t("voice.pane.noise")}</label>
            <select
              id="noise"
              className={select}
              value={effective.noiseTier}
              onChange={(e) => setAdvanced({ noiseTier: e.target.value as NoiseTier })}
            >
              {(["rnnoise", "browser", "off"] as const).map((n) => (
                <option key={n} value={n}>
                  {t(`voice.noise.${n}` as MessageKey)}
                </option>
              ))}
            </select>
            <label htmlFor="gate">{t("voice.pane.gate")}</label>
            <input
              id="gate"
              type="checkbox"
              checked={effective.noiseGate}
              onChange={(e) => setAdvanced({ noiseGate: e.target.checked })}
            />
            <label htmlFor="echo">{t("voice.pane.echo")}</label>
            <input
              id="echo"
              type="checkbox"
              checked={effective.echoCancellation}
              onChange={(e) => setAdvanced({ echoCancellation: e.target.checked })}
            />
            <label htmlFor="agc">{t("voice.pane.agc")}</label>
            <input
              id="agc"
              type="checkbox"
              checked={effective.autoGain}
              onChange={(e) => setAdvanced({ autoGain: e.target.checked })}
            />
          </div>
        </details>
      </section>

      <section aria-labelledby="transmit" className="flex flex-col gap-2">
        <h3 id="transmit" className="m-0 text-base font-semibold">
          {t("voice.pane.transmit")}
        </h3>
        <div role="radiogroup" aria-labelledby="transmit" className="flex gap-4">
          {(["vad", "ptt"] as const).map((m) => (
            <label key={m} className="flex items-center gap-2">
              <input
                type="radio"
                name="transmit"
                checked={prefs.transmitMode === m}
                onChange={() => set({ transmitMode: m })}
              />
              {t(`voice.transmit.${m}` as MessageKey)}
            </label>
          ))}
        </div>
        {prefs.transmitMode === "ptt" ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span>{t("voice.pane.pttKey")}</span>
              <kbd className="rounded border border-border-control px-2 py-0.5">
                {capturing ? t("voice.pane.pttPress") : prefs.pttKey.replace(/^Key|^Digit/, "")}
              </kbd>
              <Button variant="ghost" onClick={() => setCapturing(true)}>
                {t("voice.pane.pttChange")}
              </Button>
            </div>
            <label className="flex items-center gap-2">
              {t("voice.pane.pttDelay", { ms: prefs.pttReleaseDelayMs })}
              <input
                type="range"
                min={0}
                max={500}
                step={50}
                value={prefs.pttReleaseDelayMs}
                onChange={(e) => set({ pttReleaseDelayMs: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={prefs.pttCues}
                onChange={(e) => set({ pttCues: e.target.checked })}
              />
              {t("voice.pane.pttCues")}
            </label>
          </div>
        ) : null}
        <p className="m-0 text-sm text-text-muted">{t("voice.pane.pttWebNote")}</p>
      </section>

      <p className="m-0 text-sm text-text-muted">
        {t("voice.pane.status", { tier: t(`voice.noise.${tier}` as MessageKey) })}
      </p>
      <CameraSection />
      <ConnectionTest />
    </div>
  );
}
