// H9b — Nodo DOM → PNG dataURL y A4/PDF desde un nodo renderizado.
// Inlinea <img> remotas a dataURL antes de html2canvas para evitar canvas
// tainted (QR de qrserver, logo de Storage).
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

async function inlineImages(node: HTMLElement): Promise<() => void> {
  const imgs = Array.from(node.querySelectorAll("img"));
  const restores: { img: HTMLImageElement; src: string }[] = [];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:") || src.startsWith("/")) return;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((ok, err) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result));
          r.onerror = err;
          r.readAsDataURL(blob);
        });
        restores.push({ img, src });
        img.src = dataUrl;
      } catch {
        // Imagen inaccesible: se oculta para no romper el export.
        restores.push({ img, src });
        img.style.display = "none";
      }
    }),
  );
  return () =>
    restores.forEach(({ img, src }) => {
      img.src = src;
      img.style.display = "";
    });
}

export async function exportNodePng(node: HTMLElement): Promise<string> {
  const restore = await inlineImages(node);
  try {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
    return canvas.toDataURL("image/png");
  } finally {
    restore();
  }
}

// A4/PDF a partir del nodo ya renderizado por TicketRenderer.
export async function downloadA4FromNode(node: HTMLElement, saleNumber: number): Promise<void> {
  const png = await exportNodePng(node);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const img = new Image();
  await new Promise<void>((ok, err) => {
    img.onload = () => ok();
    img.onerror = err;
    img.src = png;
  });
  const maxW = 170; // margen 20mm
  const w = Math.min(maxW, 80);
  const h = (img.height / img.width) * w;
  doc.addImage(png, "PNG", (210 - w) / 2, 20, w, Math.min(h, 257));
  doc.save(`comprobante-${saleNumber}.pdf`);
}
