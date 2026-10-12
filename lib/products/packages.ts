// Medidas por bulto (feature BASE `medidas_bultos`). Lógica PURA: volumen,
// totales, peso volumétrico, formato es-AR y la geometría de la caja
// isométrica que dibuja la tarjeta. Sin React ni Supabase: testeable.

export interface ProductPackage {
  /** id en DB; null si todavía no se guardó. */
  id: string | null;
  /** clave local estable para la UI (no se persiste). */
  key: string;
  code: string;
  unitsPerPack: number;
  packCount: number;
  weightKg: number | null;
  heightCm: number | null;
  widthCm: number | null;
  depthCm: number | null;
}

let seq = 0;
export function newPackage(partial: Partial<ProductPackage> = {}): ProductPackage {
  seq += 1;
  return {
    id: null,
    key: `pkg-${Date.now().toString(36)}-${seq}`,
    code: "",
    unitsPerPack: 1,
    packCount: 1,
    weightKg: null,
    heightCm: null,
    widthCm: null,
    depthCm: null,
    ...partial,
  };
}

/** Número positivo o null (vacío, NaN, negativo → null). */
export function toPositiveOrNull(v: unknown): number | null {
  if (v === "" || v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Volumen de UN bulto en cm³ (null si falta alguna medida). */
export function packageVolumeCm3(p: Pick<ProductPackage, "heightCm" | "widthCm" | "depthCm">): number | null {
  const { heightCm: h, widthCm: w, depthCm: d } = p;
  if (!h || !w || !d) return null;
  return h * w * d;
}

/** Volumen total = volumen por bulto × cantidad de bultos. */
export function packageTotalCm3(p: ProductPackage): number | null {
  const v = packageVolumeCm3(p);
  return v == null ? null : v * Math.max(1, p.packCount || 1);
}

/** Volumen que ocupa UNA unidad de producto dentro del bulto. */
export function unitVolumeCm3(p: ProductPackage): number | null {
  const v = packageVolumeCm3(p);
  return v == null ? null : v / Math.max(p.unitsPerPack || 1, 0.001);
}

export const cm3ToM3 =(cm3: number) => cm3 / 1_000_000;

/**
 * Peso volumétrico (kg) estándar de courier: cm³ / divisor (5000 por defecto).
 */
export function volumetricWeightKg(cm3: number | null, divisor = 5000): number | null {
  if (cm3 == null || divisor <= 0) return null;
  return cm3 / divisor;
}

/** Peso a facturar por el courier: el mayor entre real y volumétrico. */
export function chargeableWeightKg(p: ProductPackage, divisor = 5000): number | null {
  const vol = volumetricWeightKg(packageVolumeCm3(p), divisor);
  const real = p.weightKg;
  if (vol == null && real == null) return null;
  return Math.max(vol ?? 0, real ?? 0);
}

const nf = (max: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: max });

/** 21285 → "21.285"; 22.5 → "22,5". */
export function formatMeasure(n: number | null | undefined, maxDecimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "";
  return nf(maxDecimals).format(n);
}

export function formatCm3(cm3: number): string {
  return `${formatMeasure(cm3, 0)} cm³`;
}

export function formatM3(cm3: number): string {
  return `${new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(cm3ToM3(cm3))} m³`;
}

/** "3 kg", "0,5 kg", "750 g" (si es menos de 1 kg). */
export function formatWeight(kg: number | null): string {
  if (kg == null) return "";
  if (kg < 1) return `${formatMeasure(kg * 1000, 0)} g`;
  return `${formatMeasure(kg, 2)} kg`;
}

/** Bulto con al menos un dato útil (para no guardar filas vacías). */
export function isPackageEmpty(p: ProductPackage): boolean {
  return (
    !p.code.trim() &&
    p.weightKg == null &&
    p.heightCm == null &&
    p.widthCm == null &&
    p.depthCm == null &&
    (p.unitsPerPack ?? 1) === 1 &&
    (p.packCount ?? 1) === 1
  );
}

// ── Geometría isométrica ───────────────────────────────────────────────────
// Proyección isométrica clásica (30°). Las medidas se normalizan para que la
// caja entre en un viewBox fijo, preservando las proporciones reales y con un
// mínimo para que una dimensión muy chica igual se vea.

export interface IsoBox {
  viewBox: string;
  top: string;
  left: string;
  right: string;
  /** cinta de embalaje sobre la tapa (centrada en el ancho). */
  tape: string;
  /** solapas: línea que divide la tapa en dos. */
  flap: string;
}

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

function iso(x: number, y: number, z: number): [number, number] {
  // x = ancho (hacia la derecha-abajo), y = profundidad (izquierda-abajo), z = alto.
  return [(x - y) * COS30, (x + y) * SIN30 - z];
}

const pt = ([a, b]: [number, number]) => `${a.toFixed(2)},${b.toFixed(2)}`;

export function isoBoxGeometry(
  heightCm: number | null,
  widthCm: number | null,
  depthCm: number | null,
  size = 120,
): IsoBox {
  // Defaults de una caja "típica" cuando falta dato (para que siempre se dibuje).
  const raw = {
    w: widthCm && widthCm > 0 ? widthCm : 30,
    d: depthCm && depthCm > 0 ? depthCm : 22,
    h: heightCm && heightCm > 0 ? heightCm : 20,
  };
  const max = Math.max(raw.w, raw.d, raw.h);
  const min = 0.28; // ninguna arista menor al 28% de la mayor
  const w = Math.max(raw.w / max, min);
  const d = Math.max(raw.d / max, min);
  const h = Math.max(raw.h / max, min);

  const P = {
    t0: iso(0, 0, h),
    t1: iso(w, 0, h),
    t2: iso(w, d, h),
    t3: iso(0, d, h),
    b1: iso(w, 0, 0),
    b2: iso(w, d, 0),
    b3: iso(0, d, 0),
  };
  const xs = Object.values(P).map((p) => p[0]);
  const ys = Object.values(P).map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const scale = (size * 0.84) / span;
  const offX = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (size - (maxY - minY) * scale) / 2 - minY * scale;
  const T = ([a, b]: [number, number]): [number, number] => [a * scale + offX, b * scale + offY];

  const tapeHalf = Math.min(0.09, w * 0.12);
  const mid = w / 2;
  const tapeTop = [
    iso(mid - tapeHalf, 0, h),
    iso(mid + tapeHalf, 0, h),
    iso(mid + tapeHalf, d, h),
    iso(mid - tapeHalf, d, h),
  ].map((p) => pt(T(p)));
  const tapeFront = [
    iso(mid - tapeHalf, d, h),
    iso(mid + tapeHalf, d, h),
    iso(mid + tapeHalf, d, h * 0.72),
    iso(mid - tapeHalf, d, h * 0.72),
  ].map((p) => pt(T(p)));

  return {
    viewBox: `0 0 ${size} ${size}`,
    top: [P.t0, P.t1, P.t2, P.t3].map((p) => pt(T(p))).join(" "),
    left: [P.t3, P.t2, P.b2, P.b3].map((p) => pt(T(p))).join(" "),
    right: [P.t1, P.t2, P.b2, P.b1].map((p) => pt(T(p))).join(" "),
    tape: `M${tapeTop.join(" L")} Z M${tapeFront.join(" L")} Z`,
    flap: `M${pt(T(iso(0, d / 2, h)))} L${pt(T(iso(w, d / 2, h)))}`,
  };
}

// ── Mapeo DB ↔ UI ──────────────────────────────────────────────────────────
export interface ProductPackageRow {
  id: string;
  idx: number;
  code: string | null;
  units_per_pack: number;
  pack_count: number;
  weight_kg: number | null;
  height_cm: number | null;
  width_cm: number | null;
  depth_cm: number | null;
}

export function packageFromRow(r: ProductPackageRow): ProductPackage {
  return newPackage({
    id: r.id,
    key: r.id,
    code: r.code ?? "",
    unitsPerPack: Number(r.units_per_pack ?? 1),
    packCount: Number(r.pack_count ?? 1),
    weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
    heightCm: r.height_cm == null ? null : Number(r.height_cm),
    widthCm: r.width_cm == null ? null : Number(r.width_cm),
    depthCm: r.depth_cm == null ? null : Number(r.depth_cm),
  });
}

export function packageToRow(p: ProductPackage, idx: number) {
  return {
    idx,
    code: p.code.trim() || null,
    units_per_pack: Math.max(p.unitsPerPack || 1, 0.001),
    pack_count: Math.max(Math.round(p.packCount || 1), 1),
    weight_kg: p.weightKg,
    height_cm: p.heightCm,
    width_cm: p.widthCm,
    depth_cm: p.depthCm,
  };
}

/**
 * Diff entre lo guardado y lo editado: qué insertar, actualizar y dar de baja
 * (lógica). El orden de la lista define el idx (1..n).
 */
export function diffPackages(saved: ProductPackage[], edited: ProductPackage[]) {
  const keep = edited.filter((p) => !isPackageEmpty(p));
  const editedIds = new Set(keep.map((p) => p.id).filter(Boolean) as string[]);
  return {
    insert: keep
      .map((p, i) => ({ p, idx: i + 1 }))
      .filter(({ p }) => !p.id)
      .map(({ p, idx }) => packageToRow(p, idx)),
    update: keep
      .map((p, i) => ({ p, idx: i + 1 }))
      .filter(({ p }) => Boolean(p.id))
      .map(({ p, idx }) => ({ id: p.id as string, ...packageToRow(p, idx) })),
    remove: saved.filter((s) => s.id && !editedIds.has(s.id)).map((s) => s.id as string),
  };
}
