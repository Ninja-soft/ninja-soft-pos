// PDF del comprobante (ADR-119): descarga, Compartir y adjunto del email.
//
// Sale del MISMO nodo que la vista previa (motor ADR-112), así el PDF es
// idéntico a lo que se ve:
//   · A4: una página A4 real (210 x 297 mm) por hoja `[data-invoice-page]`
//     (Original, Duplicado y las hojas de un detalle largo). Los márgenes son
//     los de la hoja. Si una hoja se estiró más que una A4, se achica para que
//     entre: nunca se corta un renglón por la mitad.
//   · Ticket: una página del ancho del rollo (`[data-invoice-ticket]`, 80 o
//     58 mm) y el alto del comprobante, sin marcos ni márgenes extra.
// Antes de capturar se esperan las imágenes y las remotas (logo, fotos de
// productos) se pasan a data URL, para que no queden en blanco en el PDF.
// html2canvas y jspdf se cargan bajo demanda (pesan ~500 kB).

type JsPdf = import("jspdf").jsPDF;

export const A4_MM = { w: 210, h: 297 } as const;
export const ROLL_MM = { "80": 80, "58": 58 } as const;

export interface PdfImage {
  /** data URL (PNG o JPEG). */
  data: string;
  /** Medidas del canvas en px. */
  w: number;
  h: number;
}

/** Ubicación de una hoja capturada dentro de la página A4 (mm). */
export function a4Placement(
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  const natH = (h * A4_MM.w) / w;
  if (natH <= A4_MM.h + 0.5)
    return { x: 0, y: 0, w: A4_MM.w, h: Math.min(natH, A4_MM.h) };
  // Más alta que una A4: se achica para que entre entera, centrada.
  const k = A4_MM.h / natH;
  const pw = A4_MM.w * k;
  return { x: (A4_MM.w - pw) / 2, y: 0, w: pw, h: A4_MM.h };
}

/** Página del ticket: el ancho del rollo y el alto proporcional (mm). */
export function ticketPage(
  paper: "80" | "58",
  w: number,
  h: number,
): { w: number; h: number } {
  const pw = ROLL_MM[paper];
  return { w: pw, h: Math.max(20, (h * pw) / w) };
}

/** Arma el PDF a partir de las capturas. PURO salvo jsPDF (testeable en Node). */
export async function buildInvoicePdf(
  pages: PdfImage[],
  kind: { a4: true } | { paper: "80" | "58" },
): Promise<JsPdf> {
  const { jsPDF } = await import("jspdf");
  if ("a4" in kind) {
    const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
    pages.forEach((p, i) => {
      if (i > 0) doc.addPage("a4", "portrait");
      const r = a4Placement(p.w, p.h);
      doc.addImage(
        p.data,
        p.data.startsWith("data:image/jpeg") ? "JPEG" : "PNG",
        r.x,
        r.y,
        r.w,
        r.h,
        undefined,
        "FAST",
      );
    });
    return doc;
  }
  const first = pages[0]!;
  const size = ticketPage(kind.paper, first.w, first.h);
  const doc = new jsPDF({
    unit: "mm",
    format: [size.w, size.h],
    orientation: size.h >= size.w ? "portrait" : "landscape",
    compress: true,
  });
  doc.addImage(first.data, "PNG", 0, 0, size.w, size.h, undefined, "FAST");
  return doc;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

async function toDataUrl(src: string): Promise<string> {
  const res = await fetch(src);
  const blob = await res.blob();
  return new Promise<string>((ok, err) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = err;
    r.readAsDataURL(blob);
  });
}

