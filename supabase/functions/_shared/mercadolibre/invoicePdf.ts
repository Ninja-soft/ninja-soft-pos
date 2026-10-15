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
  /** ADR-141: hoja A4 o ticket de 80 mm. */
  format?: "a4" | "ticket";
  /** Descuento del cupón (renglón aparte en la hoja). */
  discount?: number;
  /** Percepciones discriminadas (nombre e importe). */
  perceptions?: Array<{ name: string; amount: number }>;
  /** Comprobante asociado (nota de crédito): "Factura B 00003-00000012". */
  assoc?: string | null;
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

/** Parte un texto en renglones de hasta `width` caracteres (máximo `lines`). */
export function wrapText(s: string, width: number, lines: number): string[] {
  const words = s.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = w.length > width ? w.slice(0, width) : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = truncate(`${kept[lines - 1]} ${out.slice(lines).join(" ")}`, width);
    return kept;
  }
  return out;
}

/** Arma el PDF. Devuelve los bytes (siempre bastante menos de 1 MB). */
export function buildInvoicePdf(d: InvoicePdfData): Uint8Array {
  if (d.format === "ticket") return buildTicketPdf(d);
  return buildA4Pdf(d);
}

function buildA4Pdf(d: InvoicePdfData): Uint8Array {
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
      // ADR-141: cupón como renglón de descuento.
      if (d.discount && d.discount > 0) {
        y -= 15;
        p.text(M + 8, y, "Descuento cupón Mercado Libre", 8);
        p.textR(W - M - 8, y, fmtMoney(-d.discount), 8);
      }
      if (d.assoc) {
        y -= 18;
        p.text(M + 8, y, `Comprobante asociado: ${truncate(d.assoc, 70)}`, 8);
      }
      // Totales.
      let ty = 250;
      p.rect(W / 2, ty - 70, W / 2 - M, 78);
      if (d.doc.letter === "A") {
        p.text(W / 2 + 10, ty - 8, "Importe neto gravado:", 9);
        p.textR(W - M - 8, ty - 8, fmtMoney(d.doc.netTaxed), 9);
        p.text(W / 2 + 10, ty - 24, "IVA:", 9);
        p.textR(W - M - 8, ty - 24, fmtMoney(d.doc.iva), 9);
        if (d.doc.otherTaxes > 0) {
          p.text(W / 2 + 10, ty - 40, perceptionLabel(d), 9);
          p.textR(W - M - 8, ty - 40, fmtMoney(d.doc.otherTaxes), 9);
        }
      } else if (d.doc.letter === "B" && d.doc.iva > 0) {
        // Régimen de transparencia fiscal al consumidor (Ley 27.743).
        p.text(W / 2 + 10, ty - 8, "IVA contenido:", 8);
        p.textR(W - M - 8, ty - 8, fmtMoney(d.doc.iva), 8);
        if (d.doc.otherTaxes > 0) {
          p.text(W / 2 + 10, ty - 24, perceptionLabel(d), 8);
          p.textR(W - M - 8, ty - 24, fmtMoney(d.doc.otherTaxes), 8);
        }
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
      // Leyenda (ADR-145): hasta 4 renglones debajo del CAE.
      if (d.notes) wrapText(d.notes, 70, 4).forEach((l, i) => p.text(M + 130, ty - 48 - i * 10, l, 8));
    }
    pages.push(p);
  });

  return assemble(pages.map((p) => ({ w: W, h: H, ops: p.ops })));
}

/** Rótulo de "otros tributos": las percepciones por jurisdicción, si vienen. */
function perceptionLabel(d: InvoicePdfData): string {
  const list = (d.perceptions ?? []).filter((x) => x.amount > 0);
  if (list.length === 0) return "Otros tributos:";
  return truncate(`Percepciones (${list.map((x) => x.name).join(", ")}):`, 40);
}

/**
 * Ticket de 80 mm (ADR-141): los mismos datos fiscales que la hoja A4 en una
 * columna angosta, con el alto según los renglones.
 */
