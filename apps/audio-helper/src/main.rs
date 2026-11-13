// SPDX-License-Identifier: AGPL-3.0-or-later
mod pipewire;
mod server;

use std::{collections::HashSet, path::PathBuf, process::Stdio};

const ADDRESS: &str = "127.0.0.1:19477";
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system random source unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("HOME is not set")).join(fallback)
        })
}

fn open_page() {
    let _ = std::process::Command::new("xdg-open")
        .arg(format!("http://{ADDRESS}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn desktop_escape(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%")
}

fn state_dir() -> PathBuf {
    xdg("XDG_STATE_HOME", ".local/state").join("tincan-audio")
}

fn stop_running() -> std::io::Result<()> {
    let path = state_dir().join("helper.pid");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(pid) = text.trim().parse::<i32>() else {
        return Ok(());
    };
    if pid <= 1 || pid == std::process::id() as i32 {
        return Ok(());
    }
    let proc = PathBuf::from(format!("/proc/{pid}/exe"));
    let expected = PathBuf::from(std::env::var_os("HOME").expect("HOME is not set"))
        .join(".local/lib/tincan-audio/tincan-audio");
    let matches = || {
        std::fs::read_link(&proc).is_ok_and(|p| {
            p.to_string_lossy().trim_end_matches(" (deleted)") == expected.to_string_lossy()
        })
    };
    if !matches() {
        return Ok(());
    }
    kill_and_wait(pid, matches)
}

fn kill_and_wait(pid: i32, alive: impl Fn() -> bool) -> std::io::Result<()> {
    // SAFETY: the caller verified this positive PID belongs to this user's
    // helper process.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    for _ in 0..50 {
        if !alive() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(std::io::Error::other(
        "helper is still stopping; close Tin Can's sharing tab and try again",
    ))
}

fn is_helper(pid: i32) -> bool {
    let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) else {
        return false;
    };
    exe.file_name()
        .is_some_and(|n| n.to_string_lossy().trim_end_matches(" (deleted)") == "tincan-audio")
}

// Find the process holding the LISTEN socket on ADDRESS: look up the socket
// inode in /proc/net/tcp{,6}, then the fd symlinks under /proc/*/fd.
fn port_owner() -> Option<i32> {
    let mut inodes = HashSet::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(table) else {
            continue;
        };
        for line in text.lines().skip(1) {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            // 0100007F is 127.0.0.1 and 4A65 is port 19477; state 0A is LISTEN.
            if fields.len() > 9
                && matches!(
                    fields[1],
                    "0100007F:4A65" | "00000000000000000000000000000000:4A65"
                )
                && fields[3] == "0A"
            {
                inodes.insert(fields[9].to_string());
            }
        }
    }
    if inodes.is_empty() {
        return None;
    }
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if pid <= 1 || pid == std::process::id() as i32 {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let name = target.to_string_lossy();
            let Some(inode) = name
                .strip_prefix("socket:[")
                .and_then(|s| s.strip_suffix(']'))
            else {
                continue;
            };
            if inodes.contains(inode) {
                return Some(pid);
            }
        }
    }
    None
}

