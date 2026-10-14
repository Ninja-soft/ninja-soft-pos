// Qué trae un producto del catálogo antes de importarlo (ADR-118): si tiene
// código de barras y qué medidas. Lo usan el diálogo de import y las tarjetas
// de la tiendita.
import type { CatalogMeasures } from "@/modules/tiendita/storefront";

export interface MeasureLine {
  key: "peso" | "volumen" | "contenido" | "dimensiones" | "pack" | "bultos";
  label: string;
  value: string;
}

const fmt = (n: number, max = 2) =>
  n.toLocaleString("es-AR", { maximumFractionDigits: max, minimumFractionDigits: 0 });

const pos = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Medidas del maestro en líneas legibles (orden fijo: peso, volumen/contenido, dimensiones, pack, bultos). */
export function measureLines(m: CatalogMeasures | null | undefined): MeasureLine[] {
  if (!m || typeof m !== "object") return [];
  const out: MeasureLine[] = [];
  const peso = pos(m.peso_kg);
  if (peso != null) {
    out.push({ key: "peso", label: "Peso", value: peso < 1 ? `${fmt(peso * 1000, 0)} g` : `${fmt(peso)} kg` });
  }
  const c = m.contenido;
  const cv = pos(c?.valor);
  if (c && cv != null) {
    if (c.unidad === "ml") {
      out.push({ key: "volumen", label: "Volumen", value: cv >= 1000 ? `${fmt(cv / 1000)} l` : `${fmt(cv, 0)} ml` });
    } else if (c.unidad === "g") {
      out.push({ key: "contenido", label: "Contenido", value: cv >= 1000 ? `${fmt(cv / 1000)} kg` : `${fmt(cv, 0)} g` });
    }
  }
  const dims = [pos(m.alto_cm), pos(m.ancho_cm), pos(m.profundidad_cm)];
  if (dims.some((d) => d != null)) {
    out.push({
      key: "dimensiones",
      label: "Dimensiones",
      value: `${dims.map((d) => (d == null ? "–" : fmt(d))).join(" × ")} cm`,
    });
  } else if (typeof m.medidas === "string" && m.medidas.trim()) {
    out.push({ key: "dimensiones", label: "Dimensiones", value: m.medidas.trim() });
  }
  const pack = pos(m.unidades_pack);
  if (pack != null && pack > 1) out.push({ key: "pack", label: "Unidades por pack", value: fmt(pack, 0) });
  const bultos = pos(m.bultos);
  if (bultos != null && bultos > 1) out.push({ key: "bultos", label: "Bultos", value: fmt(bultos, 0) });
  return out;
}

/** ¿El código es un GTIN válido (EAN-8, UPC-A, EAN-13, GTIN-14)? Espacios, guiones y puntos se ignoran. */
export function isValidGtin(raw: string | null | undefined): boolean {
  const d = String(raw ?? "").trim().replace(/[\s.-]+/g, "");
  if (!/^\d+$/.test(d) || !(d.length === 8 || (d.length >= 11 && d.length <= 14))) return false;
  const g = d.length === 8 ? d : d.padStart(14, "0");
  let sum = 0;
  for (let i = 0; i < g.length - 1; i++) {
    const n = g.charCodeAt(g.length - 2 - i) - 48;
    sum += i % 2 === 0 ? n * 3 : n;
  }
  return (10 - (sum % 10)) % 10 === g.charCodeAt(g.length - 1) - 48;
}
