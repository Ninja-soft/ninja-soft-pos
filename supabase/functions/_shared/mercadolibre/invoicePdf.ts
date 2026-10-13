// =============================================================================
// _shared/mercadolibre/invoicePdf.ts (H87 · ADR-104). PURO.
//
// PDF del comprobante aprobado por ARCA para subirlo a la venta de ML
// (POST /packs/{pack_id|order_id}/fiscal_documents: sólo PDF, máx. 1 MB, un
// documento por tipo por pack). Se arma en el servidor (el worker lo sube
// solo, sin depender de que alguien abra el POS): A4, Helvetica estándar
// (WinAnsi), datos del emisor y del receptor, renglones, totales, CAE con
// vencimiento y el QR fiscal de ARCA (RG 4892) dibujado como vectores.
//
// El QR usa ./qrcode.ts, COPIA EXACTA de lib/qr/qrcode.ts (las Edge no
// importan de lib/): tests/unit/mercadolibre.test.ts verifica que sean iguales.
// =============================================================================
import { encodeQr } from "./qrcode.ts";

export interface InvoicePdfData {
  emitter: { name: string; cuit: string | null; ivaCondition: string | null; address: string | null; iibb?: string | null; activityStart?: string | null };
  doc: {
    letter: string;
    cbteTipo: number;
    label: string;
    ptoVta: number;
    nro: number;
    fecha: string;
    cae: string;
    caeVto: string;
    qrUrl: string | null;
    total: number;
    netTaxed: number;
    iva: number;
    otherTaxes: number;
  };
  receptor: { name: string; docType: string | null; docNumber: string | null; ivaCondition: string | null; address: string | null };
  items: Array<{ description: string; qty: number; unitPrice: number; subtotal: number }>;
  notes?: string | null;
}

const IVA_LABEL: Record<string, string> = {
  responsable_inscripto: "IVA Responsable Inscripto",
  monotributo: "Responsable Monotributo",
  monotributo_social: "Monotributo Social",
  exento: "IVA Sujeto Exento",
  consumidor_final: "Consumidor Final",
  no_alcanzado: "IVA No Alcanzado",
  no_categorizado: "Sujeto No Categorizado",
};
export const ivaLabel = (c: string | null | undefined) => (c ? (IVA_LABEL[c] ?? c) : "Consumidor Final");

/** Texto a bytes WinAnsi (Latin-1); lo que no entra se reemplaza por "?". */
function winAnsi(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    out += c < 256 ? ch : ch === "\u2013" || ch === "\u2014" ? "-" : "?";
  }
  return out;
}
const esc = (s: string) => winAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[\r\n]+/g, " ");

const fmtMoney = (n: number) => {
  const v = Math.round(n * 100) / 100;
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}$ ${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
};
const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(".", ","));
const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};
const pad = (n: number, w: number) => String(Math.max(0, Math.trunc(n))).padStart(w, "0");