fn install() -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    stop_running()?;
    if std::net::TcpStream::connect(ADDRESS).is_ok() {
        // The port is still bound: a helper may be running from another path
        // (old install, dev build, pid-file write failure). Only kill it if
        // it is actually a helper; otherwise fail rather than claim success.
        match port_owner() {
            Some(pid) if is_helper(pid) => {
                kill_and_wait(pid, || std::net::TcpStream::connect(ADDRESS).is_ok())?
            }
            Some(pid) => {
                return Err(std::io::Error::other(format!(
                    "{ADDRESS} is already used by another program (pid {pid}); stop it and try again"
                )));
            }
            None => {
                return Err(std::io::Error::other(format!(
                    "{ADDRESS} is already used by another program; stop it and try again"
                )));
            }
        }
    }
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME is not set"));
    let dir = home.join(".local/lib/tincan-audio");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join("tincan-audio");
    let tmp = dir.join("tincan-audio.new");
    std::fs::copy(std::env::current_exe()?, &tmp)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(tmp, &dest)?;
    let config = xdg("XDG_CONFIG_HOME", ".config");
    let apps = xdg("XDG_DATA_HOME", ".local/share").join("applications");
    let autostart = config.join("autostart");
    std::fs::create_dir_all(&apps)?;
    std::fs::create_dir_all(&autostart)?;
    let entry = |mode: &str| {
        format!(
            "[Desktop Entry]\nType=Application\nName=Tin Can Audio\nComment=Application audio for Tin Can screen sharing\nExec=\"{}\" {mode}\nIcon=audio-card\nTerminal=false\nCategories=AudioVideo;Audio;\n",
            desktop_escape(&dest)
        )
    };
    std::fs::write(apps.join("tincan-audio.desktop"), entry("open"))?;
    std::fs::write(autostart.join("tincan-audio.desktop"), entry("serve"))?;
    let state = state_dir();
    std::fs::create_dir_all(&state)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join("helper.log"))?;
    if std::net::TcpStream::connect(ADDRESS).is_err() {
        let mut command = std::process::Command::new(&dest);
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe. Detach from the installer's
        // terminal so closing it does not terminate the installed helper.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        command
            .arg("serve")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .spawn()?;
    }
    println!(
        "Installed Tin Can Audio. Return to Tin Can and choose Connect helper.\nSettings: http://{ADDRESS}\nUninstall: \"{}\" uninstall",
        dest.display()
    );
    Ok(())
}

fn uninstall() -> std::io::Result<()> {
    stop_running()?;
    for path in [
        xdg("XDG_DATA_HOME", ".local/share").join("applications/tincan-audio.desktop"),
        xdg("XDG_CONFIG_HOME", ".config").join("autostart/tincan-audio.desktop"),
    ] {
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    for path in [
        PathBuf::from(std::env::var_os("HOME").expect("HOME is not set"))
            .join(".local/lib/tincan-audio"),
        xdg("XDG_CONFIG_HOME", ".config").join("tincan-audio"),
        state_dir(),
    ] {
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
    }
    println!(
        "Tin Can Audio stopped and removed, including autostart, logs and paired-site settings."
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "open".into());
    let result: Result<(), Box<dyn std::error::Error>> = match mode.as_str() {
        "--version" | "version" => {
            println!("tincan-audio {VERSION} (protocol 1)");
            Ok(())
        }
        "install" => install().map_err(Into::into),
        "uninstall" => uninstall().map_err(Into::into),
        "stop" => stop_running().map_err(Into::into),
        "doctor" => pipewire::check()
            .await
            .map(|_| println!("PipeWire and audio tools are ready."))
            .map_err(Into::into),
        "serve" | "open" => {
            let state = server::Server::new(
                xdg("XDG_CONFIG_HOME", ".config").join("tincan-audio/sites.json"),
            )
            .await;
            match tokio::net::TcpListener::bind(ADDRESS).await {
                Ok(listener) => {
                    let pid_path = state_dir().join("helper.pid");
                    if let Err(e) = std::fs::create_dir_all(state_dir())
                        .and_then(|_| std::fs::write(&pid_path, std::process::id().to_string()))
                    {
                        eprintln!("Could not write helper PID: {e}");
                    }
                    if mode == "open" {
                        open_page();
                    }
                    println!("Tin Can Audio {VERSION} — http://{ADDRESS}");
                    let shutdown = state.clone();
                    let result = axum::serve(listener, state.router()).with_graceful_shutdown(async move {
                        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
                        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
                        shutdown.close().await;
                    }).await.map_err(Into::into);
                    let _ = std::fs::remove_file(pid_path);
                    result
                }
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && mode == "open" => {
                    open_page();
                    Ok(())
                }
                Err(e) => Err(e.into()),
            }
        }
        _ => Err("Usage: tincan-audio [open|serve|stop|install|uninstall|doctor|version]".into()),
    };
    if let Err(e) = result {
        eprintln!("tincan-audio: {e}");
        std::process::exit(1);
    }
}
