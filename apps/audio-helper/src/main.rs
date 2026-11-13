// SPDX-License-Identifier: AGPL-3.0-or-later
mod pipewire;
mod server;

use std::{path::PathBuf, process::Stdio};

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
    // SAFETY: a positive PID of this user's installed helper was verified.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    for _ in 0..50 {
        if !matches() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(std::io::Error::other(
        "helper is still stopping; close Tin Can's sharing tab and try again",
    ))
}

fn install() -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    stop_running()?;
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