class Page {
  ops: string[] = [];
  text(x: number, y: number, s: string, size = 9, bold = false) {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  }
  /** Alineado a la derecha (ancho aproximado de Helvetica). */
  textR(xRight: number, y: number, s: string, size = 9, bold = false) {
    const w = winAnsi(s).length * size * (bold ? 0.58 : 0.54);
    this.text(xRight - w, y, s, size, bold);
  }
  rect(x: number, y: number, w: number, h: number, fill = false) {
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill ? "f" : "S"}`);
  }
  line(x1: number, y1: number, x2: number, y2: number) {
    this.ops.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
}

function truncate(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Arma el PDF. Devuelve los bytes (siempre bastante menos de 1 MB). */
export function buildInvoicePdf(d: InvoicePdfData): Uint8Array {
  const W = 595.28;
  const H = 841.89;
  const M = 36;
  const pages: Page[] = [];
  const ROWS_FIRST = 26;
  const ROWS_NEXT = 40;
  const chunks: InvoicePdfData["items"][] = [];
  let rest = [...d.items];
  chunks.push(rest.slice(0, ROWS_FIRST));
  rest = rest.slice(ROWS_FIRST);
  while (rest.length > 0) {
    chunks.push(rest.slice(0, ROWS_NEXT));
    rest = rest.slice(ROWS_NEXT);
  }
  const numero = `${pad(d.doc.ptoVta, 5)}-${pad(d.doc.nro, 8)}`;

  chunks.forEach((rows, pi) => {
    const p = new Page();
    p.ops.push("0.6 w 0 0 0 RG 0 0 0 rg");
    let y = H - M;
    // Encabezado: emisor | letra | comprobante.
    p.rect(M, y - 110, W - 2 * M, 110);
    p.line(W / 2, y - 110, W / 2, y - 40);
    p.rect(W / 2 - 22, y - 44, 44, 44);
    p.text(W / 2 - 9, y - 30, d.doc.letter, 26, true);
    p.text(W / 2 - 18, y - 41, `COD. ${pad(d.doc.cbteTipo, 3)}`, 6);
    p.text(M + 10, y - 22, truncate(d.emitter.name, 40), 13, true);
    p.text(M + 10, y - 40, `Condición frente al IVA: ${ivaLabel(d.emitter.ivaCondition)}`, 8);
    p.text(M + 10, y - 52, `Domicilio: ${truncate(d.emitter.address ?? "", 52)}`, 8);
    p.text(W / 2 + 30, y - 22, d.doc.label, 13, true);
    p.text(W / 2 + 30, y - 40, `Punto de venta y número: ${numero}`, 8);
    p.text(W / 2 + 30, y - 52, `Fecha de emisión: ${fmtDate(d.doc.fecha)}`, 8);
    p.text(W / 2 + 30, y - 64, `CUIT: ${d.emitter.cuit ?? ""}`, 8);
    if (d.emitter.iibb) p.text(W / 2 + 30, y - 76, `Ingresos Brutos: ${d.emitter.iibb}`, 8);
    if (d.emitter.activityStart) p.text(W / 2 + 30, y - 88, `Inicio de actividades: ${fmtDate(d.emitter.activityStart)}`, 8);
    if (chunks.length > 1) p.textR(W - M - 8, y - 104, `Hoja ${pi + 1} de ${chunks.length}`, 7);
    y -= 120;

    // Receptor.
    p.rect(M, y - 52, W - 2 * M, 52);
    p.text(M + 10, y - 16, `Cliente: ${truncate(d.receptor.name, 60)}`, 9, true);
    const doc = d.receptor.docNumber ? `${(d.receptor.docType ?? "Doc").toUpperCase()}: ${d.receptor.docNumber}` : "Consumidor Final";
    p.text(M + 10, y - 30, doc, 8);
    p.text(W / 2 + 10, y - 30, `Condición frente al IVA: ${ivaLabel(d.receptor.ivaCondition)}`, 8);
    p.text(M + 10, y - 44, `Domicilio: ${truncate(d.receptor.address ?? "", 90)}`, 8);
    y -= 64;

    // Renglones.
    p.rect(M, y - 18, W - 2 * M, 18, false);
    p.text(M + 8, y - 12, "Descripción", 8, true);
    p.textR(W - M - 190, y - 12, "Cantidad", 8, true);
    p.textR(W - M - 100, y - 12, "Precio unit.", 8, true);
    p.textR(W - M - 8, y - 12, "Subtotal", 8, true);
    y -= 18;
    for (const r of rows) {
      y -= 15;
      p.text(M + 8, y, truncate(r.description, 62), 8);
      p.textR(W - M - 190, y, fmtQty(r.qty), 8);
      p.textR(W - M - 100, y, fmtMoney(r.unitPrice), 8);
      p.textR(W - M - 8, y, fmtMoney(r.subtotal), 8);
    }

    if (pi === chunks.length - 1) {
      // Totales.
      let ty = 250;
      p.rect(W / 2, ty - 70, W / 2 - M, 78);
      if (d.doc.letter === "A") {
        p.text(W / 2 + 10, ty - 8, "Importe neto gravado:", 9);
        p.textR(W - M - 8, ty - 8, fmtMoney(d.doc.netTaxed), 9);
        p.text(W / 2 + 10, ty - 24, "IVA:", 9);
        p.textR(W - M - 8, ty - 24, fmtMoney(d.doc.iva), 9);
        if (d.doc.otherTaxes > 0) {
          p.text(W / 2 + 10, ty - 40, "Otros tributos:", 9);
          p.textR(W - M - 8, ty - 40, fmtMoney(d.doc.otherTaxes), 9);
        }
      } else if (d.doc.letter === "B" && d.doc.iva > 0) {
        // Régimen de transparencia fiscal al consumidor (Ley 27.743).
        p.text(W / 2 + 10, ty - 8, "IVA contenido:", 8);
        p.textR(W - M - 8, ty - 8, fmtMoney(d.doc.iva), 8);
      }
      p.text(W / 2 + 10, ty - 60, "Importe total:", 11, true);
      p.textR(W - M - 8, ty - 60, fmtMoney(d.doc.total), 11, true);

      // CAE y QR.
      ty = 160;
      if (d.doc.qrUrl) {
        try {
          const qr = encodeQr(d.doc.qrUrl, "M");
          const size = 110;
          const mod = size / qr.size;
          const x0 = M;
          const y0 = ty - size + 20;
          for (let qy = 0; qy < qr.size; qy++) {
            for (let qx = 0; qx < qr.size; qx++) {
              if (qr.modules[qy]![qx]) p.rect(x0 + qx * mod, y0 + (qr.size - 1 - qy) * mod, mod + 0.05, mod + 0.05, true);
            }
          }
        } catch {
          /* sin QR: queda el texto del CAE */
        }
      }
      p.text(M + 130, ty, "Comprobante autorizado por ARCA", 9, true);
      p.text(M + 130, ty - 16, `CAE N°: ${d.doc.cae}`, 9);
      p.text(M + 130, ty - 30, `Vencimiento del CAE: ${fmtDate(d.doc.caeVto)}`, 9);
      if (d.notes) p.text(M + 130, ty - 48, truncate(d.notes, 70), 8);
    }
    pages.push(p);
  });

  // Ensamblado: 1 catálogo, 2 páginas, 3-4 fuentes, después página+contenido.
  const objs: string[] = [];
  const kids: number[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  let n = 5;
  for (const p of pages) {
    const content = p.ops.join("\n");
    const pageId = n++;
    const contentId = n++;
    kids.push(pageId);
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
