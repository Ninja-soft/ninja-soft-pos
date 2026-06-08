// Lógica pura para impresión de etiquetas por lote (H24). Sin React.
import { sanitizeCode39 } from "@/lib/barcode/code39";

export interface LabelSource {
  id: string;
  name: string;
  price: number;
  barcode: string | null;
  sku: string | null;
  plu?: string | null; // código corto de 6 dígitos (si el tenant usa PLU)
}

export interface LabelData {
  id: string;
  name: string;
  price: number;
  code: string | null; // valor para el código de barras (o null si no hay)
  plu: string | null; // PLU para tipear en el POS (o null)
  sku: string | null; // SKU legible debajo del nombre (o null)
}

// Valor del código de barras de una etiqueta: barcode > sku > null,
// recortado a lo que Code 39 puede representar.
export function labelCode(p: { barcode: string | null; sku: string | null }): string | null {
  const raw = (p.barcode || p.sku || "").trim();
  if (!raw) return null;
  const clean = sanitizeCode39(raw);
  return clean || null;
}

// Cantidad de copias válida (1..200).
export function clampCopies(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

// Expande la selección a una lista plana de etiquetas (una por copia).
export function buildLabels(
  selection: { product: LabelSource; copies: number }[],
): LabelData[] {
  const out: LabelData[] = [];
  for (const { product, copies } of selection) {
    const n = clampCopies(copies);
    for (let i = 0; i < n; i++) {
      out.push({
        id: product.id,
        name: product.name,
        price: product.price,
        code: labelCode(product),
        plu: product.plu ?? null,
        sku: product.sku ?? null,
      });
    }
  }
  return out;
}
