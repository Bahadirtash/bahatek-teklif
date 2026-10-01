// Tauri (Rust) komutlarının tek giriş noktası. Tauri dışında (düz tarayıcıda geliştirme/önizleme)
// çalışırken dosya sistemi gerektirmeyen yedek davranışlar kullanılır.
import { invoke } from "@tauri-apps/api/core";

export const inTauri = "__TAURI_INTERNALS__" in window;

export interface OfferRowPayload {
  cells: string[];
  qty: number | null;
  price: number | null;
}

export interface OfferPayload {
  archiveRoot: string;
  firm: string;
  folder: string;
  headers: string[];
  qtyCol: number;
  rows: OfferRowPayload[];
}

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
}

export interface LoadedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

export async function storeRead<T>(name: string): Promise<T | null> {
  const raw = inTauri ? await invoke<string | null>("store_read", { name }) : localStorage.getItem(`bahatek:${name}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function storeWrite(name: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (inTauri) await invoke("store_write", { name, json });
  else localStorage.setItem(`bahatek:${name}`, json);
}

export async function defaultArchiveRoot(): Promise<string> {
  return inTauri ? invoke<string>("default_archive_root") : "Belgeler/Teklif Arşivi";
}

export async function readEml(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_eml", { path }));
}

/** .eml seçtirir: Tauri'de dosya yolu da döner (oturum geri yüklemesi için). */
export async function pickEmlFiles(): Promise<LoadedFile[]> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, filters: [{ name: "E-posta", extensions: ["eml"] }] });
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop() ?? p, path: p, data: await readEml(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".eml";
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.click();
  });
}

export async function pickFolder(current: string): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, defaultPath: current });
  return typeof picked === "string" ? picked : null;
}

export async function saveOffer(offer: OfferPayload): Promise<string> {
  if (!inTauri) throw new Error("Excel kaydı yalnızca masaüstü uygulamasında yapılır.");
  return invoke<string>("save_offer", { offer });
}

export async function openUrl(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function revealPath(path: string): Promise<void> {
  if (!inTauri) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function recordItems(items: unknown[]): Promise<void> {
  if (inTauri) await invoke("record_items", { items });
}

export async function recordResult(requestId: string, result: string | null): Promise<void> {
  if (inTauri) await invoke("record_result", { requestId, result });
}

export async function recordFile(name: string, data: Uint8Array): Promise<void> {
  if (inTauri) await invoke("record_file", data, { headers: { "x-name": name } });
}

export function logToTerminal(level: string, message: string): void {
  if (inTauri) invoke("log_frontend", { level, message }).catch(() => {});
}

// ---------- Gmail (salt okuma) ----------

export async function gmailStatus(): Promise<GmailStatus> {
  return inTauri ? invoke<GmailStatus>("gmail_status") : { configured: false, connected: false };
}

export async function gmailConnect(): Promise<string> {
  return invoke<string>("gmail_connect");
}

export async function gmailDisconnect(): Promise<void> {
  await invoke("gmail_disconnect");
}

export async function gmailList(query: string, max: number): Promise<{ id: string }[]> {
  return invoke<{ id: string }[]>("gmail_list", { query, max });
}

export async function gmailRaw(id: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("gmail_raw", { id }));
}

// ---------- Açılışta başlama ----------

export async function autostartEnabled(): Promise<boolean> {
  if (!inTauri) return false;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  if (!inTauri) return;
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  await (on ? enable() : disable());
}
