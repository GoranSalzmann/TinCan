// SPDX-License-Identifier: AGPL-3.0-or-later
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    time::Duration,
};
use tokio::process::{Child, Command};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Object {
    pub id: u64,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub info: Value,
    #[serde(default)]
    pub metadata: Vec<Value>,
}

impl Object {
    pub fn prop(&self, key: &str) -> String {
        text(&self.info["props"][key])
    }
}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub running: bool,
}

async fn tool(name: &str, args: &[&str]) -> Result<Vec<u8>> {
    let output = tokio::time::timeout(
        Duration::from_secs(4),
        command(name)
            .args(args)
            .kill_on_drop(true)
            .stderr(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "pipewire_unavailable")?
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "pipewire_missing"
        } else {
            "pipewire_unavailable"
        }
    })?;
    if !output.status.success() {
        return Err("pipewire_unavailable");
    }
    Ok(output.stdout)
}

fn command(name: &str) -> Command {
    let mut command = Command::new(name);
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: pre_exec runs after fork. Only async-signal-safe syscalls are
    // used; no allocation or locks. PDEATHSIG also covers SIGKILL/crashes,
    // where Rust destructors and kill_on_drop cannot run.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ECHILD));
            }
            Ok(())
        });
    }
    command
}

pub async fn snapshot() -> Result<Vec<Object>> {
    serde_json::from_slice(&tool("pw-dump", &[]).await?).map_err(|_| "pipewire_unavailable")
}

pub async fn check() -> Result<()> {
    for name in ["pw-loopback", "pw-link"] {
        tool(name, &["--version"]).await?;
    }
    snapshot().await?;
    Ok(())
}

fn ours(o: &Object) -> bool {
    o.prop("node.name").starts_with("tincan.audio.")
        || o.prop("application.name") == "Tin Can Audio"
}

fn protected_nodes(objects: &[Object], sink_name: &str) -> HashSet<u64> {
    let sink = objects
        .iter()
        .find(|o| o.kind.ends_with(":Node") && o.prop("node.name") == sink_name);
    let Some(sink) = sink else {
        return HashSet::new();
    };
    let serial = sink.prop("object.serial");
    let mut blocked = HashSet::new();
    for o in objects {
        if o.kind.ends_with(":Link") && o.prop("link.input.node") == sink.id.to_string() {
            if let Ok(id) = o.prop("link.output.node").parse() {
                blocked.insert(id);
            }
        }
        let target = o.prop("target.object");
        if target == sink_name || (!serial.is_empty() && target == serial) {
            blocked.insert(o.id);
        }
    }
    blocked
}

pub fn sources(objects: &[Object], sink_name: &str) -> Vec<Source> {
    let blocked = protected_nodes(objects, sink_name);
    let mut out = Vec::new();
    for o in objects {
        if !o.kind.ends_with(":Node")
            || o.prop("media.class") != "Stream/Output/Audio"
            || ours(o)
            || blocked.contains(&o.id)
        {
            continue;
        }
        let name = ["application.name", "node.description", "node.name"]
            .iter()
            .map(|key| o.prop(key))
            .find(|s| !s.is_empty())
            .unwrap_or_default();
        let id = o.prop("object.serial");
        if name.is_empty() || id.is_empty() {
            continue;
        }
        let mut detail = o.prop("media.name");
        if detail == name || detail == "Playback" {
            detail.clear();
        }
        out.push(Source {
            id,
            name,
            detail,
            running: o.info["state"] == "running",
        });
    }
    out.sort_by_key(|s| (!s.running, s.name.to_lowercase(), s.id.clone()));
    out
}

fn output_target(objects: &[Object], label: &str) -> Result<String> {
    let default_name = objects
        .iter()
        .flat_map(|o| &o.metadata)
        .filter(|m| m["key"] == "default.audio.sink")
        .filter_map(|m| serde_json::from_str::<Value>(&text(&m["value"])).ok())
        .map(|v| text(&v["name"]))
        .next()
        .unwrap_or_default();
    objects
        .iter()
        .find(|o| {
            o.prop("media.class") == "Audio/Sink"
                && !ours(o)
                && if label.is_empty() {
                    o.prop("node.name") == default_name
                } else {
                    o.prop("node.description") == label
                }
        })
        .map(|o| o.prop("object.serial"))
        .ok_or("output_missing")
}

// Registry IDs are reusable. The browser selects object.serial, so a terminated
// app can never silently turn into another app's audio after an ID gets reused.
pub struct Session {
    pub id: String,
    pub source_label: String,
    pub output_label: String,
    pub owner: String,
    pub watching: bool,
    pub sink_name: String,
    capture_name: String,
    output_serial: String,
    default_output: bool,
    children: Vec<Child>,
    selected: Vec<String>,
    active: bool,
    links: HashSet<(u64, u64)>,
}

