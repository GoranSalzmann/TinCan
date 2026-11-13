// SPDX-License-Identifier: AGPL-3.0-or-later
/* global window, document, AudioContext, MediaStream */
// Called by run.py inside its private PipeWire graph. Real browser devices,
// pairing, CORS, exact getUserMedia capture and AudioContext output routing.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createServer } from "vite";

function fixture(_req, res) {
  res.setHeader("Content-Type", "text/html");
  // Match deployment's COOP: pairing must work without postMessage/opener.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.end(`<!doctype html><html lang="en"><title>Audio helper test</title>
    <button id="connect">Connect helper</button><p id="status">Ready</p>
    <script type="module">
      import * as helper from "/src/core/voice/audio-helper.ts";
      window.helper = helper;
      document.querySelector("#connect").onclick = () => {
        helper.pairHelper(new AbortController().signal).then(
          () => document.querySelector("#status").textContent = "Connected",
          error => document.querySelector("#status").textContent = error.message);
      };
    </script></html>`);
}
const server = await createServer({
  root: "apps/web",
  configFile: "apps/web/vite.config.ts",
  configLoader: "runner",
  cacheDir: process.env.XDG_RUNTIME_DIR + "/vite",
  server: { host: "127.0.0.1", port: 18773, strictPort: true },
  plugins: [
    {
      name: "audio-helper-test",
      configureServer(server) {
        server.middlewares.use("/__helper_test", fixture);
      },
    },
  ],
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("Browser error:", error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Browser console:", message.text());
  });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED")
      console.error("Browser request failed:", request.url(), request.failure());
  });
  await page.goto("http://127.0.0.1:18773/__helper_test");
  await page.waitForFunction(() => !!window.helper);
  const approval = context.waitForEvent("page");
  await page.getByRole("button", { name: "Connect helper" }).click();
  const popup = await approval;
  const approved = popup.waitForResponse((response) => response.url().endsWith("/approve"));
  await popup.getByRole("button", { name: "Connect this site" }).click();
  const result = await approved;
  assert.equal(result.status(), 200, `Local approval failed: ${await result.text()}`);
  await popup.getByText("Connected. You’re all set.", { exact: true }).waitFor();
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector("#status").textContent !== "Ready");
  assert.equal(await page.locator("#status").textContent(), "Connected");
  await popup.close();

  const captured = await page.evaluate(async () => {
    const { helper } = window;
    const before = await navigator.mediaDevices.getUserMedia({ audio: true });
    before.getTracks().forEach((track) => track.stop());
    const playback = new AudioContext({ sampleRate: 48000 });
    await playback.resume();
    // This represents remote conversation playback through Tin Can's context.
    const conversation = playback.createOscillator();
    conversation.frequency.value = 880;
    const gain = playback.createGain();
    gain.gain.value = 0.15;
    conversation.connect(gain).connect(playback.destination);
    conversation.start();
    const selected = (await helper.helperSources()).find((source) => source.name === "Game");
    if (!selected) throw new Error("Game missing from picker");
    window.capture = await helper.captureHelperAudio(
      { sources: [selected.id], names: ["Game"] },
      playback,
      null,
      new AbortController().signal,
      (code) => {
        window.lost = code;
      },
    );
    window.playback = playback;
    const analysis = new AudioContext({ sampleRate: 48000 });
    const source = analysis.createMediaStreamSource(new MediaStream([window.capture.track]));
    const split = analysis.createChannelSplitter(2);
    source.connect(split);
    const taps = [0, 1].map((c) => {
      const node = analysis.createAnalyser();
      node.fftSize = 8192;
      node.smoothingTimeConstant = 0;
      split.connect(node, c);
      const silence = analysis.createGain();
      silence.gain.value = 0;
      node.connect(silence).connect(analysis.destination);
      return node;
    });
    await analysis.resume();
    // Wait for genuine samples, not a fixed connection delay.
    const end = Date.now() + 8000;
    let result;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = taps.map((tap) => {
        const data = new Float32Array(tap.frequencyBinCount);
        tap.getFloatFrequencyData(data);
        return Object.fromEntries(
          [440, 660, 880, 1320].map((freq) => {
            const bin = Math.round((freq * tap.fftSize) / analysis.sampleRate);
            return [freq, Math.max(...data.slice(bin - 1, bin + 2))];
          }),
        );
      });
    } while (Date.now() < end && !(result[0][440] > -35 && result[1][660] > -35));
    await analysis.close();
    return { spectrum: result, settings: window.capture.track.getSettings(), sink: playback.sinkId };
  });
  console.log("Browser capture:", JSON.stringify(captured));
  assert.ok(captured.sink, "Call was not routed to the helper output");
  assert.equal(captured.settings.channelCount, 2);
  assert.ok(captured.spectrum[0][440] > -35 && captured.spectrum[1][660] > -35, "Selected stereo missing");
  assert.ok(captured.spectrum[0][660] < -65 && captured.spectrum[1][440] < -65, "Stereo channels crossed");
  for (const channel of captured.spectrum) {
    assert.ok(
      channel[880] < -65 && channel[1320] < -65,
      "Call or unselected audio leaked through browser capture",
    );
  }
  const restored = await page.evaluate(async () => {
    await window.capture.stop();
    const sink = window.playback.sinkId;
    await window.playback.close();
    return { sink, state: window.capture.track.readyState, lost: window.lost };
  });
  assert.equal(restored.sink, "");
  assert.equal(restored.state, "ended");
  assert.equal(restored.lost, undefined);
  console.log(
    "PASS: browser pairing under COOP, exact stereo input, call routing/isolation, output restoration",
  );
} finally {
  await browser?.close();
  await server.close();
}
