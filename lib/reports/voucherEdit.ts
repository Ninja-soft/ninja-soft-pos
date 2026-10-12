// Edición de la numeración del cupón de un cobro con tarjeta (conciliación de
// tarjetas, ADR-044 adenda). Lógica pura: validación y normalización del
// formulario (espejo de las reglas de la RPC update_payment_voucher), permisos
// del lado del cliente (sólo para mostrar u ocultar el lápiz: el servidor
// decide) y lectura del historial. Sin red ni React.

export const VOUCHER_FIELDS = ["lote", "cupon", "autorizacion", "ultimos4", "comercio", "cuotas"] as const;
export type VoucherField = (typeof VOUCHER_FIELDS)[number];

export type VoucherDraft = Record<VoucherField, string>;
export type VoucherPatch = Partial<Record<VoucherField, string | number | null>>;

export const VOUCHER_FIELD_LABEL: Record<VoucherField, string> = {
  lote: "Lote",
  cupon: "Cupón",
  autorizacion: "Autorización",
  ultimos4: "Últimos 4",
  comercio: "N° de comercio",
  cuotas: "Cuotas",
};

interface FieldRule {
  /** Saca los espacios internos antes de validar (códigos numéricos). */
  compact: boolean;
  upper: boolean;
  pattern: RegExp;
  message: string;
}

const RULES: Record<VoucherField, FieldRule> = {
  lote: { compact: true, upper: false, pattern: /^\d{1,10}$/, message: "Sólo números, hasta 10." },
  cupon: { compact: true, upper: false, pattern: /^\d{1,12}$/, message: "Sólo números, hasta 12." },
  autorizacion: { compact: false, upper: true, pattern: /^[A-Z0-9]{1,20}$/, message: "Letras y números, hasta 20." },
  ultimos4: { compact: true, upper: false, pattern: /^\d{4}$/, message: "Tienen que ser 4 números." },
  comercio: { compact: true, upper: false, pattern: /^\d{1,20}$/, message: "Sólo números, hasta 20." },
  cuotas: { compact: true, upper: false, pattern: /^\d{1,2}$/, message: "Entre 1 y 99." },
};

/** Normaliza un valor del formulario: recorta, saca espacios en códigos y pasa a mayúsculas la autorización. */
export function normalizeVoucherValue(field: VoucherField, raw: string): string {
  const rule = RULES[field];
  let v = (raw ?? "").trim();
  if (rule.compact) v = v.replace(/\s+/g, "");
  if (rule.upper) v = v.toUpperCase();
  return v;
}

/** Mensaje de error del campo, o null si es válido. Vacío es válido (borra el dato). */
export function validateVoucherValue(field: VoucherField, raw: string): string | null {
  const v = normalizeVoucherValue(field, raw);
  if (!v) return null;
  const rule = RULES[field];
  if (!rule.pattern.test(v)) return rule.message;
  if (field === "cuotas") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 99) return rule.message;
  }
  return null;
}

/** Borrador inicial del formulario a partir de los valores actuales del cobro. */
export function voucherDraftFrom(current: {
  lote: string;
  cupon: string;
  autorizacion: string;
  ultimos4: string;
  comercio: string;
  installments: number | null;
}): VoucherDraft {
  return {
    lote: current.lote ?? "",
    cupon: current.cupon ?? "",
    autorizacion: current.autorizacion ?? "",
    ultimos4: current.ultimos4 ?? "",
    comercio: current.comercio ?? "",
    cuotas: current.installments != null ? String(current.installments) : "",
  };
}

export interface VoucherPatchResult {
  patch: VoucherPatch;
  changed: VoucherField[];
  errors: Partial<Record<VoucherField, string>>;
}

/**
 * Arma el patch para la RPC: sólo los campos que cambian, normalizados. Un
 * campo vaciado viaja como null (la RPC borra la clave). Cuotas va como número.
 */
export function buildVoucherPatch(initial: VoucherDraft, draft: VoucherDraft): VoucherPatchResult {
  const patch: VoucherPatch = {};
  const changed: VoucherField[] = [];
  const errors: Partial<Record<VoucherField, string>> = {};
  for (const f of VOUCHER_FIELDS) {
    const err = validateVoucherValue(f, draft[f]);
    if (err) {
      errors[f] = err;
      continue;
    }
    const next = normalizeVoucherValue(f, draft[f]);
    const prev = normalizeVoucherValue(f, initial[f]);
    if (next === prev) continue;
    changed.push(f);
    patch[f] = next === "" ? null : f === "cuotas" ? Number(next) : next;
  }
  return { patch, changed, errors };
}

