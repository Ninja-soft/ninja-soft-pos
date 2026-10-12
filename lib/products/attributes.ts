// Atributos libres de producto (products.attributes): lista ORDENADA de
// {key, value}. Pura y testeable. Acepta lo que venga del catálogo (objeto
// {"Contenido": "500 g"} o lista) y lo deja en la forma canónica.

export interface ProductAttribute {
  key: string;
  value: string;
}

export const ATTRIBUTE_SUGGESTIONS = [
  "Contenido",
  "Color",
  "Talle",
  "Material",
  "Sabor",
  "Origen",
  "Garantía",
  "Presentación",
] as const;

/** Normaliza cualquier entrada a [{key, value}] sin vacíos ni claves repetidas. */
export function normalizeAttributes(input: unknown): ProductAttribute[] {
  const out: ProductAttribute[] = [];
  const push = (k: unknown, v: unknown) => {
    const key = String(k ?? "").trim();
    const value =
      v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v).trim();
    if (!key || !value) return;
    const dup = out.findIndex((a) => a.key.toLowerCase() === key.toLowerCase());
    if (dup >= 0) out[dup] = { key: out[dup]!.key, value };
    else out.push({ key: key.slice(0, 60), value: value.slice(0, 200) });
  };
  if (Array.isArray(input)) {
    for (const it of input) {
      if (it && typeof it === "object") {
        const o = it as Record<string, unknown>;
        push(o.key ?? o.name ?? o.nombre, o.value ?? o.valor);
      }
    }
  } else if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) push(k, v);
  } else if (typeof input === "string" && input.trim()) {
    try {
      return normalizeAttributes(JSON.parse(input));
    } catch {
      // "Color: rojo; Talle: M"
      for (const part of input.split(/[;\n|]/)) {
        const [k, ...rest] = part.split(":");
        push(k, rest.join(":"));
      }
    }
  }
  return out;
}