function buildTicketPdf(d: InvoicePdfData): Uint8Array {
  const W = 226.77;
  const M = 10;
  const lines: Array<{ t: string; size?: number; bold?: boolean; right?: string; center?: boolean; gap?: number }> = [];
  const numero = `${pad(d.doc.ptoVta, 5)}-${pad(d.doc.nro, 8)}`;
  lines.push({ t: truncate(d.emitter.name, 34), size: 10, bold: true, center: true });
  lines.push({ t: `CUIT ${d.emitter.cuit ?? ""}`, size: 7, center: true });
  lines.push({ t: ivaLabel(d.emitter.ivaCondition), size: 7, center: true });
  if (d.emitter.address) lines.push({ t: truncate(d.emitter.address, 48), size: 7, center: true });
  if (d.emitter.iibb) lines.push({ t: `IIBB ${d.emitter.iibb}`, size: 7, center: true });
  if (d.emitter.activityStart) lines.push({ t: `Inicio de actividades ${fmtDate(d.emitter.activityStart)}`, size: 7, center: true });
  lines.push({ t: `${d.doc.label} ${d.doc.letter}`, size: 10, bold: true, center: true, gap: 6 });
  lines.push({ t: `COD. ${pad(d.doc.cbteTipo, 3)} · N° ${numero}`, size: 7, center: true });
  lines.push({ t: `Fecha ${fmtDate(d.doc.fecha)}`, size: 7, center: true });
  lines.push({ t: truncate(`Cliente: ${d.receptor.name}`, 46), size: 7, gap: 6 });
  lines.push({
    t: d.receptor.docNumber ? `${(d.receptor.docType ?? "Doc").toUpperCase()} ${d.receptor.docNumber}` : "Consumidor Final",
    size: 7,
  });
  lines.push({ t: ivaLabel(d.receptor.ivaCondition), size: 7 });
  if (d.assoc) lines.push({ t: truncate(`Asociado: ${d.assoc}`, 46), size: 7 });
  let first = true;
  for (const r of d.items) {
    lines.push({ t: truncate(r.description, 44), size: 7, gap: first ? 6 : 2 });
    lines.push({ t: `${fmtQty(r.qty)} x ${fmtMoney(r.unitPrice)}`, size: 7, right: fmtMoney(r.subtotal) });
    first = false;
  }
  if (d.discount && d.discount > 0) lines.push({ t: "Descuento cupón", size: 7, right: fmtMoney(-d.discount) });
  if (d.doc.letter === "A") {
    lines.push({ t: "Neto gravado", size: 7, right: fmtMoney(d.doc.netTaxed), gap: 6 });
    lines.push({ t: "IVA", size: 7, right: fmtMoney(d.doc.iva) });
  } else if (d.doc.letter === "B" && d.doc.iva > 0) {
    lines.push({ t: "IVA contenido", size: 7, right: fmtMoney(d.doc.iva), gap: 6 });
  }
  if (d.doc.otherTaxes > 0) lines.push({ t: perceptionLabel(d).replace(/:$/, ""), size: 7, right: fmtMoney(d.doc.otherTaxes) });
  lines.push({ t: "TOTAL", size: 10, bold: true, right: fmtMoney(d.doc.total), gap: 4 });
  lines.push({ t: `CAE ${d.doc.cae}`, size: 7, gap: 6 });
  lines.push({ t: `Vto. CAE ${fmtDate(d.doc.caeVto)}`, size: 7 });
  if (d.notes) for (const l of wrapText(d.notes, 46, 6)) lines.push({ t: l, size: 6 });

  const qrSize = d.doc.qrUrl ? 110 : 0;
  const textH = lines.reduce((h, l) => h + (l.size ?? 7) + 3 + (l.gap ?? 0), 0);
  const H = Math.max(200, Math.ceil(textH + qrSize + 3 * M));
  const p = new Page();
  p.ops.push("0.6 w 0 0 0 RG 0 0 0 rg");
  let y = H - M;
  for (const l of lines) {
    const size = l.size ?? 7;
    y -= size + 3 + (l.gap ?? 0);
    if (l.center) {
      const w = winAnsi(l.t).length * size * (l.bold ? 0.58 : 0.54);
      p.text(Math.max(M, (W - w) / 2), y, l.t, size, Boolean(l.bold));
    } else {
      p.text(M, y, l.t, size, Boolean(l.bold));
    }
    if (l.right) p.textR(W - M, y, l.right, size, Boolean(l.bold));
  }
  if (d.doc.qrUrl) {
    try {
      const qr = encodeQr(d.doc.qrUrl, "M");
      const mod = qrSize / qr.size;
      const x0 = (W - qrSize) / 2;
      const y0 = y - qrSize - 6;
      for (let qy = 0; qy < qr.size; qy++) {
        for (let qx = 0; qx < qr.size; qx++) {
          if (qr.modules[qy]![qx]) p.rect(x0 + qx * mod, y0 + (qr.size - 1 - qy) * mod, mod + 0.05, mod + 0.05, true);
        }
      }
    } catch {
      /* sin QR: queda el CAE */
    }
  }
  return assemble([{ w: W, h: H, ops: p.ops }]);
}

/** Ensamblado: 1 catálogo, 2 páginas, 3-4 fuentes, después página+contenido. */
function assemble(pages: Array<{ w: number; h: number; ops: string[] }>): Uint8Array {
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
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
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
