// Google OAuth istemci bilgileri derleme sırasında gömülür: önce ortam değişkeni
// (GitHub Actions gizli değişkenleri), yoksa proje kökündeki .env dosyası.
const KEYS: &[&str] = &["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];

fn main() {
    println!("cargo:rerun-if-changed=../.env");
    let dotenv = std::fs::read_to_string("../.env").unwrap_or_default();
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        let from_file = dotenv.lines().find_map(|line| {
            let (k, v) = line.trim().split_once('=')?;
            (k.trim() == *key).then(|| v.trim().trim_matches('"').trim_matches('\'').to_string())
        });
        if let Some(value) = std::env::var(key).ok().filter(|v| !v.is_empty()).or(from_file) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
    tauri_build::build()
}