// ── Permisos (espejo de la RPC, sólo para la UI) ─────────────────────────────

export type VoucherEditAccess =
  | { canEdit: true; asSupervisor: boolean }
  | { canEdit: false; reason: "role" | "not_own_shift" | "reconciled" };

/**
 * Quién puede editar la numeración: dueño o encargado, cualquier cobro (aunque
 * esté conciliado); cajero, sólo cobros de un turno que abrió él y que no estén
 * conciliados; solo lectura, nunca.
 */
export function voucherEditAccess(input: {
  role: string | null | undefined;
  userId: string | null | undefined;
  shiftOpenedBy: string | null | undefined;
  reconciled: boolean;
}): VoucherEditAccess {
  const { role, userId, shiftOpenedBy, reconciled } = input;
  if (role === "owner" || role === "manager") return { canEdit: true, asSupervisor: true };
  if (role !== "cashier" || !userId) return { canEdit: false, reason: "role" };
  if (!shiftOpenedBy || shiftOpenedBy !== userId) return { canEdit: false, reason: "not_own_shift" };
  if (reconciled) return { canEdit: false, reason: "reconciled" };
  return { canEdit: true, asSupervisor: false };
}

export const VOUCHER_ACCESS_REASON: Record<"role" | "not_own_shift" | "reconciled", string> = {
  role: "Tu rol no puede editar cupones.",
  not_own_shift: "Sólo podés editar los cobros de tus turnos de caja.",
  reconciled: "Ya está conciliado: lo corrige el dueño o un encargado.",
};

// ── Historial ────────────────────────────────────────────────────────────────

export interface RawVoucherEdit {
  id: string;
  payment_id: string;
  edited_at: string;
  edited_by_name: string | null;
  changed_keys: string[] | null;
  before_data: unknown;
  after_data: unknown;
  was_reconciled: boolean | null;
  reason: string | null;
}

export interface VoucherEdit {
  id: string;
  paymentId: string;
  editedAt: string;
  editedBy: string;
  changes: Array<{ field: VoucherField; before: string; after: string }>;
  wasReconciled: boolean;
  reason: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asText(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

export function normalizeVoucherEdit(e: RawVoucherEdit): VoucherEdit {
  const before = asRecord(e.before_data);
  const after = asRecord(e.after_data);
  const keys = (e.changed_keys ?? []).filter((k): k is VoucherField =>
    (VOUCHER_FIELDS as readonly string[]).includes(k),
  );
  return {
    id: e.id,
    paymentId: e.payment_id,
    editedAt: e.edited_at,
    editedBy: asText(e.edited_by_name) || "Usuario",
    changes: keys.map((field) => ({ field, before: asText(before[field]), after: asText(after[field]) })),
    wasReconciled: Boolean(e.was_reconciled),
    reason: asText(e.reason) || null,
  };
}

/** Ediciones por cobro, la más nueva primero. */
export function groupVoucherEdits(list: RawVoucherEdit[]): Map<string, VoucherEdit[]> {
  const out = new Map<string, VoucherEdit[]>();
  for (const raw of list) {
    const e = normalizeVoucherEdit(raw);
    const arr = out.get(e.paymentId);
    if (arr) arr.push(e);
    else out.set(e.paymentId, [e]);
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.editedAt < b.editedAt ? 1 : a.editedAt > b.editedAt ? -1 : 0));
  return out;
}

const VOUCHER_ERRORS: Array<[string, string]> = [
  ["feature_not_in_plan", "La conciliación de tarjetas no está incluida en tu plan."],
  ["not_own_shift", "Sólo podés editar los cobros de tus turnos de caja."],
  ["reconciled_locked", "El cobro ya está conciliado: lo corrige el dueño o un encargado."],
  ["forbidden", "Tu rol no puede editar cupones."],
  ["payment_not_found", "El cobro ya no existe o no es de tarjeta. Actualizá la lista."],
  ["invalid_key", "Hay un dato que no se puede editar."],
  ["invalid_value", "Revisá los datos: alguno no tiene el formato correcto."],
  ["no_tenant", "Tu sesión no tiene un negocio activo. Volvé a ingresar."],
];

export function voucherErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e ?? "");
  for (const [code, text] of VOUCHER_ERRORS) if (msg.includes(code)) return text;
  return "No se pudieron guardar los cambios. Probá de nuevo.";
}
