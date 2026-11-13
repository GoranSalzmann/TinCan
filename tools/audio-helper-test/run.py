#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Real, isolated PipeWire/HTTP test. Run under dbus-run-session; no host audio is changed."""
import array
from functools import partial
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import wave

BASE = "http://127.0.0.1:19477"
ORIGIN = "https://tincan.example"
BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else "apps/audio-helper/target/debug/tincan-audio").resolve()
children = []
token = ""

class Downloads(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def wait_for(check, message):
    end = time.monotonic() + 10
    while time.monotonic() < end:
        try:
            result = check()
            if result:
                return result
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise AssertionError(message)


def spawn(*args):
    p = subprocess.Popen(args, stdout=log, stderr=log)
    children.append(p)
    return p


def stop(p):
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()


def api(path, body=None, method=None, origin=ORIGIN):
    req = urllib.request.Request(BASE + path, method=method, headers={
        "Origin": origin, "Authorization": "Bearer " + token, "Content-Type": "application/json",
    }, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.load(response)


def objects():
    return json.loads(subprocess.check_output(["pw-dump"], timeout=4))


def prop(obj, name):
    return obj.get("info", {}).get("props", {}).get(name, "")


def helper_nodes():
    return [o for o in objects() if o["type"].endswith(":Node") and str(prop(o, "node.name")).startswith("tincan.audio.")]


def tone(name, target, left, right):
    path = root / (name + ".wav")
    # 60s gives the full lifecycle checks time without an app naturally ending.
    one_second = array.array("h", (int(5000 * math.sin(2 * math.pi * freq * i / 48000))
                                 for i in range(48000) for freq in [left, right]))
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(one_second.tobytes() * 60)
    return spawn("pw-play", "--target", target, "--properties",
                 json.dumps({"application.name": name, "node.name": name}), str(path))


def create():
    desc = api("/v1/session", {"outputLabel": "Test Output"})
    wait_for(lambda: len(helper_nodes()) == 4, "helper virtual devices never appeared")
    conn = http.client.HTTPConnection("127.0.0.1", 19477, timeout=5)
    conn.request("GET", f'/v1/session/{desc["id"]}/watch', headers={
        "Origin": ORIGIN, "Authorization": "Bearer " + token,
    })
    response = conn.getresponse()
    assert response.status == 200
    assert not json.loads(response.readline()).get("error")
    return desc, conn, response


def amplitudes(path):
    data = array.array("h")
    with wave.open(str(path), "rb") as wav:
        assert wav.getnchannels() == 2 and wav.getframerate() == 48000
        data.frombytes(wav.readframes(wav.getnframes()))
    # Take one second well after startup, with integral periods for each tone.
    assert len(data) >= 2 * 48000 * 2, f"Not enough captured audio: {len(data)} samples"
    channels = [[x / 32768 for x in data[-96000 + c::2]] for c in [0, 1]]
    def amplitude(samples, freq):
        re_part = sum(x * math.cos(2 * math.pi * freq * i / 48000) for i, x in enumerate(samples))
        im_part = sum(x * math.sin(2 * math.pi * freq * i / 48000) for i, x in enumerate(samples))
        return 2 * math.hypot(re_part, im_part) / len(samples)
    return [{f: amplitude(c, f) for f in [440, 660, 880, 1320]} for c in channels]


with socket.socket() as probe:
    try:
        probe.bind(("127.0.0.1", 19477))
    except OSError:
        sys.exit("Port 19477 is in use; stop your audio helper before running this isolated test.")

temp_base = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
with tempfile.TemporaryDirectory(prefix="tincan-audio-test-", dir=temp_base) as tmp:
    root = Path(tmp)
    os.environ.update(XDG_RUNTIME_DIR=tmp, XDG_CONFIG_HOME=str(root / "config"),
                      XDG_STATE_HOME=str(root / "state"), PIPEWIRE_REMOTE="pipewire-0")
    os.environ.pop("PIPEWIRE_RUNTIME_DIR", None)
    # Disable host hardware discovery: even though this is a private graph,
    # opening ALSA devices could disturb a running desktop audio session.
    config = root / "config/wireplumber/wireplumber.conf.d"
    config.mkdir(parents=True)
    (config / "test.conf").write_text('wireplumber.profiles = { main = { monitor.alsa = disabled monitor.bluez = disabled } }\n')
    legacy = config.parent / "main.lua.d"
    legacy.mkdir()
    (legacy / "99-test.lua").write_text("alsa_monitor.enabled = false\n")
    with (root / "test.log").open("w+") as log:
        try:
            spawn("pipewire")
            wait_for(lambda: (root / "pipewire-0").exists(), "PipeWire socket missing")
            spawn("wireplumber")
            subprocess.run(["pw-cli", "create-node", "adapter",
                            '{ factory.name=support.null-audio-sink node.name=test-output node.description="Test Output" media.class=Audio/Sink object.linger=true audio.position=[FL FR] }'],
                           check=True, stdout=log, stderr=log)
            wait_for(lambda: any(prop(o, "node.name") == "test-output" for o in objects()), "Test output missing")
            helper = spawn(str(BINARY), "serve")
            wait_for(lambda: api("/v1/status")["protocol"] == 1, "Helper not reachable")
            challenge = "a" * 64
            url = BASE + "/connect?" + urllib.parse.urlencode({"origin": ORIGIN, "challenge": challenge})
            with urllib.request.urlopen(url) as r:
                page = r.read().decode()
            csrf = re.search(r'name="csrf" value="([a-f0-9]+)"', page)[1]
            with urllib.request.urlopen(BASE + "/approve", data=urllib.parse.urlencode({
                "challenge": challenge, "csrf": csrf,
            }).encode()) as r:
                assert "all set" in r.read().decode()
            token = api("/v1/pair", {"challenge": challenge})["token"]
            assert (root / "config/tincan-audio/sites.json").stat().st_mode & 0o777 == 0o600

            game = tone("Game", "test-output", 440, 660)
            tone("Unselected", "test-output", 1320, 1320)
            wait_for(lambda: len(api("/v1/sources")["sources"]) >= 2, "Playback streams missing")
            desc, conn, watch = create()
            suffix = desc["id"][:8]
            call = tone("Conversation", "tincan.audio.call." + suffix, 880, 880)
            wait_for(lambda: any(prop(o, "application.name") == "Conversation" for o in objects()), "Call missing")
            # The watch list and /start both enforce conversation exclusion.
            selected = next(s["id"] for s in api("/v1/sources")["sources"] if s["name"] == "Game")
            call_id = next(s["id"] for s in api("/v1/sources")["sources"] if s["name"] == "Conversation")
            try:
                api(f'/v1/session/{desc["id"]}/start', {"sources": [selected, call_id]})
                raise AssertionError("Call stream was accepted")
            except urllib.error.HTTPError as e:
                assert json.load(e)["error"] == "source_missing"
            api(f'/v1/session/{desc["id"]}/start', {"sources": [selected]})
            capture = root / "capture.wav"
            recorder = spawn("pw-record", "--format=s16", "--rate=48000", "--channels=2",
                             "--target=tincan.audio.source." + suffix, str(capture))
            time.sleep(3)
            stop(recorder)
            result = amplitudes(capture)
            print("Captured stereo amplitudes (440 L, 660 R, 880 call, 1320 unselected):", result)
            assert result[0][440] > 0.08 and result[1][660] > 0.08, "Selected audio missing"
            assert result[0][660] < 0.001 and result[1][440] < 0.001, "Stereo channels crossed"
            assert all(c[f] < 0.001 for c in result for f in [880, 1320]), "Unselected/call audio leaked"
            api(f'/v1/session/{desc["id"]}', method="DELETE")
            watch.close()
            conn.close()
            wait_for(lambda: not helper_nodes(), "DELETE leaked helper nodes")
            stop(call)

            desc, conn, watch = create()
            # Simulate a tab's streaming connection being abruptly closed.
            conn.sock.shutdown(socket.SHUT_RDWR)
            watch.close()
            conn.close()
            wait_for(lambda: not helper_nodes(), "Closing the watch leaked helper nodes")

            if os.environ.get("AUDIO_HELPER_BROWSER"):
                subprocess.run(["pw-cli", "create-node", "adapter",
                                '{ factory.name=support.null-audio-sink node.name=test-mic node.description="Test Microphone" media.class=Audio/Source object.linger=true audio.position=[FL FR] priority.session=1000 }'],
                               check=True, stdout=log, stderr=log)
                spawn("pipewire-pulse")
                wait_for(lambda: (root / "pulse/native").exists(), "Private PulseAudio socket missing")
                os.environ["PULSE_SERVER"] = "unix:" + str(root / "pulse/native")
                subprocess.run(["node", "tools/audio-helper-test/browser.mjs"], check=True, timeout=90)
                wait_for(lambda: not helper_nodes(), "Browser cleanup leaked helper nodes")

            desc, conn, watch = create()
            helper.kill()
            helper.wait()
            watch.close()
            conn.close()
            wait_for(lambda: not helper_nodes(), "SIGKILL leaked pw-loopback children/devices")
            install_env = {**os.environ, "HOME": str(root / "home"), "XDG_DATA_HOME": str(root / "data")}
            installed = root / "home/.local/lib/tincan-audio/tincan-audio"
            downloads = None
            install = [str(BINARY), "install"]
            package = os.environ.get("AUDIO_HELPER_PACKAGE")
            if package:
                assert (Path(package) / "tincan-audio-linux-amd64.tar.gz").is_file()
                downloads = ThreadingHTTPServer(("127.0.0.1", 0), partial(Downloads, directory=package))
                threading.Thread(target=downloads.serve_forever, daemon=True).start()
                install = ["sh", "apps/web/public/helpers/install.sh",
                           f"http://127.0.0.1:{downloads.server_port}"]
            try:
                subprocess.run(install, env=install_env, check=True, stdout=log, stderr=log)
                wait_for(lambda: api("/v1/status")["protocol"] == 1, "Installed helper did not start")
                assert (root / "config/autostart/tincan-audio.desktop").exists()
                assert (root / "data/applications/tincan-audio.desktop").exists()
                # An update replaces the running executable and restarts it.
                old_pid = (root / "state/tincan-audio/helper.pid").read_text()
                subprocess.run(install, env=install_env, check=True, stdout=log, stderr=log)
                wait_for(lambda: api("/v1/status")["protocol"] == 1, "Updated helper did not restart")
                assert (root / "state/tincan-audio/helper.pid").read_text() != old_pid
                subprocess.run([str(installed), "uninstall"], env=install_env, check=True, stdout=log, stderr=log)
                assert not installed.exists()
                assert not (root / "config/tincan-audio").exists()
                assert not (root / "config/autostart/tincan-audio.desktop").exists()
                assert not (root / "data/applications/tincan-audio.desktop").exists()
            finally:
                if downloads:
                    downloads.shutdown()
                    downloads.server_close()
                if installed.exists():
                    subprocess.run([str(installed), "uninstall"], env=install_env, stdout=log, stderr=log)
            print("PASS: pairing, stereo isolation, call exclusion, stop, tab close, SIGKILL, install/update/uninstall")
        except BaseException as error:
            if isinstance(error, urllib.error.HTTPError):
                print("HTTP:", error.read().decode(), file=sys.stderr)
            print(json.dumps([{"id": o["id"], "type": o["type"].split(":")[-1],
                               "name": prop(o, "node.name"), "target": prop(o, "target.object"),
                               "from": prop(o, "link.output.node"), "to": prop(o, "link.input.node")}
                              for o in objects() if o["type"].endswith((":Node", ":Link"))]), file=sys.stderr)
            log.flush()
            print((root / "test.log").read_text()[-10000:], file=sys.stderr)
            raise
        finally:
            for child in reversed(children):
                stop(child)
