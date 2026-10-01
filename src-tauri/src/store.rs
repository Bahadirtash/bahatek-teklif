// Yerel kalıcı veri: ayarlar, fiyatlar, hazırlanan teklifler (JSON dosyaları, uygulama
// klasöründe), .eml okuma ve V3 için arka plan veri kaydı. Hiçbir veri sunucuya gitmez.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{ipc::Request, ipc::Response, AppHandle, Manager};

const STORES: &[&str] = &["settings", "prices", "offers", "session"];

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !STORES.contains(&name) {
        return Err(format!("bilinmeyen kayıt: {name}"));
    }
    Ok(app_dir(app)?.join(format!("{name}.json")))
}

/// Yarım kalmış yazma eski dosyayı bozmasın diye önce geçici dosyaya yazılır.
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = store_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn store_write(app: AppHandle, name: String, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("geçersiz JSON: {e}"))?;
    write_atomic(&store_path(&app, &name)?, json.as_bytes())
}

#[tauri::command]
pub fn default_archive_root(app: AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("Teklif Arşivi").to_string_lossy().into_owned())
}

/// Kullanıcının seçtiği .eml dosyasını belleğe okur (yalnızca .eml).
#[tauri::command]
pub fn read_eml(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    let ok = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("eml"));
    if !ok {
        return Err("Yalnızca .eml dosyaları açılabilir.".into());
    }
    fs::read(p).map(Response::new).map_err(|e| format!("{path}: {e}"))
}

// ---------- V3 için arka plan veri kaydı (ekranda görünmez) ----------

fn record_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join("kayit"))
}

fn safe_file_name(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.starts_with('.');
    ok.then_some(name)
}

/// Kalem kayıtlarını kayit/kalemler.json içine "id" alanına göre ekler/günceller.
#[tauri::command]
pub fn record_items(app: AppHandle, items: Vec<serde_json::Value>) -> Result<(), String> {
    let path = record_dir(&app)?.join("kalemler.json");
    let mut all: Vec<serde_json::Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for item in items {
        let id = item.get("id").cloned();
        match all.iter_mut().find(|x| id.is_some() && x.get("id") == id.as_ref()) {
            // Elle girilen sonuç (kazanıldı/kaybedildi) yeni kayıtla silinmesin.
            Some(old) => {
                let result = old.get("result").cloned();
                *old = item;
                if let (Some(r), Some(obj)) = (result, old.as_object_mut()) {
                    if obj.get("result").is_none_or(|v| v.is_null()) {
                        obj.insert("result".into(), r);
                    }
                }
            }
            None => all.push(item),
        }
    }
    let json = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    write_atomic(&path, &json)
}

/// Teklif isteğinin sonucunu (kazanıldı/kaybedildi) o isteğin tüm kalem kayıtlarına yazar.
#[tauri::command]
pub fn record_result(app: AppHandle, request_id: String, result: Option<String>) -> Result<(), String> {
    let path = record_dir(&app)?.join("kalemler.json");
    let Ok(text) = fs::read_to_string(&path) else { return Ok(()) };
    let mut all: Vec<serde_json::Value> = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    for item in all.iter_mut().filter(|x| x.get("requestId").and_then(|v| v.as_str()) == Some(&request_id)) {
        if let Some(obj) = item.as_object_mut() {
            obj.insert("result".into(), result.clone().map_or(serde_json::Value::Null, Into::into));
        }
    }
    let json = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    write_atomic(&path, &json)
}

/// Çizim PDF'i veya küçük görseli kayit/cizimler/ altına yazar (ham gövde, ad başlıkta).
/// Aynı adlı dosya varsa (ad içerik özetini taşır) tekrar yazılmaz.
#[tauri::command]
pub fn record_file(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .and_then(safe_file_name)
        .ok_or("geçersiz dosya adı")?
        .to_string();
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("ham veri bekleniyordu".into());
    };
    let path = record_dir(&app)?.join("cizimler").join(name);
    if path.exists() {
        return Ok(());
    }
    write_atomic(&path, data)
}

#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    eprintln!("[arayüz:{level}] {message}");
}
