// Generación de la matriz de combinaciones de variantes (talle/color o
// cualquier par de ejes genéricos). Lógica pura, sin dependencias de React ni
// Supabase, para poder testearla en aislamiento (TDD).

export interface AxisDef {
  name: string;
  values: string[];
}

export interface Combo {
  option1: string;
  option2: string | null;
}

// "S, M , L" → ["S","M","L"]. Recorta espacios, descarta vacíos y deduplica
// respetando mayúsculas/minúsculas (case-sensitive: "S" y "s" conviven).
export function parseAxisValues(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Producto cartesiano de los valores del eje 1 × eje 2.
//  - 1 eje → option2 null.
//  - 0 ejes (o sin valores) → [].
// El orden es estable: itera eje 1 (externo) × eje 2 (interno).
export function generateCombos(axes: AxisDef[]): Combo[] {
  const defined = axes.filter((a) => a.values.length > 0).slice(0, 2);
  if (defined.length === 0) return [];

  const axis1 = defined[0]!;
  const axis2 = defined[1];
  const out: Combo[] = [];
  for (const o1 of axis1.values) {
    if (!axis2) {
      out.push({ option1: o1, option2: null });
      continue;
    }
    for (const o2 of axis2.values) {
      out.push({ option1: o1, option2: o2 });
    }
  }
  return out;
}

// Normaliza un valor para usarlo como sufijo de SKU: mayúsculas, espacios → "-",
// acentos removidos y se conservan solo [A-Z0-9-]. "Rojo Claro" → "ROJO-CLARO".
function skuToken(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita diacríticos (acentos)
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "");
}

// SKU auto-sufijado del padre: "REM-001" + {M, Rojo} → "REM-001-M-ROJO".
// Sin SKU de padre → null (no se puede pregenerar).
export function variantSku(
  parentSku: string | null,
  combo: Combo,
): string | null {
  if (!parentSku || !parentSku.trim()) return null;
  const parts = [parentSku.trim(), combo.option1];
  if (combo.option2 != null) parts.push(combo.option2);
  return parts.map(skuToken).filter(Boolean).join("-");
}