fn loopback(mut capture: Value, mut playback: Value) -> Result<Child> {
    capture["application.name"] = json!("Tin Can Audio");
    playback["application.name"] = json!("Tin Can Audio");
    command("pw-loopback")
        .args([
            "--channels=2",
            "--latency=20",
            &format!("--capture-props={capture}"),
            &format!("--playback-props={playback}"),
        ])
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|_| "pipewire_missing")
}

impl Session {
    pub async fn new(owner: String, output_label: &str) -> Result<Self> {
        let id = crate::secret();
        let suffix = &id[..8];
        let source_label = format!("Tin Can Stream {suffix}");
        let output_label_for_browser = format!("Tin Can Call {suffix}");
        let capture_name = format!("tincan.audio.capture.{suffix}");
        let sink_name = format!("tincan.audio.call.{suffix}");
        let output_serial = output_target(&snapshot().await?, output_label)?;
        let mut children = Vec::new();
        // The input has NO automatic links: neither a microphone nor a system
        // monitor can accidentally become the shared source.
        children.push(loopback(
            json!({
                "node.name": capture_name, "node.autoconnect": false,
                "node.dont-reconnect": true, "stream.dont-remix": true,
                "audio.position": ["FL", "FR"]
            }),
            json!({
                "node.name": format!("tincan.audio.source.{suffix}"),
                "node.description": source_label, "media.class": "Audio/Source",
                "node.virtual": true, "priority.session": -1,
                "node.autoconnect": false, "audio.position": ["FL", "FR"]
            }),
        )?);
        // The PWA routes the call's AudioContext here before enabling capture.
        // The user still hears the call on their selected physical output.
        children.push(loopback(
            json!({
                "node.name": sink_name, "node.description": output_label_for_browser,
                "media.class": "Audio/Sink", "node.virtual": true,
                "priority.session": -1, "audio.position": ["FL", "FR"]
            }),
            json!({
                "node.name": format!("tincan.audio.listen.{suffix}"),
                "target.object": output_serial, "node.dont-reconnect": true,
                "node.passive": true, "audio.position": ["FL", "FR"]
            }),
        )?);
        Ok(Self {
            id,
            owner,
            source_label,
            output_label: output_label_for_browser,
            watching: false,
            capture_name,
            sink_name,
            output_serial,
            default_output: output_label.is_empty(),
            children,
            selected: Vec::new(),
            active: false,
            links: HashSet::new(),
        })
    }

    pub fn description(&self) -> Value {
        json!({"id": self.id, "sourceLabel": self.source_label, "outputLabel": self.output_label})
    }

    pub async fn start(&mut self, selected: Vec<String>, objects: &[Object]) -> Result<()> {
        if !self.watching {
            return Err("session_lost");
        }
        if selected.is_empty() || selected.len() > 32 {
            return Err("select_application");
        }
        let available = sources(objects, &self.sink_name);
        if selected
            .iter()
            .any(|id| !available.iter().any(|s| &s.id == id))
        {
            return Err("source_missing");
        }
        self.selected = selected;
        self.active = true;
        self.update(objects).await?;
        if self.links.is_empty() {
            return Err("source_missing");
        }
        Ok(())
    }

    pub async fn update(&mut self, objects: &[Object]) -> Result<()> {
        for child in &mut self.children {
            if child.try_wait().map_err(|_| "capture_failed")?.is_some() {
                return Err("capture_failed");
            }
        }
        if !self.active {
            return Ok(());
        }
        if self.default_output && output_target(objects, "")? != self.output_serial {
            return Err("output_missing");
        }
        if !objects
            .iter()
            .any(|o| o.prop("object.serial") == self.output_serial)
            || !objects
                .iter()
                .any(|o| o.prop("node.name") == self.capture_name)
            || !objects
                .iter()
                .any(|o| o.prop("node.name") == self.sink_name)
        {
            return Err("output_missing");
        }
        let want = desired_links(objects, &self.capture_name, &self.sink_name, &self.selected);
        for (a, b) in self.links.difference(&want) {
            let _ = tool("pw-link", &["--disconnect", &a.to_string(), &b.to_string()]).await;
        }
        // A stream can vanish between snapshot and link; skip failed connects
        // so they are retried on the next tick instead of ending the session.
        let mut linked: HashSet<(u64, u64)> = self.links.intersection(&want).copied().collect();
        for (a, b) in want.difference(&self.links) {
            if tool("pw-link", &[&a.to_string(), &b.to_string()])
                .await
                .is_ok()
            {
                linked.insert((*a, *b));
            }
        }
        self.links = linked;
        Ok(())
    }

