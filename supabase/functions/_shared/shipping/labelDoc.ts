// =============================================================================
// _shared/shipping/labelDoc.ts  (ADR-103)
//
// Generadores PUROS de etiquetas para el simulador (y de respaldo): un PDF de
// una página (10x15 térmica o A4) con texto en Helvetica y código de barras
// Code 39 dibujado con rectángulos, y la misma etiqueta en ZPL (Zebra) con
// Code 128 nativo. Sin dependencias.
// =============================================================================
import type { LabelFile, LabelSize } from "./types.ts";

export interface LabelData {
  carrier: string;
  service: string;
  tracking: string;
  reference: string;
  sender: { name: string; address: string };
  recipient: { name: string; address: string; city: string; postal_code: string; phone?: string };
  packages: string;
  weight: string;
  createdAt: string;
  note?: string;
}

const PAGE: Record<LabelSize, { w: number; h: number }> = {
  // 100 x 150 mm y A4, en puntos.
  "10x15": { w: 283.46, h: 425.2 },
  a4: { w: 595.28, h: 841.89 },
};

// Code 39: n = angosto, w = ancho; alternan barra/espacio empezando por barra.
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
  "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn",
  F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
  K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn",
  P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
  U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn",
  Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "*": "nwnnwnwnn",
};

/** Barras de Code 39 como [x, ancho] en módulos (angosto = 1, ancho = 3). */
export function code39Bars(text: string): { x: number; w: number }[] {
  const clean = `*${text.toUpperCase().replace(/[^0-9A-Z. -]/g, "-")}*`;
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of clean) {
    const pat = CODE39[ch] ?? CODE39["-"]!;
    for (let i = 0; i < pat.length; i++) {
      const w = pat[i] === "w" ? 3 : 1;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += 1; // separador entre caracteres
  }
  return bars;
}

/** Texto PDF seguro: WinAnsi básico, paréntesis y barras escapados. */
export function pdfText(s: string): string {
  const ascii = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");
  return ascii.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** PDF 1.4 de una página con la etiqueta. */
export function buildLabelPdf(d: LabelData, size: LabelSize = "10x15"): Uint8Array {
  const { w, h } = PAGE[size];
  const m = 14;
  const ops: string[] = [];
  const text = (x: number, y: number, pt: number, s: string, bold = false) =>
    ops.push(`BT /${bold ? "F2" : "F1"} ${pt} Tf ${fmt(x)} ${fmt(y)} Td (${pdfText(s)}) Tj ET`);
  const line = (y: number) => ops.push(`${fmt(m)} ${fmt(y)} m ${fmt(w - m)} ${fmt(y)} l S`);

  ops.push("0.8 w");
  ops.push(`${fmt(m / 2)} ${fmt(m / 2)} ${fmt(w - m)} ${fmt(h - m)} re S`);
  let y = h - m - 18;
  text(m, y, 16, d.carrier, true);
  text(w - m - 90, y, 9, d.service);
  y -= 10;
  line(y);
  y -= 16;
  text(m, y, 8, "REMITENTE", true);
  y -= 11;
  text(m, y, 9, d.sender.name);
  y -= 11;
  text(m, y, 8, d.sender.address);
  y -= 10;
  line(y);
  y -= 16;
  text(m, y, 8, "DESTINATARIO", true);
  y -= 16;
  text(m, y, 14, d.recipient.name, true);
  y -= 14;
  text(m, y, 10, d.recipient.address);
  y -= 13;
  text(m, y, 10, `${d.recipient.postal_code} ${d.recipient.city}`);
  if (d.recipient.phone) {
    y -= 12;
    text(m, y, 9, `Tel. ${d.recipient.phone}`);
  }
  y -= 10;
  line(y);
  y -= 14;
  text(m, y, 9, `Bultos: ${d.packages}   Peso: ${d.weight}`);
  y -= 12;
  text(m, y, 8, `Ref.: ${d.reference}   ${d.createdAt}`);
  if (d.note) {
    y -= 12;
    text(m, y, 8, d.note);
  }

  // Código de barras centrado.
  const bars = code39Bars(d.tracking);
  const modules = bars.length ? bars[bars.length - 1]!.x + bars[bars.length - 1]!.w : 1;
  const bw = w - m * 2 - 10;
  const unit = bw / modules;
  const bh = 70;
  const by = Math.max(m + 30, y - bh - 20);
  ops.push("0 g");
  for (const b of bars) ops.push(`${fmt(m + 5 + b.x * unit)} ${fmt(by)} ${fmt(b.w * unit)} ${bh} re f`);
  text(m + 5, by - 16, 14, d.tracking, true);

  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(w)} ${fmt(h)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** ZPL II: texto sin acentos y sin los caracteres de control de ZPL. */
export function zplText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\^~\\]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
}

/** Etiqueta 4x6" (100x150 mm a 203 dpi = 812 x 1218 puntos). */
export function buildLabelZpl(d: LabelData): string {
  const t = zplText;
  return [
    "^XA",
    "^CI28",
    "^PW812",
    "^LL1218",
    `^FO40,40^A0N,50,50^FD${t(d.carrier)}^FS`,
    `^FO520,50^A0N,28,28^FD${t(d.service)}^FS`,
    "^FO40,110^GB732,3,3^FS",
    `^FO40,130^A0N,24,24^FDREMITENTE^FS`,
    `^FO40,160^A0N,28,28^FD${t(d.sender.name)}^FS`,
    `^FO40,195^A0N,24,24^FD${t(d.sender.address)}^FS`,
    "^FO40,235^GB732,3,3^FS",
    `^FO40,255^A0N,24,24^FDDESTINATARIO^FS`,
    `^FO40,290^A0N,44,44^FD${t(d.recipient.name)}^FS`,
    `^FO40,345^A0N,32,32^FD${t(d.recipient.address)}^FS`,
    `^FO40,385^A0N,32,32^FD${t(`${d.recipient.postal_code} ${d.recipient.city}`)}^FS`,
    d.recipient.phone ? `^FO40,425^A0N,26,26^FDTel. ${t(d.recipient.phone)}^FS` : "",
    "^FO40,470^GB732,3,3^FS",
    `^FO40,490^A0N,28,28^FDBultos: ${t(d.packages)}   Peso: ${t(d.weight)}^FS`,
    `^FO40,530^A0N,22,22^FDRef.: ${t(d.reference)}  ${t(d.createdAt)}^FS`,
    d.note ? `^FO40,565^A0N,22,22^FD${t(d.note)}^FS` : "",
    `^FO60,640^BY3^BCN,220,Y,N,N^FD${t(d.tracking)}^FS`,
    "^XZ",
  ]
    .filter(Boolean)
    .join("\n");
}

export function labelFile(d: LabelData, format: "pdf" | "zpl", size: LabelSize = "10x15"): LabelFile {
  if (format === "zpl") {
    return { format, size: "10x15", mime: "text/plain", bytes: new TextEncoder().encode(buildLabelZpl(d)) };
  }
  return { format, size, mime: "application/pdf", bytes: buildLabelPdf(d, size) };
}
