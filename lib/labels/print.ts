// Impresión del documento de etiquetas desde un iframe oculto (ADR-148).
// Sin ventana emergente (no la bloquea el navegador) y sin tocar el resto de
// la página: el iframe lleva su propio `@page` con el tamaño exacto. Antes de
// imprimir espera las fuentes y las imágenes (logo, fotos), así no sale una
// etiqueta con la tipografía de reemplazo o sin foto.

async function waitAssets(doc: Document, timeoutMs = 4000): Promise<void> {
  const imgs = Array.from(doc.images).filter((i) => !i.complete);
  const fonts = (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve();
  const loads = imgs.map(
    (img) =>
      new Promise<void>((res) => {
        img.addEventListener("load", () => res(), { once: true });
        img.addEventListener("error", () => res(), { once: true });
      }),
  );
  await Promise.race([Promise.all([fonts, ...loads]), new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Imprime el HTML. Resuelve cuando se abrió el diálogo de impresión. */
export function printLabelDocument(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.title = "Impresión de etiquetas";
    // Fuera de pantalla pero con tamaño (algunos navegadores no imprimen iframes de 0×0).
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;opacity:0;pointer-events:none";
    const cleanup = () => setTimeout(() => frame.remove(), 1000);
    frame.onload = async () => {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) {
        cleanup();
        reject(new Error("print_frame"));
        return;
      }
      try {
        await waitAssets(doc);
        win.addEventListener("afterprint", cleanup, { once: true });
        win.focus();
        win.print();
        resolve();
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error("print_failed"));
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** Descarga un texto como archivo (ZPL). */
export function downloadTextFile(text: string, filename: string, type = "text/plain"): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