    pub async fn close(mut self) {
        for child in &mut self.children {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

fn desired_links(
    objects: &[Object],
    capture_name: &str,
    sink_name: &str,
    selected: &[String],
) -> HashSet<(u64, u64)> {
    let mut nodes = HashMap::new();
    let mut ports: HashMap<u64, Vec<&Object>> = HashMap::new();
    let mut capture_id = u64::MAX;
    let blocked = protected_nodes(objects, sink_name);
    for o in objects {
        if o.kind.ends_with(":Node") {
            nodes.insert(o.id, o);
            if o.prop("node.name") == capture_name {
                capture_id = o.id;
            }
        } else if o.kind.ends_with(":Port") {
            if let Ok(id) = o.prop("node.id").parse() {
                ports.entry(id).or_default().push(o);
            }
        }
    }
    let mut out = HashSet::new();
    for (id, node) in nodes {
        if !selected.contains(&node.prop("object.serial"))
            || blocked.contains(&id)
            || ours(node)
            || node.prop("media.class") != "Stream/Output/Audio"
        {
            continue;
        }
        for from in ports.get(&id).into_iter().flatten() {
            if from.info["direction"] != "output" {
                continue;
            }
            let channel = from.prop("audio.channel");
            for to in ports.get(&capture_id).into_iter().flatten() {
                if to.info["direction"] == "input"
                    && (channel == to.prop("audio.channel") || channel == "MONO")
                {
                    out.insert((from.id, to.id));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(id: u64, kind: &str, props: Value) -> Object {
        serde_json::from_value(json!({
            "id": id, "type": format!("PipeWire:Interface:{kind}"), "info": {"props": props}
        }))
        .unwrap()
    }

    fn graph() -> Vec<Object> {
        let mut objects = vec![
            object(
                1,
                "Node",
                json!({"object.serial": 100, "media.class": "Stream/Output/Audio", "application.name": "Game"}),
            ),
            object(
                2,
                "Node",
                json!({"object.serial": 200, "media.class": "Stream/Output/Audio", "application.name": "Browser"}),
            ),
            object(
                3,
                "Node",
                json!({"object.serial": 300, "media.class": "Audio/Source", "node.name": "microphone"}),
            ),
            object(
                4,
                "Node",
                json!({"node.name": "tincan.audio.call.test", "object.serial": 400}),
            ),
            object(5, "Node", json!({"node.name": "tincan.audio.capture.test"})),
            object(
                6,
                "Link",
                json!({"link.output.node": 2, "link.input.node": 4}),
            ),
        ];
        for (id, node, direction, channel) in [
            (11, 1, "output", "FL"),
            (12, 1, "output", "FR"),
            (21, 2, "output", "FL"),
            (22, 2, "output", "FR"),
            (51, 5, "input", "FL"),
            (52, 5, "input", "FR"),
        ] {
            let mut port = object(
                id,
                "Port",
                json!({"node.id": node, "audio.channel": channel}),
            );
            port.info["direction"] = json!(direction);
            objects.push(port);
        }
        objects
    }

    #[test]
    fn excludes_call_microphone_and_helper_even_when_explicitly_selected() {
        let objects = graph();
        assert_eq!(
            sources(&objects, "tincan.audio.call.test")
                .iter()
                .map(|s| &s.name)
                .collect::<Vec<_>>(),
            vec!["Game"]
        );
        assert_eq!(
            desired_links(
                &objects,
                "tincan.audio.capture.test",
                "tincan.audio.call.test",
                &["100".into(), "200".into(), "300".into(), "400".into()]
            ),
            HashSet::from([(11, 51), (12, 52)])
        );
    }

    #[test]
    fn reused_node_id_cannot_select_a_different_application() {
        let mut objects = graph();
        objects[0].info["props"]["object.serial"] = json!(999);
        assert!(
            desired_links(&objects, "tincan.audio.capture.test", "", &["100".into()]).is_empty()
        );
    }

    #[test]
    fn protects_call_before_its_link_exists_and_duplicates_mono_to_stereo() {
        let mut objects = graph();
        objects.retain(|o| o.id != 6 && o.id != 12);
        objects[1].info["props"]["target.object"] = json!("400");
        objects.iter_mut().find(|o| o.id == 11).unwrap().info["props"]["audio.channel"] =
            json!("MONO");
        assert_eq!(
            desired_links(
                &objects,
                "tincan.audio.capture.test",
                "tincan.audio.call.test",
                &["100".into(), "200".into()]
            ),
            HashSet::from([(11, 51), (11, 52)])
        );
    }
}
