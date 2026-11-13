# Tin Can Audio

A small Rust companion for sharing selected Linux application audio from the
Tin Can PWA. The microphone and Tin Can conversation use separate audio paths.

## Install

Requires Linux x86-64, PipeWire with `pipewire-pulse`, a session manager
(normally WirePlumber), and `pw-dump`, `pw-link`, `pw-loopback` on `PATH`.
Use current Chrome, Chromium or Edge with `AudioContext.setSinkId`.

Extract the download, open a terminal in this folder, and run:

```sh
./tincan-audio doctor
./tincan-audio install
```

This installs into `~/.local/lib/tincan-audio`, adds **Tin Can Audio** to the
application launcher and starts it at desktop login. No root access is needed.
Run the same installer to update; an installed running helper is restarted.

In Tin Can, join a call, choose **Share your screen → Share audio →
Application audio → Connect helper**, confirm the exact site on the local page,
then choose the playing applications. Allow local-network and audio-device
permissions when the browser asks. Select your video in the browser's picker.

Each checkbox selects an existing audio stream. If an app closes/restarts its
stream, restart sharing and select it again. Browser tabs can be grouped by the
browser into one stream. The conversation is routed to a separate virtual output
before capture starts; do not manually rewire these virtual devices.

## Manage

- Open **Tin Can Audio**, or http://127.0.0.1:19477, to disconnect paired sites.
- Diagnostics: `~/.local/lib/tincan-audio/tincan-audio doctor`
- Stop: `~/.local/lib/tincan-audio/tincan-audio stop`
- Uninstall: `~/.local/lib/tincan-audio/tincan-audio uninstall`

Uninstall stops the installed helper and removes its binary, launcher,
autostart entry, logs and saved pairings. Pairings live in
`$XDG_CONFIG_HOME/tincan-audio/sites.json`, logs in
`$XDG_STATE_HOME/tincan-audio/helper.log` (standard XDG fallbacks apply).

PulseAudio-only systems and browsers without output selection are unsupported.
Sandboxed browsers must have access to the desktop's PulseAudio/PipeWire devices
and loopback HTTP. This download is not a Flatpak or a desktop Tin Can app.

## Build and test

```sh
cargo test --locked --manifest-path apps/audio-helper/Cargo.toml
cargo build --locked --release --target x86_64-unknown-linux-musl --manifest-path apps/audio-helper/Cargo.toml
sh scripts/package-audio-helper.sh apps/audio-helper/target/x86_64-unknown-linux-musl/release/tincan-audio apps/web/public/helpers
dbus-run-session -- python3 tools/audio-helper-test/run.py apps/audio-helper/target/x86_64-unknown-linux-musl/release/tincan-audio
```

The integration test runs a private PipeWire graph, sends distinct stereo tones,
measures captured samples, and checks cleanup after stop, tab closure and SIGKILL.
See `docs/audio-helper.md` in the source repository for the protocol and browser QA.

Source and licence: the Tin Can server's **Source code** link, or its source
release archive. Tin Can Audio is AGPL-3.0-or-later; dependency licence texts
are included in `third-party-licenses`.
