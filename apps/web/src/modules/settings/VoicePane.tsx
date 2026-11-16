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
import { NOISE_TIERS, PRESETS, useAudioPrefs, type NoiseTier, type Preset } from "../../core/voice/prefs.js";
import { useVoice } from "../../core/voice/store.js";
import { Banner } from "../../ui/Banner.js";
import { CameraSection } from "./CameraSection.js";
import { Button } from "../../ui/Button.js";
import { Segmented, selectClass } from "../../ui/Controls.js";
import { toast, toastError } from "../../ui/toast.js";
import { FooterNote, Panel, Row, SettingsPage, SettingsSection, SwitchRow } from "./layout.js";

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
      className="h-2 w-full overflow-hidden rounded-sm bg-bg-input"
    >
      <div
        className={`h-full ${level > 0.95 ? "bg-danger" : "bg-speaking"}`}
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
  const [clips, setClips] = useState<{ processed: string; raw: string; tier: NoiseTier } | null>(null);
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
      setClips({ processed, raw, tier: pipeline.tier });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pipeline?.stop();
      setSecs(null);
      setLevel(0);
    }
  };

  return (
    <SettingsSection title={t("voice.pane.micTest")} description={t("voice.pane.micTest.description")}>
      <Panel label={t("voice.pane.micTest")} footer={<FooterNote>{t("voice.pane.micTestNote")}</FooterNote>}>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" disabled={secs !== null} onClick={() => void record()}>
              {secs !== null ? t("voice.pane.recording", { s: secs }) : t("voice.pane.record")}
            </Button>
            <div className="min-w-40 flex-1">
              <Meter level={level} label={t("voice.pane.level")} />
            </div>
          </div>
          {clips ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <span className="flex flex-col gap-1.5 text-sm">
                <span className="meta text-text-muted">{t("voice.pane.playProcessed")}</span>
                <audio controls src={clips.processed} className="h-9 w-full" />
              </span>
              <span className="flex flex-col gap-1.5 text-sm">
                <span className="meta text-text-muted">{t("voice.pane.playRaw")}</span>
                <audio controls src={clips.raw} className="h-9 w-full" />
              </span>
            </div>
          ) : null}
          {clips ? (
            <p className="m-0 text-sm text-text-muted">
              {t("voice.pane.recordedWith", { tier: t(`voice.noise.${clips.tier}` as MessageKey) })}
            </p>
          ) : null}
          {error ? <Banner tone="error">{t("voice.pane.micError", { reason: error })}</Banner> : null}
        </div>
      </Panel>
    </SettingsSection>
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
    <SettingsSection title={t("voice.test.title")} description={t("voice.test.intro")}>
      <Panel
        label={t("voice.test.title")}
        footer={
          <>
            {report.transport ? (
              <FooterNote>
                {report.rttMs !== null ? `Ping ${report.rttMs} ms · ` : ""}
                {t(`voice.transport.${report.transport}` as MessageKey)}
              </FooterNote>
            ) : null}
            {report.summary ? (
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
            ) : null}
            <Button disabled={running} onClick={() => void run()}>
              {started ? t("voice.test.again") : t("voice.test.run")}
            </Button>
          </>
        }
      >
        <ul className="m-0 flex list-none flex-col divide-y divide-border p-0" aria-live="polite">
          {STEP_ORDER.map((id) => (
            <li
              key={id}
              className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 px-5 py-2.5 sm:grid-cols-[2.5rem_minmax(0,16rem)_minmax(0,1fr)]"
            >
              <span aria-hidden="true" className="meta text-text-muted">
                {GLYPH[report.steps[id].state]}
              </span>
              <span className="text-sm">{t(label(id))}</span>
              <span className="meta col-start-2 text-text-muted sm:col-start-3">{detail(id)}</span>
            </li>
          ))}
        </ul>
        {report.summary ? (
          <div className="px-5 py-4">
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
          </div>
        ) : null}
      </Panel>
    </SettingsSection>
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
  const effective = prefs.preset === "custom" ? prefs : { ...prefs, ...PRESETS[prefs.preset] };
  // In a call, what really runs (a tier that failed has stepped down); otherwise what is chosen.
  const tier = useVoice((s) => s.denoiser) ?? effective.noiseTier;

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

  return (
    <SettingsPage title={t("voice.pane.title")} description={t("settings.voice.description")}>
      <SettingsSection title={t("voice.pane.devices")} description={t("voice.pane.devices.description")}>
        <Panel label={t("voice.pane.devices")}>
          <Row
            label={t("voice.pane.input")}
            htmlFor="in-dev"
            control={
              <select
                id="in-dev"
                className={`${selectClass} w-64`}
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
            }
          />
          <Row
            label={t("voice.pane.output")}
            htmlFor="out-dev"
            description={!canSink ? t("voice.pane.outputUnsupported") : undefined}
            control={
              <select
                id="out-dev"
                className={`${selectClass} w-64`}
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
            }
          />
          <Row
            label={t("voice.pane.gain")}
            htmlFor="gain"
            control={
              <>
                <input
                  id="gain"
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={prefs.inputGainDb}
                  onChange={(e) => set({ inputGainDb: Number(e.target.value) })}
                  className="w-48"
                />
                <span className="meta w-12 text-end">
                  {prefs.inputGainDb > 0 ? "+" : ""}
                  {prefs.inputGainDb} dB
                </span>
              </>
            }
          />
          <Row
            label={t("voice.pane.level")}
            control={
              <div className="w-64">
                <Meter level={status === "connected" ? localLevel : 0} label={t("voice.pane.level")} />
              </div>
            }
          />
        </Panel>
        {missing ? <Banner tone="warning">{t("voice.pane.default")}</Banner> : null}
      </SettingsSection>

      <MicTest />

      <SettingsSection title={t("voice.pane.profile")} description={t("voice.pane.profile.description")}>
        <div className="flex flex-col gap-3">
          <div>
            <Segmented
              label={t("voice.pane.profile")}
              name="voice-profile"
              value={prefs.preset}
              options={PRESET_ORDER.map((p) => ({ value: p, label: t(`voice.preset.${p}` as MessageKey) }))}
              onChange={setPreset}
            />
          </div>
          {prefs.preset === "studio" ? (
            <Banner tone="warning">{t("voice.preset.studio.hint")}</Banner>
          ) : (
            <p className="max-w-prose text-sm text-text-muted">
              {t(`voice.preset.${prefs.preset}.hint` as MessageKey)}
            </p>
          )}
        </div>
        <Panel
          label={t("voice.pane.advanced")}
          footer={
            <FooterNote>
              {t("voice.pane.status", { tier: t(`voice.noise.${tier}` as MessageKey) })}
            </FooterNote>
          }
        >
          <div className="meta px-5 pt-3 pb-1 text-text-muted">{t("voice.pane.advanced")}</div>
          <Row
            label={t("voice.pane.noise")}
            htmlFor="noise"
            control={
              <select
                id="noise"
                className={`${selectClass} w-56`}
                value={effective.noiseTier}
                onChange={(e) => setAdvanced({ noiseTier: e.target.value as NoiseTier })}
              >
                {NOISE_TIERS.map((n) => (
                  <option key={n} value={n}>
                    {t(`voice.noise.${n}` as MessageKey)}
                  </option>
                ))}
              </select>
            }
          />
          <SwitchRow
            label={t("voice.pane.gate")}
            checked={effective.noiseGate}
            onChange={(v) => setAdvanced({ noiseGate: v })}
          />
          <SwitchRow
            label={t("voice.pane.echo")}
            checked={effective.echoCancellation}
            onChange={(v) => setAdvanced({ echoCancellation: v })}
          />
          <SwitchRow
            label={t("voice.pane.agc")}
            checked={effective.autoGain}
            onChange={(v) => setAdvanced({ autoGain: v })}
          />
        </Panel>
      </SettingsSection>

      <SettingsSection title={t("voice.pane.transmit")} description={t("voice.pane.transmit.description")}>
        <div>
          <Segmented
            label={t("voice.pane.transmit")}
            name="transmit"
            value={prefs.transmitMode}
            options={(["vad", "ptt"] as const).map((m) => ({
              value: m,
              label: t(`voice.transmit.${m}` as MessageKey),
            }))}
            onChange={(m) => set({ transmitMode: m })}
          />
        </div>
        {prefs.transmitMode === "ptt" ? (
          <Panel label={t("voice.transmit.ptt")}>
            <Row
              label={t("voice.pane.pttKey")}
              control={
                <>
                  <kbd className="meta min-w-12 rounded-sm border border-border-control bg-bg-input px-2.5 py-1 text-center text-sm text-text">
                    {capturing ? t("voice.pane.pttPress") : prefs.pttKey.replace(/^Key|^Digit/, "")}
                  </kbd>
                  <Button variant="ghost" onClick={() => setCapturing(true)}>
                    {t("voice.pane.pttChange")}
                  </Button>
                </>
              }
            />
            <Row
              label={t("voice.pane.pttDelay", { ms: prefs.pttReleaseDelayMs })}
              htmlFor="ptt-delay"
              control={
                <input
                  id="ptt-delay"
                  type="range"
                  min={0}
                  max={500}
                  step={50}
                  value={prefs.pttReleaseDelayMs}
                  onChange={(e) => set({ pttReleaseDelayMs: Number(e.target.value) })}
                  className="w-48"
                />
              }
            />
            <SwitchRow
              label={t("voice.pane.pttCues")}
              checked={prefs.pttCues}
              onChange={(v) => set({ pttCues: v })}
            />
          </Panel>
        ) : null}
        <p className="max-w-prose text-sm text-text-muted">{t("voice.pane.pttWebNote")}</p>
      </SettingsSection>

      <CameraSection />
      <ConnectionTest />
    </SettingsPage>
  );
}
