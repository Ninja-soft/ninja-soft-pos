// Sugerencias de mapeo producto POS <-> ítem de la app de delivery (ADR-102).
// Puro: lo usa la pantalla de Canales de delivery y los tests.
//
// Criterio (de más a menos seguro):
//   1. SKU igual (sin mayúsculas, espacios ni signos).
//   2. Nombre igual normalizado (sin tildes, mayúsculas ni signos).
//   3. Palabras en común (Jaccard >= 0,6) con el mejor puntaje.
// Un producto sólo se sugiere una vez y nunca se pisa un mapeo existente.

export interface MapCandidateProduct {
  id: string;
  name: string;
  sku: string | null;
  has_variants?: boolean;
}

export interface MapCandidateExternal {
  external_id: string;
  name: string;
  sku?: string | null;
  kind?: "product" | "modifier";
}

export interface MapSuggestion {
  external_id: string;
  external_name: string;
  product_id: string;
  product_name: string;
  reason: "sku" | "nombre" | "parecido";
  score: number;
}

export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const normalizeSku = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function tokens(s: string): Set<string> {
  return new Set(normalizeName(s).split(" ").filter((t) => t.length > 1));
}

export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Id externo que usa el simulador para un producto sin mapear (espejo del SQL). */
export function simulatorExternalId(p: { id: string; sku: string | null }): string {
  const sku = (p.sku ?? "").replace(/[^A-Za-z0-9]/g, "");
  return `SIM-${(sku || p.id.replace(/-/g, "").slice(0, 8)).toUpperCase()}`;
}

export function suggestMappings(
  products: MapCandidateProduct[],
  externals: MapCandidateExternal[],
  mappedExternalIds: Set<string>,
  minScore = 0.6,
): MapSuggestion[] {
  const usable = products.filter((p) => !p.has_variants);
  const used = new Set<string>();
  const out: MapSuggestion[] = [];
  for (const ext of externals) {
    if ((ext.kind ?? "product") !== "product" || mappedExternalIds.has(ext.external_id)) continue;
    let best: MapSuggestion | null = null;
    const extSku = normalizeSku(ext.sku);
    const extName = normalizeName(ext.name);
    for (const p of usable) {
      if (used.has(p.id)) continue;
      let score = 0;
      let reason: MapSuggestion["reason"] = "parecido";
      if (extSku && extSku === normalizeSku(p.sku)) {
        score = 1;
        reason = "sku";
      } else if (extName && extName === normalizeName(p.name)) {
        score = 0.95;
        reason = "nombre";
      } else {
        score = nameSimilarity(ext.name, p.name);
      }
      if (score >= minScore && (!best || score > best.score)) {
        best = {
          external_id: ext.external_id,
          external_name: ext.name,
          product_id: p.id,
          product_name: p.name,
          reason,
          score,
        };
      }
    }
    if (best) {
      used.add(best.product_id);
      out.push(best);
    }
  }
  return out;
}
