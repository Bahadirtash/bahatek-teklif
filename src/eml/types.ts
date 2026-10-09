export interface Person {
  name: string;
  address: string;
}

/** B firmasının gövdedeki kalem tablosu; başlık ve hücreler harfi harfine. */
export interface ItemTable {
  headers: string[];
  rows: string[][];
  /** Malzeme kodu sütununun indeksi. */
  codeCol: number;
  /** Miktar sütununun indeksi (bulunamazsa -1). */
  qtyCol: number;
  source: "html" | "text";
}

export interface Drawing {
  filename: string;
  /** Eşleştirme anahtarı: 8 haneli numara + "_" + revizyon harfi, ör. "00314268_B". */
  key: string;
  sheet: number;
  data: Uint8Array;
  mailId: string;
}

export interface OtherAttachment {
  filename: string;
  mimeType: string;
  size: number;
  mailId: string;
  data: Uint8Array;
}

export interface ParsedMail {
  id: string;
  /** Teklifi isteyen B firması kişisi (iletilmişse orijinal gönderen). */
  sender: Person;
  /** Mail iletilmişse, iletenin kendisi. */
  forwardedBy: Person | null;
  /** Orijinal konu, "Fwd:"/"İlt:" gibi önekler olduğu gibi korunur. */
  subject: string;
  /** Mailin (iletilmişse orijinalin) tarih satırı, ham metin. */
  date: string;
  /** Konudaki "(16:00 26.09.2026)" etiketi; parçaları birleştirmek için. */
  requestTag: string | null;
  partNo: number | null;
  partTotal: number | null;
  /** Gövdedeki son teklif tarihi, ör. "28.09.2026 15:00". */
  deadline: string | null;
  table: ItemTable | null;
  warnings: string[];
  drawings: Drawing[];
  /** Adı çizim biçimine uymayan PDF ekleri. */
  unrecognizedPdfs: OtherAttachment[];
  otherAttachments: OtherAttachment[];
}

export type ItemStatus = "ready" | "waiting" | "missing";

export interface Item {
  /** Tablodaki sıra (0'dan). */
  index: number;
  cells: string[];
  code: string;
  key: string | null;
  qty: number | null;
  drawings: Drawing[];
  /** ready: çizim var; waiting: çizim bekleniyor; missing: tüm parçalar geldi, çizim yok. */
  status: ItemStatus;
}

export interface QuoteRequest {
  id: string;
  sender: Person;
  subject: string;
  date: string;
  requestTag: string | null;
  deadline: string | null;
  partTotal: number | null;
  partsReceived: number[];
  mails: ParsedMail[];
  headers: string[];
  codeCol: number;
  /** Miktar sütunu; yoksa -1. */
  qtyCol: number;
  items: Item[];
  /** Hiçbir kaleme eşleşmeyen çizimler (sessizce kaybolmasın). */
  unmatchedDrawings: Drawing[];
  unrecognizedPdfs: OtherAttachment[];
  otherAttachments: OtherAttachment[];
  warnings: string[];
}