/** Pasa las imágenes remotas a data URL y espera a que todas carguen. */
async function prepareImages(node: HTMLElement): Promise<() => void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  const restores: { img: HTMLImageElement; src: string }[] = [];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (src && !src.startsWith("data:") && !src.startsWith("/")) {
        try {
          const data = await toDataUrl(src);
          restores.push({ img, src });
          img.src = data;
        } catch {
          // Imagen inaccesible: se oculta para no romper el export.
          restores.push({ img, src });
          img.style.visibility = "hidden";
        }
      }
      if (!img.complete) {
        await new Promise<void>((ok) => {
          img.addEventListener("load", () => ok(), { once: true });
          img.addEventListener("error", () => ok(), { once: true });
          setTimeout(ok, 4000);
        });
      }
      try {
        await img.decode?.();
      } catch {
        /* sin decode: sigue igual */
      }
    }),
  );
  return () =>
    restores.forEach(({ img, src }) => {
      img.src = src;
      img.style.visibility = "";
    });
}

/**
 * html2canvas mide la línea base de cada fuente con un <img> de 1 px
 * alineado al texto dentro de un div oculto que agrega al <body> del
 * documento. El preflight de Tailwind pone `img { display: block }`, así que
 * esa imagen baja a otra línea y la "línea base" sale una línea entera más
 * abajo: en el PDF el texto quedaba corrido hacia abajo y se encimaba (más
 * visible con Inter y en los títulos grandes). Mientras se captura, ese <img>
 * de medición vuelve a ser inline.
 */
const H2C_METRICS_FIX =
  "body > div[style*='visibility: hidden'] > img { display: inline !important; }";

async function capture(
  el: HTMLElement,
  jpeg: boolean,
  scale = 2.5,
): Promise<PdfImage> {
  const html2canvas = (await import("html2canvas")).default;
  const fix = document.createElement("style");
  fix.setAttribute("data-h2c-fix", "");
  fix.textContent = H2C_METRICS_FIX;
  document.head.appendChild(fix);
  try {
    const canvas = await html2canvas(el, {
      scale,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
    });
    return {
      data: jpeg
        ? canvas.toDataURL("image/jpeg", 0.82)
        : canvas.toDataURL("image/png"),
      w: canvas.width,
      h: canvas.height,
    };
  } finally {
    fix.remove();
  }
}

/** PDF del comprobante dibujado en `node` (hojas A4 o rollo de ticket). */
export async function exportInvoicePdf(node: HTMLElement): Promise<JsPdf> {
  const restore = await prepareImages(node);
  try {
    const sheets = Array.from(
      node.querySelectorAll<HTMLElement>("[data-invoice-page]"),
    );
    if (sheets.length > 0) {
      // Más de 2 hojas: JPEG a 2x para que el adjunto no pase el límite del
      // email (4 MB en base64); con muchas hojas, un poco menos de resolución.
      const jpeg = sheets.length > 2;
      const scale = sheets.length > 8 ? 1.6 : jpeg ? 2 : 2.5;
      const pages: PdfImage[] = [];
      for (const s of sheets) pages.push(await capture(s, jpeg, scale));
      return buildInvoicePdf(pages, { a4: true });
    }
    const roll =
      node.querySelector<HTMLElement>("[data-invoice-ticket]") ?? node;
    const paper = roll.getAttribute("data-paper") === "58" ? "58" : "80";
    return buildInvoicePdf([await capture(roll, false)], { paper });
  } finally {
    restore();
  }
}

/** Base64 CRUDO del PDF (sin `data:`), como lo espera la Edge del email. */
export async function exportInvoicePdfBase64(
  node: HTMLElement,
): Promise<string> {
  const doc = await exportInvoicePdf(node);
  const uri = doc.output("datauristring");
  const comma = uri.indexOf(",");
  return comma >= 0 ? uri.slice(comma + 1) : uri;
}

export async function downloadInvoicePdf(
  node: HTMLElement,
  fileName: string,
): Promise<void> {
  const doc = await exportInvoicePdf(node);
  doc.save(fileName);
}

export async function invoicePdfFile(
  node: HTMLElement,
  fileName: string,
): Promise<File> {
  const doc = await exportInvoicePdf(node);
  return new File([doc.output("blob")], fileName, { type: "application/pdf" });
}
