// Geliştirme öz-testi: gerçek Tauri penceresinde .eml yükle → fiyat gir → Teklifi Hazırla.
// Yalnızca `npm run tauri dev` + BAHATEK_SELFTEST ortam değişkeniyle çalışır.
import { invoke } from "@tauri-apps/api/core";
import * as backend from "./backend";
import type { QuoteRequest } from "./eml";
import { renderCrop } from "./pdf/render";
import type { state as appState } from "./state";

interface Hooks {
  state: typeof appState;
  addEmlFiles: (files: backend.LoadedFile[]) => Promise<void>;
  currentRequest: () => QuoteRequest | null;
}

const log = (msg: string) => backend.logToTerminal("öz-test", msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(h: Hooks): Promise<void> {
  const cfg = await invoke<[string, string] | null>("dev_selftest");
  if (!cfg) return;
  const [emlPath, archive] = cfg;
  try {
    log(`başladı: ${emlPath}`);
    h.state.settings.archiveRoot = archive;
    await h.addEmlFiles([{ name: emlPath.split(/[\\/]/).pop()!, path: emlPath, data: await backend.readEml(emlPath) }]);
    const req = h.currentRequest();
    if (!req) throw new Error("teklif isteği oluşmadı");
    const ready = req.items.filter((i) => i.status === "ready");
    log(`kalem=${req.items.length} çizimli=${ready.length} bekleyen=${req.items.filter((i) => i.status === "waiting").length}`);

    const t0 = performance.now();
    const crop = await renderCrop(ready[0].drawings[0]);
    log(`kırpma ${ready[0].code}: ${crop.width}x${crop.height} px, ${Math.round(performance.now() - t0)} ms`);

    const prices: [number, string][] = [[ready[0].index, "85,50"], [1, "12.5"], [5, "1.250"]];
    for (const [i, v] of prices) {
      const inp = document.querySelector<HTMLInputElement>(`#tb input[data-i="${i}"]`)!;
      inp.value = v;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }
    log(`alt şerit: fiyatlanan=${document.getElementById("cnt")!.textContent} toplam=${document.getElementById("gt")!.textContent}`);

    document.getElementById("prep")!.click();
    for (let k = 0; k < 50 && !document.getElementById("mb")!.textContent?.includes("Teklif"); k++) await sleep(200);
    log(`sonuç: ${document.getElementById("mb")!.textContent?.replace(/\s+/g, " ").slice(0, 220)}`);
    await sleep(4000); // arka plan veri kaydı
    log("TAMAM");
  } catch (e) {
    log(`HATA: ${e instanceof Error ? e.stack : e}`);
  } finally {
    await invoke("dev_exit");
  }
}
