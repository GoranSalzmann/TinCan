// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{ADDRESS, VERSION, pipewire, secret};
use axum::{
    Router,
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub struct Server {
    tokens: Mutex<HashMap<String, String>>,
    pending: Mutex<HashMap<String, Pairing>>,
    session: Mutex<Option<pipewire::Session>>,
    path: PathBuf,
    page_key: String,
}

struct Pairing {
    origin: String,
    csrf: String,
    token: Option<String>,
    expires: Instant,
}

pub fn origin_valid(origin: &str) -> bool {
    let Ok(u) = url::Url::parse(origin) else {
        return false;
    };
    u.origin().ascii_serialization() == origin
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
        && u.path() == "/"
        && (u.scheme() == "https"
            || (u.scheme() == "http"
                && matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
}

fn header<'a>(headers: &'a HeaderMap, key: &str) -> &'a str {
    headers.get(key).and_then(|v| v.to_str().ok()).unwrap_or("")
}

fn response(status: StatusCode, data: Value) -> Response {
    (status, axum::Json(data)).into_response()
}

fn error(status: StatusCode, code: &str) -> Response {
    response(status, json!({"error": code}))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(title: &str, content: &str) -> Response {
    Html(format!(r#"<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · Tin Can Audio</title>
<style>
:root{{color-scheme:dark}}body{{margin:0;background:#10151b;color:#e7edf4;font:16px/1.6 system-ui,sans-serif}}
main{{max-width:480px;margin:10vh auto;padding:32px;border:1px solid #33404f;border-radius:20px;background:#18212b}}
small{{color:#93d9b1;font-weight:700;letter-spacing:.1em}}h1{{font-size:28px;line-height:1.2}}
p{{color:#b9c6d4}}strong{{color:#e7edf4;overflow-wrap:anywhere}}button{{font:inherit;font-weight:650;cursor:pointer;border:0;
border-radius:10px;padding:12px 20px;background:#9ce9bd;color:#10271a}}button:focus-visible{{outline:3px solid #fff;outline-offset:3px}}
.muted{{font-size:14px}}@media(max-width:560px){{main{{margin:24px 16px;padding:24px}}}}</style>
<main><small>TIN CAN · AUDIO HELPER</small><h1>{title}</h1>{content}</main></html>"#)).into_response()
}

impl Server {
    pub async fn new(path: PathBuf) -> Arc<Self> {
        let tokens = tokio::fs::read(&path)
            .await
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default();
        Arc::new(Self {
            tokens: Mutex::new(tokens),
            pending: Mutex::new(HashMap::new()),
            session: Mutex::new(None),
            path,
            page_key: secret(),
        })
    }

    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            .route("/", get(home))
            .route("/connect", get(connect))
            .route("/approve", post(approve))
            .route("/disconnect", post(disconnect))
            .route("/v1/status", get(status))
            .route("/v1/pair", post(pair))
            .route("/v1/sources", get(list_sources))
            .route("/v1/session", post(create_session))
            .route("/v1/session/{id}", axum::routing::delete(stop_session))
            .route("/v1/session/{id}/start", post(start_session))
            .route("/v1/session/{id}/watch", get(watch))
            .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found") })
            .layer(DefaultBodyLimit::max(8192))
            .layer(middleware::from_fn_with_state(self.clone(), guard))
            .with_state(self)
    }

    async fn save(&self, tokens: &HashMap<String, String>) -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let parent = self.path.parent().unwrap();
        tokio::fs::create_dir_all(parent).await?;
        tokio::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).await?;
        let tmp = self.path.with_extension("tmp");
        // create with restrictive permissions, including on the first write.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        (&file).write_all(&serde_json::to_vec(tokens)?)?;
        file.sync_all()?;
        tokio::fs::rename(tmp, &self.path).await
    }

    async fn remove_session(&self, id: &str) {
        let mut session = self.session.lock().await;
        if session.as_ref().is_some_and(|s| s.id == id) {
            if let Some(s) = session.take() {
                s.close().await;
            }
        }
    }

    pub async fn close(&self) {
        if let Some(s) = self.session.lock().await.take() {
            s.close().await;
        }
    }
}

async fn guard(State(s): State<Arc<Server>>, req: Request, next: Next) -> Response {
    if header(req.headers(), "host") != ADDRESS {
        return error(StatusCode::FORBIDDEN, "invalid_host");
    }
    let origin = header(req.headers(), "origin").to_owned();
    let local_origin = format!("http://{ADDRESS}");
    if !origin.is_empty() && origin != local_origin && !origin_valid(&origin) {
        return error(StatusCode::FORBIDDEN, "invalid_origin");
    }
    let api = req.uri().path().starts_with("/v1/");
    let public = matches!(req.uri().path(), "/v1/status" | "/v1/pair");
    let mut result = if req.method() == "OPTIONS" && api && origin_valid(&origin) {
        StatusCode::NO_CONTENT.into_response()
    } else if api && !public && {
        let tokens = s.tokens.lock().await;
        !tokens
            .get(&origin)
            .is_some_and(|t| header(req.headers(), "authorization") == format!("Bearer {t}"))
    } {
        error(StatusCode::UNAUTHORIZED, "not_paired")
    } else {
        next.run(req).await
    };
    let headers = result.headers_mut();
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    // no-referrer makes Chromium send Origin: null on local form POSTs,
    // which the origin guard correctly rejects. Keep same-origin forms usable
    // while sending no referrer to any other site.
    headers.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    if api && origin_valid(&origin) {
        headers.insert(
            "access-control-allow-origin",
            HeaderValue::from_str(&origin).unwrap(),
        );
        headers.insert("vary", HeaderValue::from_static("Origin"));
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
        );
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("Authorization, Content-Type"),
        );
        headers.insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
    } else {
        headers.insert("content-security-policy", HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"));
    }
    result
}

async fn home(State(s): State<Arc<Server>>) -> Response {
    let tokens = s.tokens.lock().await;
    let sites = tokens
        .keys()
        .map(|o| format!("<li>{}</li>", escape(o)))
        .collect::<String>();
    let body = if sites.is_empty() {
        "<p>Ready to connect. In Tin Can, open <strong>Share your screen → Application audio → Connect helper</strong>.</p>".into()
    } else {
        format!(
            "<p>Connected to:</p><ul>{sites}</ul><p>Choose applications in Tin Can’s screen-sharing dialog.</p>\
            <form method=\"post\" action=\"/disconnect\"><input type=\"hidden\" name=\"key\" value=\"{}\">\
            <button>Disconnect all sites</button></form>",
            s.page_key
        )
    };
    page(
        "Your audio helper is ready",
        &format!("{body}<p class=\"muted\">Linux · PipeWire · {VERSION}</p>"),
    )
}

#[derive(Deserialize)]
struct Connect {
    origin: String,
    challenge: String,
}

async fn connect(
    State(s): State<Arc<Server>>,
    axum::extract::Query(q): axum::extract::Query<Connect>,
) -> Response {
    if !origin_valid(&q.origin)
        || q.challenge.len() != 64
        || !q.challenge.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    let mut pending = s.pending.lock().await;
    pending.retain(|_, p| p.expires > Instant::now());
    if pending.len() >= 32 {
        return error(StatusCode::TOO_MANY_REQUESTS, "busy");
    }
    let csrf = secret();
    pending.insert(
        q.challenge.clone(),
        Pairing {
            origin: q.origin.clone(),
            csrf: csrf.clone(),
            token: None,
            expires: Instant::now() + Duration::from_secs(120),
        },
    );
    page(
        "Connect to Tin Can",
        &format!(
            "<p>Allow <strong>{}</strong> to use this computer’s audio helper?</p>\
        <p>You choose which applications to share in Tin Can. Your call audio uses a separate output.</p>\
        <form action=\"/approve\" method=\"post\"><input type=\"hidden\" name=\"challenge\" value=\"{}\">\
        <input type=\"hidden\" name=\"csrf\" value=\"{csrf}\"><button>Connect this site</button></form>\
        <p class=\"muted\">You only need to do this once for each Tin Can server.</p>",
            escape(&q.origin),
            escape(&q.challenge)
        ),
    )
}

#[derive(Deserialize)]
struct Approval {
    challenge: String,
    csrf: String,
}

async fn approve(State(s): State<Arc<Server>>, axum::Form(b): axum::Form<Approval>) -> Response {
    let mut pending = s.pending.lock().await;
    let Some(p) = pending.get_mut(&b.challenge) else {
        return page(
            "Connection expired",
            "<p>Return to Tin Can and choose Connect helper again.</p>",
        );
    };
    if p.expires < Instant::now() || p.csrf != b.csrf || p.token.is_some() {
        return error(StatusCode::FORBIDDEN, "pairing_expired");
    }
    let token = secret();
    let mut tokens = s.tokens.lock().await;
    let old = tokens.insert(p.origin.clone(), token.clone());
    if s.save(&tokens).await.is_err() {
        if let Some(old) = old {
            tokens.insert(p.origin.clone(), old);
        } else {
            tokens.remove(&p.origin);
        }
        return page(
            "Could not save connection",
            "<p>Check that your user configuration directory is writable, then try again.</p>",
        );
    }
    p.token = Some(token);
    page(
        "Connected. You’re all set.",
        "<p>Return to Tin Can to choose the audio you want to share. You can close this tab.</p>",
    )
}

#[derive(Deserialize)]
struct Disconnect {
    key: String,
}
async fn disconnect(
    State(s): State<Arc<Server>>,
    axum::Form(b): axum::Form<Disconnect>,
) -> Response {
    if b.key != s.page_key {
        return error(StatusCode::FORBIDDEN, "invalid_request");
    }
    let mut tokens = s.tokens.lock().await;
    if s.save(&HashMap::new()).await.is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "save_failed");
    }
    tokens.clear();
    drop(tokens);
    s.pending.lock().await.clear();
    s.close().await;
    page(
        "Sites disconnected",
        "<p>Audio sharing has stopped. You can connect again from Tin Can.</p>",
    )
}

async fn status() -> Response {
    response(
        StatusCode::OK,
        json!({"name": "tincan-audio", "protocol": 1, "version": VERSION,
        "error": pipewire::check().await.err().unwrap_or("")}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Pair {
    challenge: String,
}
async fn pair(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    axum::Json(b): axum::Json<Pair>,
) -> Response {
    let mut pending = s.pending.lock().await;
    let Some(p) = pending.get(&b.challenge) else {
        return error(StatusCode::NOT_FOUND, "pairing_expired");
    };
    if p.origin != header(&headers, "origin") || p.expires < Instant::now() {
        return error(StatusCode::NOT_FOUND, "pairing_expired");
    }
    let Some(token) = p.token.clone() else {
        return response(StatusCode::ACCEPTED, json!({"pending": true}));
    };
    pending.remove(&b.challenge);
    response(StatusCode::OK, json!({"token": token, "protocol": 1}))
}

async fn list_sources() -> Response {
    match pipewire::snapshot().await {
        Ok(objects) => response(
            StatusCode::OK,
            json!({"sources": pipewire::sources(&objects, "")}),
        ),
        Err(e) => error(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    output_label: String,
}
async fn create_session(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    axum::Json(b): axum::Json<Create>,
) -> Response {
    let mut session = s.session.lock().await;
    if session.is_some() {
        return error(StatusCode::CONFLICT, "busy");
    }
    match pipewire::Session::new(header(&headers, "origin").into(), &b.output_label).await {
        Ok(new) => {
            let result = new.description();
            let id = new.id.clone();
            *session = Some(new);
            let server = s.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let mut session = server.session.lock().await;
                if session.as_ref().is_some_and(|s| s.id == id && !s.watching) {
                    if let Some(s) = session.take() {
                        s.close().await;
                    }
                }
            });
            response(StatusCode::CREATED, result)
        }
        Err(e) => error(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}

fn owned(session: &Option<pipewire::Session>, id: &str, headers: &HeaderMap) -> bool {
    session
        .as_ref()
        .is_some_and(|s| s.id == id && s.owner == header(headers, "origin"))
}

async fn stop_session(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let mut session = s.session.lock().await;
    if !owned(&session, &id, &headers) {
        return error(StatusCode::NOT_FOUND, "session_lost");
    }
    if let Some(s) = session.take() {
        s.close().await;
    }
    response(StatusCode::OK, json!({"stopped": true}))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Start {
    sources: Vec<String>,
}
async fn start_session(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::Json(b): axum::Json<Start>,
) -> Response {
    let mut session = s.session.lock().await;
    if !owned(&session, &id, &headers) {
        return error(StatusCode::NOT_FOUND, "session_lost");
    }
    let objects = match pipewire::snapshot().await {
        Ok(o) => o,
        Err(e) => return error(StatusCode::SERVICE_UNAVAILABLE, e),
    };
    match session.as_mut().unwrap().start(b.sources, &objects).await {
        Ok(()) => response(StatusCode::OK, json!({"started": true})),
        Err(e) => error(StatusCode::CONFLICT, e),
    }
}

async fn watch(
    State(s): State<Arc<Server>>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let mut session = s.session.lock().await;
    if !owned(&session, &id, &headers) {
        return error(StatusCode::NOT_FOUND, "session_lost");
    }
    if session.as_ref().unwrap().watching {
        return error(StatusCode::CONFLICT, "busy");
    }
    session.as_mut().unwrap().watching = true;
    drop(session);
    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<String, Infallible>>(1);
    // The response owns capture lifetime. Closing a tab closes the connection;
    // no background-tab timer or stored authorization can keep capture alive.
    tokio::spawn(async move {
        loop {
            if tx.is_closed() {
                break;
            }
            let snapshot = tokio::select! {
                _ = tx.closed() => break,
                result = pipewire::snapshot() => result,
            };
            let mut session = s.session.lock().await;
            let Some(current) = session.as_mut().filter(|c| c.id == id) else {
                break;
            };
            let (available, err) = match snapshot {
                Ok(objects) => (
                    pipewire::sources(&objects, &current.sink_name),
                    current.update(&objects).await.err(),
                ),
                Err(e) => (Vec::new(), Some(e)),
            };
            drop(session);
            let event = json!({"sources": available, "error": err}).to_string() + "\n";
            if tokio::time::timeout(Duration::from_secs(5), tx.send(Ok(event)))
                .await
                .is_err()
                || tx.is_closed()
                || err.is_some()
            {
                break;
            }
            tokio::select! { _ = tx.closed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
        }
        s.remove_session(&id).await;
    });
    let mut response =
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)).into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/x-ndjson"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    async fn call(
        app: Router,
        method: &str,
        path: &str,
        origin: &str,
        bearer: &str,
        body: &str,
    ) -> Response {
        app.oneshot(
            axum::http::Request::builder()
                .method(method)
                .uri(path)
                .header("host", ADDRESS)
                .header("origin", origin)
                .header("authorization", format!("Bearer {bearer}"))
                .header(
                    "content-type",
                    if path == "/approve" {
                        "application/x-www-form-urlencoded"
                    } else {
                        "application/json"
                    },
                )
                .body(Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn rejects_rebinding_opaque_origins_and_unpaired_calls_but_supports_preflight() {
        let state = Server::new(std::env::temp_dir().join(secret()).join("sites.json")).await;
        let app = state.router();
        let rebinding = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/status")
                    .header("host", "attacker.example:19477")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rebinding.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            call(app.clone(), "GET", "/v1/sources", "null", "", "")
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                app.clone(),
                "GET",
                "/v1/sources",
                "https://chat.example",
                "",
                ""
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        let preflight = call(
            app,
            "OPTIONS",
            "/v1/session",
            "https://chat.example",
            "",
            "",
        )
        .await;
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()["access-control-allow-origin"],
            "https://chat.example"
        );
        assert_eq!(
            preflight.headers()["access-control-allow-private-network"],
            "true"
        );
    }

    #[tokio::test]
    async fn pairing_needs_local_approval_is_origin_bound_and_can_only_be_collected_once() {
        let dir = std::env::temp_dir().join(secret());
        let state = Server::new(dir.join("sites.json")).await;
        let app = state.clone().router();
        let challenge = secret();
        let origin = "https://chat.example";
        let path = format!("/connect?origin=https%3A%2F%2Fchat.example&challenge={challenge}");
        assert_eq!(
            call(app.clone(), "GET", &path, "", "", "").await.status(),
            StatusCode::OK
        );
        let body = json!({"challenge": challenge}).to_string();
        assert_eq!(
            call(app.clone(), "POST", "/v1/pair", origin, "", &body)
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/approve",
                "",
                "",
                &format!("challenge={challenge}&csrf=wrong")
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        let csrf = state.pending.lock().await[&challenge].csrf.clone();
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/approve",
                "",
                "",
                &format!("challenge={challenge}&csrf={csrf}")
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/v1/pair",
                "https://other.example",
                "",
                &body
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        let approved = call(app.clone(), "POST", "/v1/pair", origin, "", &body).await;
        assert_eq!(approved.status(), StatusCode::OK);
        let data: Value = serde_json::from_slice(
            &axum::body::to_bytes(approved.into_body(), 8192)
                .await
                .unwrap(),
        )
        .unwrap();
        let token = data["token"].as_str().unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(
            call(app.clone(), "POST", "/v1/pair", origin, "", &body)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        // Authenticated nonexistent sessions get 404, not an auth failure.
        assert_eq!(
            call(
                app.clone(),
                "DELETE",
                "/v1/session/missing",
                origin,
                token,
                ""
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            call(
                app,
                "DELETE",
                "/v1/session/missing",
                "https://other.example",
                token,
                ""
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        let restarted = Server::new(dir.join("sites.json")).await;
        assert_eq!(restarted.tokens.lock().await.get(origin).unwrap(), token);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn origins_are_exact_sites_not_urls_or_opaque_origins() {
        for good in [
            "https://chat.example",
            "https://chat.example:8443",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ] {
            assert!(origin_valid(good), "{good}");
        }
        for bad in [
            "null",
            "https://chat.example/path",
            "https://user@chat.example",
            "https://chat.example#x",
            "http://evil.example",
            "file:///etc/passwd",
            "https://chat.example/",
        ] {
            assert!(!origin_valid(bad), "{bad}");
        }
    }
    #[test]
    fn connection_page_escapes_html() {
        assert_eq!(escape("<script>\"&'"), "&lt;script&gt;&quot;&amp;&#39;");
    }
}
