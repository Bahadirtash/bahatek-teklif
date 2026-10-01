// Gmail bağlantısı — SADECE OKUMA (gmail.readonly). Bu modülde mail gönderme, taslak
// yazma veya değiştirme kodu yoktur ve olmamalıdır.
//
// OAuth: masaüstü uygulaması akışı (yerel geri dönüş adresi 127.0.0.1 + PKCE). Yenileme
// anahtarı işletim sisteminin anahtar deposunda (Windows Kimlik Bilgisi Yöneticisi /
// macOS Anahtar Zinciri) tutulur. Mailler ve ekler diske yazılmaz, belleğe döner.
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{ipc::Response, AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const KEYRING_SERVICE: &str = "com.bahatek.teklif";
const KEYRING_USER: &str = "gmail-refresh-token";

// Derleme sırasında .env veya ortam değişkeninden gelir (build.rs).
const CLIENT_ID: Option<&str> = option_env!("GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");

#[derive(Default)]
pub struct GmailState {
    access: Mutex<Option<(String, Instant)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailStatus {
    configured: bool,
    connected: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRef {
    id: String,
    #[serde(default)]
    thread_id: String,
}

fn client() -> Result<(&'static str, &'static str), String> {
    match (CLIENT_ID, CLIENT_SECRET) {
        (Some(id), Some(secret)) if !id.is_empty() => Ok((id, secret)),
        _ => Err("Gmail bağlantısı yapılandırılmamış (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).".into()),
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn stored_refresh_token() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_string(len: usize) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(120)).build().expect("http istemcisi")
}

#[tauri::command]
pub fn gmail_status() -> GmailStatus {
    GmailStatus { configured: client().is_ok(), connected: client().is_ok() && stored_refresh_token().is_some() }
}

/// Tarayıcıda Google izin ekranını açar, yerel adrese dönen kodu alır, anahtarları saklar.
/// Dönen değer bağlanan Gmail adresidir.
#[tauri::command]
pub async fn gmail_connect(app: AppHandle, state: State<'_, GmailState>) -> Result<String, String> {
    let (client_id, client_secret) = client()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_string(64);
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let csrf = random_string(32);

    let mut url = url::Url::parse(AUTH_URL).unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &csrf)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    // Tarayıcının geri dönüşünü bekle (en çok 5 dakika).
    let code = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let parsed = url::Url::parse(&format!("http://127.0.0.1{path}")).map_err(|e| e.to_string())?;
            let q: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            if !q.contains_key("code") && !q.contains_key("error") {
                // favicon vb. istekler
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let ok = q.get("state") == Some(&csrf) && q.contains_key("code");
            let body = if ok {
                "<h2>Bahatek Teklif: Gmail bağlantısı tamamlandı.</h2><p>Bu sekmeyi kapatıp uygulamaya dönebilirsiniz.</p>"
            } else {
                "<h2>Bahatek Teklif: Gmail bağlantısı yapılamadı.</h2><p>Uygulamaya dönüp tekrar deneyin.</p>"
            };
            let html = format!("<!doctype html><meta charset=utf-8><body style=\"font-family:sans-serif\">{body}</body>");
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                html.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            return match (ok, q.get("error")) {
                (true, _) => Ok(q["code"].clone()),
                (false, Some(err)) => Err(format!("Google izni verilmedi: {err}")),
                _ => Err("Geçersiz yanıt (state uyuşmadı).".to_string()),
            };
        }
    })
    .await
    .map_err(|_| "Zaman aşımı: Google izni 5 dakika içinde tamamlanmadı.".to_string())??;

    let tok: TokenResponse = http()
        .post(TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Anahtar alınamadı: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let refresh = tok.refresh_token.ok_or("Google yenileme anahtarı vermedi.")?;
    keyring_entry()?.set_password(&refresh).map_err(|e| format!("Anahtar saklanamadı: {e}"))?;
    *state.access.lock().unwrap() =
        Some((tok.access_token, Instant::now() + Duration::from_secs(tok.expires_in.unwrap_or(3600).saturating_sub(60))));

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Profile {
        email_address: String,
    }
    let profile: Profile = api_get(&state, "/profile", &[]).await?.json().await.map_err(|e| e.to_string())?;
    Ok(profile.email_address)
}

#[tauri::command]
pub async fn gmail_disconnect(state: State<'_, GmailState>) -> Result<(), String> {
    if let Some(token) = stored_refresh_token() {
        let _ = http().post(REVOKE_URL).form(&[("token", token.as_str())]).send().await;
    }
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    *state.access.lock().unwrap() = None;
    Ok(())
}

async fn access_token(state: &GmailState) -> Result<String, String> {
    if let Some((tok, exp)) = state.access.lock().unwrap().clone() {
        if Instant::now() < exp {
            return Ok(tok);
        }
    }
    let (client_id, client_secret) = client()?;
    let refresh = stored_refresh_token().ok_or("Gmail bağlı değil.")?;
    let resp = http()
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("Gmail'e ulaşılamadı: {e}"))?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST || resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Test modunda anahtar 7 günde geçersiz olur; yeniden bağlanmak gerekir.
        if let Ok(entry) = keyring_entry() {
            let _ = entry.delete_credential();
        }
        return Err("GMAIL_YENIDEN_BAGLAN: Gmail izninin süresi doldu, yeniden bağlanın.".into());
    }
    let tok: TokenResponse = resp.error_for_status().map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let exp = Instant::now() + Duration::from_secs(tok.expires_in.unwrap_or(3600).saturating_sub(60));
    *state.access.lock().unwrap() = Some((tok.access_token.clone(), exp));
    Ok(tok.access_token)
}

async fn api_get(state: &GmailState, path: &str, query: &[(&str, &str)]) -> Result<reqwest::Response, String> {
    let token = access_token(state).await?;
    http()
        .get(format!("{API}{path}"))
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|e| format!("Gmail'e ulaşılamadı: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Gmail hatası: {e}"))
}

/// Arama sorgusuna uyan mail kimlikleri (en yeniden eskiye, en çok `max` adet).
#[tauri::command]
pub async fn gmail_list(state: State<'_, GmailState>, query: String, max: u32) -> Result<Vec<MessageRef>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ListResponse {
        #[serde(default)]
        messages: Vec<MessageRef>,
        next_page_token: Option<String>,
    }
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    while out.len() < max as usize {
        let limit = (max as usize - out.len()).min(100).to_string();
        let mut q = vec![("q", query.as_str()), ("maxResults", limit.as_str())];
        if let Some(p) = page.as_deref() {
            q.push(("pageToken", p));
        }
        let resp: ListResponse = api_get(&state, "/messages", &q).await?.json().await.map_err(|e| e.to_string())?;
        out.extend(resp.messages);
        match resp.next_page_token {
            Some(p) => page = Some(p),
            None => break,
        }
    }
    Ok(out)
}

/// Mailin ham hali (RFC 822) — belleğe döner, diske yazılmaz.
#[tauri::command]
pub async fn gmail_raw(state: State<'_, GmailState>, id: String) -> Result<Response, String> {
    #[derive(Deserialize)]
    struct Raw {
        raw: String,
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("geçersiz mail kimliği".into());
    }
    let msg: Raw = api_get(&state, &format!("/messages/{id}"), &[("format", "raw")])
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    // Gmail base64url'i dolgulu da dolgusuz da dönebilir.
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let bytes = engine.decode(msg.raw.as_bytes()).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}
