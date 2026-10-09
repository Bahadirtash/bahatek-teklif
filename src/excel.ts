import ExcelJS from "exceljs";
import type { QuoteRequest } from "./eml";
import { getPreviousPrice, priceOf } from "./main";

export async function fillExcelTemplate(req: QuoteRequest, templateData: Uint8Array, rows: any[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateData.buffer as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Şablon dosyasında sayfa bulunamadı.");

  let headerRow = -1;
  let codeCol = -1;
  let qtyCol = -1;
  let priceCol = -1;
  let totalCol = -1;
  let prevPriceCol = -1;
  let prevDateCol = -1;

  ws.eachRow((row, rowNumber) => {
    if (headerRow !== -1) return;
    let foundCode = false;
    row.eachCell((cell, colNumber) => {
      const val = cell.value?.toString().toLowerCase().replace(/\s+/g, "") || "";
      if (val.includes("malzeme") || val.includes("parça") || val.includes("kod")) { foundCode = true; codeCol = colNumber; }
      else if (val.includes("miktar") || val.includes("adet")) qtyCol = colNumber;
      else if (val.includes("birimfiyat") || val.includes("fiyat")) priceCol = colNumber;
      else if (val.includes("toplam") || val.includes("tutar")) totalCol = colNumber;
      else if (val.includes("öncekifiyat")) prevPriceCol = colNumber;
      else if (val.includes("öncekitarih")) prevDateCol = colNumber;
    });
    if (foundCode) headerRow = rowNumber;
  });

  if (headerRow === -1) {
    throw new Error("Şablonda 'Malzeme' veya 'Kod' başlığı bulunamadı.");
  }

  if (priceCol === -1) {
    priceCol = ws.getRow(headerRow).cellCount + 1;
    const headerCell = ws.getCell(headerRow, priceCol);
    headerCell.value = "Birim Fiyat";
  }
  if (totalCol === -1) {
    totalCol = priceCol + 1;
    const headerCell = ws.getCell(headerRow, totalCol);
    headerCell.value = "Toplam";
  }
  if (prevPriceCol === -1) {
    prevPriceCol = totalCol + 1;
    const headerCell = ws.getCell(headerRow, prevPriceCol);
    headerCell.value = "Önceki Fiyat";
  }
  if (prevDateCol === -1) {
    prevDateCol = prevPriceCol + 1;
    const headerCell = ws.getCell(headerRow, prevDateCol);
    headerCell.value = "Önceki Tarih";
  }

  for (const it of rows) {
    let foundRow = -1;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const cellVal = row.getCell(codeCol).value?.toString() || "";
      if (cellVal.trim() === it.code) {
        foundRow = rowNumber;
      }
    });

    if (foundRow > -1) {
      const p = priceOf(req, it);
      const row = ws.getRow(foundRow);
      
      const pCell = row.getCell(priceCol);
      if (p != null) {
        pCell.value = p;
        pCell.numFmt = '#,##0.00';
      }

      const tCell = row.getCell(totalCol);
      if (p != null && it.qty != null) {
        const colLetterPrice = ws.getColumn(priceCol).letter;
        const colLetterQty = qtyCol !== -1 ? ws.getColumn(qtyCol).letter : "";
        if (colLetterQty) {
          tCell.value = { formula: `${colLetterPrice}${foundRow}*${colLetterQty}${foundRow}` };
        } else {
          tCell.value = p * it.qty;
        }
        tCell.numFmt = '#,##0.00';
      }

      const prev = getPreviousPrice(req, it.code);
      const ppCell = row.getCell(prevPriceCol);
      const pdCell = row.getCell(prevDateCol);
      if (prev) {
        ppCell.value = prev.price;
        ppCell.numFmt = '#,##0.00';
        pdCell.value = new Date(prev.date).toLocaleDateString("tr-TR");
      }
    }
  }

  ws.getColumn(priceCol).width = 15;
  ws.getColumn(totalCol).width = 15;
  ws.getColumn(prevPriceCol).width = 15;
  ws.getColumn(prevDateCol).width = 15;

  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}
