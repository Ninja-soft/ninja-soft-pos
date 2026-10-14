import { createClient } from "@/lib/supabase/client";
import { emitirVentaEnSegundoPlano } from "@/modules/arca/api";
import type { Json, Tables } from "@/types/database";
import { appOrigin } from "@/lib/site";
import { getActiveShiftId, useBranchStore } from "@/modules/branches/store";
import { parseRules, type CardVoucherRules } from "@/lib/payments/voucherRules";
import { withSupervisor } from "@/modules/security/supervisor";
import { priceDeviationPct } from "@/lib/pos/priceMismatch";
import { effectivePlans } from "@/lib/payments/planScope";
import { getnetSlotsOf } from "@/lib/payments/getnetSlots";
import { parseOfflinePolicy, type OfflinePolicy } from "@/lib/pos/offline/policy";

export type CashShift = Tables<"cash_shifts">;
export type CashRegister = Tables<"cash_registers">;

// Voucher de tarjeta (H27, ADR-042, ADR-054): datos del cupón del posnet. Dato
// operativo del cobro; viaja en el payload del pago y create_sale lo persiste en
// payments.card_voucher. Lo que se pide (y es obligatorio) lo definen las
// reglas del cupón (pos_settings.card_voucher_rules) y el trigger
// payments_card_voucher lo valida en el servidor.
export interface CardVoucher {
  lote: string;
  cupon: string;
  autorizacion: string;
  /** Entidad de la tarjeta ("Visa", "Mastercard"). */
  marca?: string;
  ultimos4?: string;
  /** N° de comercio de la marca (config del medio), para conciliar. */
  comercio?: string;
  /** Cuotas del plan elegido (conciliación). */
  cuotas?: number;
  /** Adquirente de la terminal (lib/payments/acquirers): getnet, payway... */
  adquirente?: string;
}

export interface SalePaymentInput {
  method:
    | "cash"
    | "debit"
    | "credit"
    | "transfer"
    | "qr"
    | "other"
    | "store_credit"
    | "account"
    // Directo (ADR-034): tender manual; reference = Nº de operación de Directo.
    | "directo";
  amount: number;
  reference?: string;
  // Voucher de tarjeta (lote/cupón/autorización). Opcional; sólo débito/crédito.
  card_voucher?: CardVoucher;
  // Transferencia desde el POS (ADR-055): cuenta elegida (null = por defecto).
  transfer?: { accountId: string | null };
}

/**
 * create_sale guarda card_voucher tal cual: la cuenta de la transferencia
 * viaja ahí (transfer_account_id + la marca transfer_pos) y el trigger
 * payments_transfer_account la pasa a payments.metadata.transfer y limpia
 * card_voucher (ADR-055).
 */
export function toSalePayments(payments: SalePaymentInput[]): Record<string, unknown>[] {
  return payments.map(({ transfer, ...p }) =>
    transfer && p.method === "transfer"
      ? {
          ...p,
          card_voucher: {
            transfer_pos: true,
            ...(transfer.accountId ? { transfer_account_id: transfer.accountId } : {}),
          },
        }
      : p,
  );
}
export interface SaleItemInput {
  product_id: string | null; // null = ítem de monto libre (venta rápida)
  name?: string; // nombre del ítem libre (cuando product_id es null)
  serial?: string; // N° de serie (producto serializado)
  variant_id?: string | null; // variante (producto con has_variants)
  // Modificadores elegidos (H37): snapshot { group, options[{name, price_delta}] }.
  // El precio ya está aplicado en unit_price; create_sale lo persiste en
  // sale_items.modifiers. Opcional; ausente = línea sin modificadores.
  modifiers?: { group: string; options: { name: string; price_delta: number }[] }[];
  quantity: number;
  unit_price: number;
  discount: number;
  // F18 · H100 (ADR-056): el servidor recalcula el precio. Regalo de promo y
  // línea cubierta por pack explican el $0; price_override + override_reason
  // marcan el cambio manual (list_price es informativo, para el monto del PIN).
  gift_promo_id?: string;
  pack_credit_id?: string;
  price_override?: boolean;
  override_reason?: string;
  list_price?: number;
  // ADR-096: línea de garantía extendida enlazada (plan e índice en p_items
  // de la línea que cubre).
  warranty_plan_id?: string;
  warranty_for?: number;
  // ADR-116: aclaración libre, descripción ampliada y aclaraciones elegidas
  // del renglón (sin la clave, create_sale toma las del servicio).
  line_note?: string;
  line_detail?: string;
  clarification_ids?: string[];
}

/** ADR-116: período del servicio y vencimiento del pago (AAAA-MM-DD). */
export interface SaleServiceInput {
  from: string;
  to: string;
  due: string;
}
export interface CreateSaleResult {
  sale_id: string;
  number: number;
  total: number;
  /** ADR-088: lo que salió de la reserva porque el salón no alcanzaba (aviso). */
  reserve_taken?: { product_id: string; taken: number; from: { name: string; qty: number }[] }[];
  /** ADR-088: seña del turno aplicada. */
  deposit_applied?: number;
}

// Descriptor de un extra del cobro. Viaja en `p_extras` y create_sale lo
// interpreta según `kind`:
//   * 'warranty' (prima de garantía extendida): se gatea contra 'garantias'.
//   * 'surcharge' (recargo de medio/plan): no se gatea.
//     warranty/surcharge además entran como ítem de venta en `items` (no se
//     duplica el total) — el extra acá es sólo la señal de gating.
//   * 'tip' (propina · H39): NO es ítem ni parte del total de productos.
//     create_sale la persiste en sales.tip_amount/tip_method. El importe SÍ se
//     suma al pago (el cajero la cobra), pero no a sales.total. `method` = medio
//     de la propina (efectivo/tarjeta/QR).
//   * 'professional' (atribución · H39): vendedor/profesional de la venta para
//     la comisión. `id` = professionals.id. Sin él (y sin turno), sin comisión.
//   * 'pack' (vender pack · H41): acredita un saldo de sesiones al cliente.
//     `id` = service_packs.id. El pack ya entra como ítem por su precio (en
//     `items`); este extra es sólo la señal para acreditar el saldo.
//   * 'pack_session' (consumir sesión · H41): descuenta una sesión del crédito.
//     `id` = customer_pack_credits.id. La línea cubierta ya entra en 0 (en
//     `items`); este extra es la señal para consumir la sesión.
//   * 'appointment' (cobro de un turno · ADR-088): `id` = appointments.id.
//     create_sale enlaza el turno en la misma transacción y exige que la seña
//     disponible venga como pago 'sena' (sin doble cobro).
//   * 'reservation' (retiro de una reserva de stock · ADR-096): `id` =
//     stock_reservations.id, con la identidad ya validada. create_sale exige
//     que la venta cubra sus renglones y la entrega en la misma transacción.
export interface SaleExtraInput {
  kind: "warranty" | "surcharge" | "tip" | "professional" | "pack" | "pack_session" | "appointment" | "reservation";
  amount?: number;
  method?: string;
  id?: string;
}

// Profesional/vendedor (H38). Se reutiliza en el POS (selector de atribución de
// comisión) y en el reporte de productividad (H39).
export interface Professional {
  id: string;
  name: string;
  color: string;
  commission_pct: number | null;
  is_active: boolean;
  user_id: string | null;
  sort: number;
}

export interface QrIntentRow {
  id: string;
  provider_key: string;
  amount: number;
  status: string;
  mp_payment_id: string | null;
  created_at: string;
  saleNumber: number | null;
  saleStatus: string | null;
}

// payment_plans.valid_from / valid_until (H27) aún no están en los tipos
// generados (no se regeneran en este PR): se intersectan acá. NULL = sin límite.
export type PaymentPlan = Tables<"payment_plans"> & {
  valid_from: string | null;
  valid_until: string | null;
};
export interface PaymentPlanInput {
  provider_key: string;
  label: string;
  base: string;
  brand: string | null;
  installments: number;
  surcharge_pct: number;
  sort?: number;
  code?: string | null;
  // Vigencia del plan (fechas de calendario del negocio). NULL = sin límite.
  valid_from?: string | null;
  valid_until?: string | null;
}

// Un plan está vigente si valid_from <= hoy <= (valid_until ?? ∞). Espeja
// isDiscountActive (modules/internal/api.ts): fecha LOCAL del negocio, no UTC.
// Los planes fuera de vigencia no se ofrecen al cobrar.
export function isPlanActive(
  p: Pick<PaymentPlan, "valid_from" | "valid_until">,
  today: Date = new Date(),
): boolean {
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (p.valid_from && p.valid_from > t) return false;
  if (p.valid_until && p.valid_until < t) return false;
  return true;
}

// Code estable por combinación (base+marca+cuotas). Permite upsert/dedupe de
// celdas del grid y del import XLSX dentro de un mismo medio.
export function planCode(base: string, brand: string | null, installments: number): string {
  return `${base}_${brand ?? "na"}_${installments}c`;
}

// Plantilla de planes típicos AR (sin provider; se inyecta al sembrar).
export const TYPICAL_AR_PLANS: Omit<PaymentPlanInput, "provider_key">[] = [
  { code: "debito_visa", label: "Débito Visa", base: "debito", brand: "visa", installments: 1, surcharge_pct: 0, sort: 10 },
  { code: "debito_master", label: "Débito Mastercard", base: "debito", brand: "master", installments: 1, surcharge_pct: 0, sort: 11 },
  { code: "debito_maestro", label: "Débito Maestro", base: "debito", brand: "maestro", installments: 1, surcharge_pct: 0, sort: 12 },
  { code: "debito_cabal", label: "Débito Cabal", base: "debito", brand: "cabal", installments: 1, surcharge_pct: 0, sort: 13 },
  { code: "credito_visa_1", label: "Crédito Visa 1 pago", base: "credito", brand: "visa", installments: 1, surcharge_pct: 0, sort: 20 },
  { code: "credito_visa_3", label: "Crédito Visa 3 cuotas", base: "credito", brand: "visa", installments: 3, surcharge_pct: 0, sort: 21 },
  { code: "credito_visa_6", label: "Crédito Visa 6 cuotas", base: "credito", brand: "visa", installments: 6, surcharge_pct: 0, sort: 22 },
  { code: "credito_master_1", label: "Crédito Mastercard 1 pago", base: "credito", brand: "master", installments: 1, surcharge_pct: 0, sort: 30 },
  { code: "credito_master_3", label: "Crédito Mastercard 3 cuotas", base: "credito", brand: "master", installments: 3, surcharge_pct: 0, sort: 31 },
  { code: "credito_master_6", label: "Crédito Mastercard 6 cuotas", base: "credito", brand: "master", installments: 6, surcharge_pct: 0, sort: 32 },
];

function planRow(v: PaymentPlanInput) {
  return {
    provider_key: v.provider_key,
    label: v.label,
    base: v.base,
    brand: v.brand,
    installments: v.installments,
    surcharge_pct: v.surcharge_pct,
    sort: v.sort ?? 0,
    code: v.code ?? planCode(v.base, v.brand, v.installments),
    // Vigencia: sólo se incluye en el upsert cuando viene explícita, para que un
    // edit de recargo (setCell sin fechas) no pise la vigencia ya cargada.
    ...(v.valid_from !== undefined ? { valid_from: v.valid_from } : {}),
    ...(v.valid_until !== undefined ? { valid_until: v.valid_until } : {}),
  };
}

// ── Alcance de los planes (F17 · ADR-057) ───────────────────────────────────
// null = planes del negocio; un id = planes propios de esa sucursal. Antes de
// la migración 20261020110000 la columna store_id no existe: cada consulta
// con alcance cae a la consulta de siempre (sólo hay planes del negocio).
type PlanScope = string | null;

function isMissingScopeColumn(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  return (
    e.code === "42703" ||
    e.code === "PGRST204" ||
    e.code === "42P10" ||
    /store_id/.test(e.message ?? "")
  );
}

type ScopeFilterable<Q> = { or: (filters: string) => Q };

function scoped<Q extends ScopeFilterable<Q>>(q: Q, storeId: PlanScope): Q {
  return q.or(storeId ? `store_id.eq.${storeId}` : "store_id.is.null");
}

function scopedRow(v: PaymentPlanInput, storeId: PlanScope) {
  const row = planRow(v);
  return storeId ? { ...row, store_id: storeId } : row;
}

const SCOPED_CONFLICT = "tenant_id,provider_key,code,store_id";
const LEGACY_CONFLICT = "tenant_id,provider_key,code";

export const paymentPlansApi = {
  // Planes de un medio para el editor: los del negocio y, con sucursal, los
  // propios de esa sucursal (la grilla resuelve la herencia con planScope).
  listByProvider: async (
    providerKey: string,
    activeOnly = false,
    storeId: PlanScope = null,
  ): Promise<PaymentPlan[]> => {
    const supabase = createClient();
    const build = (withScope: boolean) => {
      let q = supabase
        .from("payment_plans")
        .select("*")
        .eq("provider_key", providerKey)
        .order("sort")
        .order("label");
      if (activeOnly) q = q.eq("is_active", true);
      if (withScope) q = q.or(storeId ? `store_id.is.null,store_id.eq.${storeId}` : "store_id.is.null");
      return q;
    };
    const r = await build(true);
    if (r.error && isMissingScopeColumn(r.error)) {
      const legacy = await build(false);
      return (legacy.data ?? []) as PaymentPlan[];
    }
    return (r.data ?? []) as PaymentPlan[];
  },

  // Planes efectivos para cobrar en una sucursal (null = sólo los del
  // negocio). Trae activos e inactivos del alcance para que una fila inactiva
  // de la sucursal oculte el plan del negocio.
  listActive: async (storeId: PlanScope = null, multiStore = true): Promise<PaymentPlan[]> => {
    const supabase = createClient();
    const scopedQ = await supabase
      .from("payment_plans")
      .select("*")
      .or(storeId && multiStore ? `store_id.is.null,store_id.eq.${storeId}` : "store_id.is.null")
      .order("sort")
      .order("label");
    if (scopedQ.error && isMissingScopeColumn(scopedQ.error)) {
      const { data } = await supabase
        .from("payment_plans")
        .select("*")
        .eq("is_active", true)
        .order("sort")
        .order("label");
      return (data ?? []) as PaymentPlan[];
    }
    return effectivePlans((scopedQ.data ?? []) as PaymentPlan[], storeId, multiStore);
  },

  create: async (v: PaymentPlanInput, storeId: PlanScope = null): Promise<void> => {
    const supabase = createClient();
    // valid_from/valid_until no están en los tipos generados (no se regeneran): cast.
    const { error } = await supabase.from("payment_plans").insert(scopedRow(v, storeId) as never);
    if (error) throw error;
  },

  update: async (id: string, v: Partial<PaymentPlanInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update(v as never).eq("id", id);
    if (error) throw error;
  },

  // Celda del grid: crea o actualiza el plan (provider+base+marca+cuotas) del
  // alcance. En una sucursal, `isActive` false oculta el plan del negocio.
  setCell: async (v: PaymentPlanInput, storeId: PlanScope = null, isActive = true): Promise<void> => {
    const supabase = createClient();
    const row = { ...scopedRow(v, storeId), is_active: isActive };
    const r = await supabase.from("payment_plans").upsert(row as never, { onConflict: SCOPED_CONFLICT });
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await supabase.from("payment_plans").upsert(row as never, { onConflict: LEGACY_CONFLICT });
      if (legacy.error) throw legacy.error;
      return;
    }
    if (r.error) throw r.error;
  },

  // Vigencia por celda (provider+code): set targeteado que NO toca el recargo.
  setCellValidity: async (
    providerKey: string,
    base: string,
    brand: string | null,
    installments: number,
    validFrom: string | null,
    validUntil: string | null,
    storeId: PlanScope = null,
  ): Promise<void> => {
    const supabase = createClient();
    const run = (withScope: boolean) => {
      const q = supabase
        .from("payment_plans")
        .update({ valid_from: validFrom, valid_until: validUntil } as never)
        .eq("provider_key", providerKey)
        .eq("code", planCode(base, brand, installments));
      return withScope ? scoped(q, storeId) : q;
    };
    const r = await run(true);
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await run(false);
      if (legacy.error) throw legacy.error;
      return;
    }
    if (r.error) throw r.error;
  },

  // Vigencia para TODOS los planes de un medio en el alcance (campaña de
  // financiación del medio).
  setProviderValidity: async (
    providerKey: string,
    validFrom: string | null,
    validUntil: string | null,
    storeId: PlanScope = null,
  ): Promise<void> => {
    const supabase = createClient();
    const run = (withScope: boolean) => {
      const q = supabase
        .from("payment_plans")
        .update({ valid_from: validFrom, valid_until: validUntil } as never)
        .eq("provider_key", providerKey);
      return withScope ? scoped(q, storeId) : q;
    };
    const r = await run(true);
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await run(false);
      if (legacy.error) throw legacy.error;
      return;
    }
    if (r.error) throw r.error;
  },

  // Borra la celda (combinación) de un medio en el alcance. En una sucursal
  // es "volver a heredar" el plan del negocio.
  removeCell: async (
    providerKey: string,
    base: string,
    brand: string | null,
    installments: number,
    storeId: PlanScope = null,
  ): Promise<void> => {
    const supabase = createClient();
    const run = (withScope: boolean) => {
      const q = supabase
        .from("payment_plans")
        .delete()
        .eq("provider_key", providerKey)
        .eq("code", planCode(base, brand, installments));
      return withScope ? scoped(q, storeId) : q;
    };
    const r = await run(true);
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await run(false);
      if (legacy.error) throw legacy.error;
      return;
    }
    if (r.error) throw r.error;
  },

  // Siembra los planes AR que falten en el medio (no pisa los existentes).
  seedTypical: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
    storeId: PlanScope = null,
  ): Promise<number> => {
    const supabase = createClient();
    const payload = rows.map((r) => scopedRow({ ...r, provider_key: providerKey }, storeId));
    const r = await supabase
      .from("payment_plans")
      .upsert(payload as never, { onConflict: SCOPED_CONFLICT, ignoreDuplicates: true })
      .select("id");
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await supabase
        .from("payment_plans")
        .upsert(payload as never, { onConflict: LEGACY_CONFLICT, ignoreDuplicates: true })
        .select("id");
      if (legacy.error) throw legacy.error;
      return (legacy.data ?? []).length;
    }
    if (r.error) throw r.error;
    return (r.data ?? []).length;
  },

  // Import XLSX: agrega/actualiza (upsert por code) sin borrar el resto.
  bulkUpsert: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
    storeId: PlanScope = null,
  ): Promise<number> => {
    if (rows.length === 0) return 0;
    const supabase = createClient();
    const payload = rows.map((r) => ({
      ...scopedRow({ ...r, provider_key: providerKey }, storeId),
      is_active: true,
    }));
    const r = await supabase.from("payment_plans").upsert(payload as never, { onConflict: SCOPED_CONFLICT });
    if (r.error && !storeId && isMissingScopeColumn(r.error)) {
      const legacy = await supabase.from("payment_plans").upsert(payload as never, { onConflict: LEGACY_CONFLICT });
      if (legacy.error) throw legacy.error;
      return rows.length;
    }
    if (r.error) throw r.error;
    return rows.length;
  },

  // Import XLSX: reemplaza todos los planes del medio en el alcance por los
  // del archivo (en una sucursal, sólo los propios: los del negocio quedan).
  replaceProvider: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
    storeId: PlanScope = null,
  ): Promise<number> => {
    const supabase = createClient();
    const del = (withScope: boolean) => {
      const q = supabase.from("payment_plans").delete().eq("provider_key", providerKey);
      return withScope ? scoped(q, storeId) : q;
    };
    let d = await del(true);
    if (d.error && !storeId && isMissingScopeColumn(d.error)) d = await del(false);
    if (d.error) throw d.error;
    if (rows.length === 0) return 0;
    const { error } = await supabase
      .from("payment_plans")
      .insert(rows.map((r) => scopedRow({ ...r, provider_key: providerKey }, storeId)) as never);
    if (error) throw error;
    return rows.length;
  },

  setActive: async (id: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update({ is_active }).eq("id", id);
    if (error) throw error;
  },
  // Activa/desactiva todos los planes del negocio de un medio (modo "recargo
  // único" del medio desactiva los planes para que no se ofrezcan al cobrar).
  // Los planes propios de las sucursales no se tocan.
  setProviderActive: async (providerKey: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const run = (withScope: boolean) => {
      const q = supabase.from("payment_plans").update({ is_active }).eq("provider_key", providerKey);
      return withScope ? scoped(q, null) : q;
    };
    let r = await run(true);
    if (r.error && isMissingScopeColumn(r.error)) r = await run(false);
    if (r.error) throw r.error;
  },
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").delete().eq("id", id);
    if (error) throw error;
  },
};

// Profesionales/vendedores del tenant (H38). Tabla `professionals` no está en
// los tipos generados (no se regeneran): from("professionals") + cast.
export const professionalsApi = {
  // Activos (no dados de baja), ordenados por `sort` y nombre. Para el selector
  // de atribución de comisión en el POS y el filtro del reporte. La tabla
  // `professionals` no está en los tipos generados (no se regeneran): cast.
  listActive: async (): Promise<Professional[]> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("professionals" as never)
      .select("id, name, color, commission_pct, is_active, user_id, sort")
      .is("deleted_at", null)
      .eq("is_active", true)
      .order("sort")
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as Professional[];
  },
};

export interface MpQrGeocodeResult {
  draft?: {
    name: string;
    street_name: string;
    street_number: string;
    city_name: string;
    state_name: string;
  };
  place: {
    lat: number;
    lon: number;
    precise: boolean;
    label: string;
    city_name: string;
    state_name: string;
  } | null;
  geocode_error?: string;
}

// Edge mp_qr: supabase-js envuelve los no-2xx; leemos el body para devolver
// el código (y el campo) que entiende mapMpQrError.
async function invokeMpQr<T>(body: Record<string, unknown>): Promise<T> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("mp_qr", { body });
  let res = data as { error?: string; field?: string | null } | null;
  if (error) {
    const ctx = (error as { context?: Response }).context;
    try {
      res = ctx ? await ctx.json() : null;
    } catch {
      res = null;
    }
    if (!res?.error) throw new Error("mp_error");
  }
  if (res?.error) throw new Error(res.field ? `${res.error}:${res.field}` : res.error);
  return data as T;
}

// Settings operativos del POS (H30): descuento máximo por rol y redondeo.
// Incluye los settings de la pantalla del cliente (H25): mostrar precios
// unitarios y mensajes de idle/agradecimiento.
export interface PosSettingsView {
  maxDiscount: Record<string, number>;
  rounding: number;
  requireCustomer: boolean;
  scannerPrefix: string;
  scannerSuffix: string;
  scannerBeep: boolean;
  scannerDupMs: number;
  displayShowUnitPrices: boolean;
  displayWelcomeMessage: string | null;
  displayThanksMessage: string | null;
  // Oferta contextual automática de garantía extendida en el POS (H28).
  offerWarranty: boolean;
  // Exigir voucher de tarjeta (lote/cupón/autorización) en débito/crédito (H27).
  requireCardVoucher: boolean;
  // Habilita la "Venta libre" (monto manual) en el POS (H36). El rol además
  // debe ser owner/manager (chequeo en la página). Default true.
  allowFreeSale: boolean;
  // Si está activo, un profesional/cajero ve sólo su propia agenda/ventas/
  // comisión; el owner ve todo (H39). Default false (todos ven todo).
  staffSeesOwnOnly: boolean;
  // Diseño del POS del negocio (pos_settings.pos_layout, sin validar: pasa
  // por resolveLayout de lib/pos/layout.ts). null = nunca se configuró.
  posLayout: unknown;
  // Venta con stock negativo permitida (pos_settings.allow_negative_stock).
  allowNegativeStock: boolean;
  // Reglas del cupón del posnet offline (ADR-054), ya normalizadas.
  cardVoucherRules: CardVoucherRules;
  // Venta sin conexión (ADR-077): pos_settings.offline_policy con defaults.
  offlinePolicy: OfflinePolicy;
}

export function mapPosSettings(raw: Record<string, unknown> | null): PosSettingsView | null {
  if (!raw) return null;
  const data = raw;
  return {
    maxDiscount: (data.max_discount as Record<string, number>) ?? {},
    rounding: Number(data.rounding_multiple) || 0,
    requireCustomer: Boolean(data.require_customer),
    scannerPrefix: (data.scanner_prefix as string) ?? "",
    scannerSuffix: (data.scanner_suffix as string) ?? "",
    scannerBeep: (data.scanner_beep as boolean) ?? true,
    scannerDupMs: Number(data.scanner_dup_ms ?? 1500),
    displayShowUnitPrices: (data.display_show_unit_prices as boolean) ?? true,
    displayWelcomeMessage: (data.display_welcome_message as string | null) ?? null,
    displayThanksMessage: (data.display_thanks_message as string | null) ?? null,
    // Default true: si la columna no existe aún (settings viejos), se ofrece.
    offerWarranty: (data.offer_warranty as boolean | undefined) ?? true,
    // Default false: por defecto NO se exige voucher de tarjeta.
    requireCardVoucher: (data.require_card_voucher as boolean | undefined) ?? false,
    // Default true: la venta libre queda habilitada (igual que hoy donde el
    // rubro quickSale ya la mostraba). El dueño puede apagarla en Configuración.
    allowFreeSale: (data.allow_free_sale as boolean | undefined) ?? true,
    // Default false: por defecto el staff ve todo (no se restringe).
    staffSeesOwnOnly: (data.staff_sees_own_only as boolean | undefined) ?? false,
    posLayout: data.pos_layout ?? null,
    allowNegativeStock: (data.allow_negative_stock as boolean | undefined) ?? true,
    cardVoucherRules: parseRules(data.card_voucher_rules),
    offlinePolicy: parseOfflinePolicy(data.offline_policy),
  };
}

// Lugar del cobro presencial (F17 · H93, ADR-049): terminal del registro
// (payment_terminals) y sucursal / caja del POS. La Edge valida en el servidor
// que la terminal sea del negocio y de esa sucursal, y que la sucursal o la
// caja no hayan apagado el medio. Todo opcional: sin datos, el flujo de antes.
export interface PaymentLocation {
  terminalId?: string | null;
  storeId?: string | null;
  registerId?: string | null;
}

function locationBody(loc?: PaymentLocation): Record<string, string> {
  const out: Record<string, string> = {};
  if (loc?.terminalId) out.terminal_id = loc.terminalId;
  if (loc?.storeId) out.store_id = loc.storeId;
  if (loc?.registerId) out.register_id = loc.registerId;
  return out;
}

// Sucursal del POS de este dispositivo (F17 · ADR-057): las Edges de cobro la
// usan para elegir la credencial de la sucursal (o la del negocio si no tiene
// propia). Sin sucursal elegida, no se manda y vale la del negocio.
function posStoreBody(): Record<string, string> {
  const id = useBranchStore.getState().posStoreId;
  return id ? { store_id: id } : {};
}

// supabase-js envuelve los no-2xx: se lee el código del body para mostrarlo.
async function edgeError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response }).context;
  try {
    const body = ctx ? ((await ctx.json()) as { error?: string }) : null;
    if (body?.error) return new Error(body.error);
  } catch {
    // body no JSON: se usa el error original.
  }
  return error instanceof Error ? error : new Error("edge_error");
}

/**
 * ¿Está habilitado el checkout propio de Getnet? (ADR-069 adenda). La Edge
 * getnet (action capabilities) devuelve sólo un booleano del flag PCI, nunca
 * el secret. Cualquier error = apagado.
 */
async function fetchGetnetOwnCheckout(): Promise<boolean> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("getnet", { body: { action: "capabilities" } });
    if (error) return false;
    return (data as { own_checkout_enabled?: unknown } | null)?.own_checkout_enabled === true;
  } catch {
    return false;
  }
}

export const posApi = {
  // Turno abierto de una caja. Sin caja (no hay ninguna operable) cae al
  // criterio histórico: el último turno abierto visible para el usuario.
  openShift: async (registerId?: string | null): Promise<CashShift | null> => {
    const supabase = createClient();
    let q = supabase.from("cash_shifts").select("*").eq("status", "open");
    if (registerId) q = q.eq("cash_register_id", registerId);
    const { data, error } = await q
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  open: async (registerId: string, opening: number): Promise<string> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("open_cash_shift", {
      p_register_id: registerId,
      p_opening_amount: opening,
    });
    if (error) throw error;
    return data as string;
  },

  close: async (
    shiftId: string,
    closing: number,
    notes?: string,
    // Cobros en espera del turno (ADR-048): cancelarlos o pasarlos a la
    // próxima apertura. Sin cobros abiertos no hace falta.
    pendingAction?: "cancel" | "carry" | null,
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("close_cash_shift", {
      p_shift_id: shiftId,
      p_closing_amount: closing,
      p_notes: notes,
      ...(pendingAction ? { p_pending_action: pendingAction } : {}),
    } as never);
    if (error) throw error;
    return data as number;
  },

  // ¿Un medio (provider) está habilitado y conectado?
  providerMethod: async (
    providerKey: string,
  ): Promise<{ enabled: boolean; connected: boolean }> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("tenant_payment_methods")
      .select("enabled, config")
      .eq("provider_key", providerKey)
      .maybeSingle();
    return {
      enabled: Boolean(data?.enabled),
      connected: Boolean((data?.config as { connected?: boolean } | null)?.connected),
    };
  },
  mpMethod: async (): Promise<{ enabled: boolean; connected: boolean }> =>
    posApi.providerMethod("mercadopago"),

  // Crea el checkout/QR de Mobbex y devuelve el init_point (URL para QR).
  // customerId (opcional): cliente de la venta, para el `customer` que pide
  // Mobbex; sin cliente la Edge usa un consumidor final neutro.
  createMobbexQr: async (
    amount: number,
    title: string,
    customerId?: string | null,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mobbex_create_qr", {
      body: { amount, title, customer_id: customerId ?? null, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  // Crea la intención de cobro/QR de MODO y devuelve el init_point (URL/deeplink
  // para QR). Espeja createMobbexQr. La Edge modo_create_qr valida el plan
  // (feature 'modo') antes de crear el intent.
  createModoQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("modo_create_qr", {
      body: { amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  // Medios de pago habilitados por el tenant (H14).
  // Retorna filas de tenant_payment_methods donde enabled=true.
  enabledMethods: async (): Promise<
    Array<{ provider_key: string; surcharge_pct: number; config: Record<string, unknown> }>
  > => {
    const supabase = createClient();
    const { data } = await supabase
      .from("tenant_payment_methods")
      .select("provider_key, surcharge_pct, config")
      .eq("enabled", true)
      .order("sort");
    return (data ?? []) as Array<{
      provider_key: string;
      surcharge_pct: number;
      config: Record<string, unknown>;
    }>;
  },

  // Estado de TODOS los medios del tenant (habilitado + conectado + recargo).
  // Alimenta el registro de tenders del POS (lib/pos/tenders.ts): un Point usa
  // la conexión de su marca aunque el QR de esa marca esté apagado.
  paymentMethodsStatus: async (): Promise<
    Array<{
      provider_key: string;
      enabled: boolean;
      connected: boolean;
      surcharge_pct: number;
      merchant_numbers: Partial<Record<string, string>>;
      plan_mode: string | null;
      /** Sólo 'getnet' (ADR-069): Web Checkout y Checkout API cargados. */
      web_checkout_connected?: boolean;
      checkout_api_connected?: boolean;
      /** Sólo 'getnet' (ADR-069 adenda): checkout propio habilitado (flag PCI). */
      own_checkout_enabled?: boolean;
      /** Sólo 'transfer' (ADR-055): base del negocio de la pantalla y el n° de operación. */
      transfer_show_screen?: boolean;
      transfer_require_reference?: boolean;
    }>
  > => {
    const supabase = createClient();
    const { data } = await supabase
      .from("tenant_payment_methods")
      .select("provider_key, enabled, config, surcharge_pct")
      .order("sort");
    const rows = (data ?? []).map((r) => ({
      provider_key: r.provider_key as string,
      enabled: Boolean(r.enabled),
      connected: Boolean((r.config as { connected?: boolean } | null)?.connected),
      surcharge_pct: Number(r.surcharge_pct) || 0,
      merchant_numbers:
        ((r.config as { merchant_numbers?: Partial<Record<string, string>> } | null)?.merchant_numbers) ?? {},
      plan_mode: (r.config as { plan_mode?: string } | null)?.plan_mode ?? null,
      ...(r.provider_key === "getnet"
        ? (() => {
            const slots = getnetSlotsOf(r.config as Record<string, unknown> | null);
            return { web_checkout_connected: slots.web_checkout, checkout_api_connected: slots.checkout_api };
          })()
        : {}),
      ...(r.provider_key === "transfer"
        ? {
            transfer_show_screen:
              (r.config as { transfer_show_screen?: boolean } | null)?.transfer_show_screen !== false,
            transfer_require_reference:
              (r.config as { transfer_require_reference?: boolean } | null)?.transfer_require_reference === true,
          }
        : {}),
    }));
    // Getnet (ADR-069 adenda): el tender "Link (checkout propio)" sólo con el
    // checkout propio habilitado. Se pregunta a la Edge sólo si hay Checkout
    // API cargada; ante cualquier duda queda apagado.
    const getnet = rows.find((r) => r.provider_key === "getnet") as { checkout_api_connected?: boolean } | undefined;
    if (!getnet?.checkout_api_connected) return rows;
    const own = await fetchGetnetOwnCheckout();
    return rows.map((r) => (r.provider_key === "getnet" ? { ...r, own_checkout_enabled: own } : r));
  },

  /** ¿Está habilitado el checkout propio de Getnet? (ADR-069 adenda). */
  getnetOwnCheckoutEnabled: () => fetchGetnetOwnCheckout(),


  // Settings operativos del POS (H30): descuento máximo por rol y redondeo.
  // Incluye los settings de la pantalla del cliente (H25): mostrar precios
  // unitarios y mensajes de idle/agradecimiento.
  // Fila cruda de pos_settings del negocio (la herencia por sucursal y caja
  // se aplica en usePosSettings, F17 · H92).
  posSettingsRaw: async (): Promise<Record<string, unknown> | null> => {
    const supabase = createClient();
    // Las columnas display_* (H25) y offer_warranty (H28) aún no están en los
    // tipos generados (no se regeneran): select("*") + cast del payload.
    const { data: raw } = await supabase.from("pos_settings").select("*").maybeSingle();
    return (raw as Record<string, unknown> | null) ?? null;
  },

  posSettings: async (): Promise<PosSettingsView | null> => mapPosSettings(await posApi.posSettingsRaw()),

  // Crea la preferencia/QR de cobro y devuelve el init_point.
  createMpQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_create_qr", {
      body: { amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  // Estado en vivo del intent (el POS consulta mientras espera el pago).
  mpIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("mp_payment_intents")
      .select("status, mp_payment_id")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return {
      status: data?.status ?? "pending",
      mp_payment_id: data?.mp_payment_id ?? null,
    };
  },

  // ── Mercado Pago QR dinámico (Orders API, ADR-032) ─────────────────────────
  // Edge mp_qr: order type "qr" atada a la caja del tenant. Devuelve el
  // qr_data (EMVCo) que el POS dibuja local. Sin caja configurada lanza
  // "qr_pos_not_configured" y el modal cae al link de Checkout Pro.
  createMpOrderQr: async (
    amount: number,
    title: string,
    loc?: PaymentLocation,
  ): Promise<{ intent_id: string; init_point: string; order_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_qr", {
      body: { action: "create", amount, title, ...locationBody(loc) },
    });
    if (error) throw await edgeError(error);
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    const r = data as { intent_id: string; qr_data: string; order_id: string };
    return { intent_id: r.intent_id, init_point: r.qr_data, order_id: r.order_id };
  },

  // Estado de una order QR: la Edge sincroniza contra GET /v1/orders/{id}
  // (funciona aunque el webhook no esté configurado en la cuenta de MP).
  mpOrderStatus: async (
    intentId: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_qr", {
      body: { action: "status", intent_id: intentId },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  cancelMpOrder: async (intentId: string): Promise<void> => {
    const supabase = createClient();
    await supabase.functions.invoke("mp_qr", {
      body: { action: "cancel", intent_id: intentId },
    });
  },

  // "QR en el mostrador" (alta única del local en MP, owner/manager). Los
  // errores llegan como Error("codigo" o "codigo:campo"): ver mapMpQrError.
  // Borrador con los datos del negocio + ubicación en el mapa (sin dirección),
  // o ubicación de la dirección corregida.
  mpQrGeocode: async (address?: {
    street_name: string;
    street_number: string;
    city_name: string;
    state_name: string;
  }): Promise<MpQrGeocodeResult> =>
    invokeMpQr<MpQrGeocodeResult>({ action: "geocode", ...(address ?? {}) }),

  // Guarda los ids en tenant_payment_methods(mercadopago).config.mp_qr[env].
  mpQrSetup: async (input: {
    name: string;
    street_name: string;
    street_number: string;
    city_name: string;
    state_name: string;
    latitude?: number;
    longitude?: number;
    coordinates?: string;
    reference?: string;
    // F17 · ADR-049: caja QR propia de una caja (sin esto, la caja única).
    cash_register_id?: string;
  }): Promise<{ env: "prod" | "test" }> => {
    const res = await invokeMpQr<{ env?: "prod" | "test" }>({ action: "setup", ...input });
    return { env: res.env ?? "prod" };
  },

  mpQrReset: async (cashRegisterId?: string): Promise<void> => {
    await invokeMpQr({ action: "reset", ...(cashRegisterId ? { cash_register_id: cashRegisterId } : {}) });
  },

  // ── Mercado Point (H15 resto): cobro presencial en el lector ───────────────
  // Todas pasan por la Edge mp_point (usa la conexión MP del tenant; gating de
  // plan server-side en create). El POS sondea pointIntentStatus hasta approved.
  pointDevices: async (): Promise<{ id: string; operating_mode: string }[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_point", {
      body: { action: "devices", ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return (data as { devices: { id: string; operating_mode: string }[] }).devices;
  },

  pointSetPdv: async (deviceId: string): Promise<void> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_point", {
      body: { action: "pdv", device_id: deviceId, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
  },

  // Orders API type "point" (ADR-032). Sin `installments` el cliente elige
  // medio y cuotas en el lector; con cuotas > 1 se preselecciona crédito.
  createPointIntent: async (
    deviceId: string,
    amount: number,
    opts?: { installments?: number; defaultType?: "debit_card" | "credit_card" },
    loc?: PaymentLocation,
  ): Promise<{ intent_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_point", {
      body: {
        action: "create",
        device_id: deviceId,
        ...locationBody(loc),
        amount,
        ...(opts?.installments ? { installments: opts.installments } : {}),
        ...(opts?.defaultType ? { default_type: opts.defaultType } : {}),
      },
    });
    if (error) throw await edgeError(error);
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string };
  },

  pointIntentStatus: async (
    intentId: string,
  ): Promise<{
    status: string;
    mp_payment_id: string | null;
    card_type: "debit" | "credit" | null;
  }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_point", {
      body: { action: "status", intent_id: intentId },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as {
      status: string;
      mp_payment_id: string | null;
      card_type: "debit" | "credit" | null;
    };
  },

  // Cancela en el lector. Si la order ya estaba en la terminal (at_terminal)
  // MP responde 202: la cancelación queda pedida y el estado final llega por
  // status (cancel_requested=true → el modal sigue sondeando).
  cancelPointIntent: async (
    intentId: string,
  ): Promise<{ status: string; cancel_requested: boolean }> => {
    const supabase = createClient();
    const { data } = await supabase.functions.invoke("mp_point", {
      body: { action: "cancel", intent_id: intentId },
    });
    const r = (data ?? {}) as { status?: string; cancel_requested?: boolean };
    return { status: r.status ?? "pending", cancel_requested: Boolean(r.cancel_requested) };
  },

  // ── Pagos360 (H21): link de pago / checkout hosted ─────────────────────────
  // create devuelve el checkout_url como init_point (QR + "Abrir link de pago").
  // Sin webhook: el estado se sondea vía la Edge (sincroniza contra Pagos360).
  createPagos360Link: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("pagos360", {
      body: { action: "create", amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  // ── Payway (H17): formulario de pago hosted ────────────────────────────────
  createPaywayLink: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    // El QR abre el checkout PROPIO de la tienda (/pagar/{intent}): el cliente
    // elige tarjeta y cuotas ahí. origin = dominio canónico en producción
    // (pos.soft.ninja aunque se cobre desde el alias *.vercel.app); localhost
    // y los previews mandan su propio origen para probar.
    const { data, error } = await supabase.functions.invoke("payway", {
      body: {
        action: "create",
        amount,
        title,
        origin: appOrigin(),
        ...posStoreBody(),
      },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  paywayIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null; amount?: number }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("payway", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // ── Getnet (H18): Checkout hosted de Getnet AR (Geopagos) ─────────────────
  // create devuelve el checkout de la orden como init_point (QR + link). El
  // estado se sondea vía la Edge, que re-consulta la orden en Getnet.
  // mode 'own' (ADR-069): checkout PROPIO /pagar/{intent}?p=getnet con la
  // Checkout API; el cliente elige tarjeta y cuotas ahí, como en Payway.
  createGetnetLink: async (
    amount: number,
    title: string,
    mode?: "own",
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("getnet", {
      body: {
        action: "create",
        amount,
        title,
        ...(mode === "own" ? { mode: "own", origin: appOrigin() } : {}),
        ...posStoreBody(),
      },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  getnetIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null; amount?: number }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("getnet", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // ── GO Cuotas (ADR-033): checkout Redirect como QR + link (Edge gocuotas) ──
  // create devuelve el url_init como init_point. El estado se sondea vía la
  // Edge, que re-consulta la orden en GO Cuotas (la confirmación principal es
  // el webhook). Mínimo $1.500 (error gocuotas_min_amount).
  createGoCuotasLink: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("gocuotas", {
      body: { action: "create", amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  gocuotasIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("gocuotas", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // Baja local best-effort (si el cliente ya pagó, gana el pago).
  cancelGoCuotasIntent: async (id: string): Promise<void> => {
    const supabase = createClient();
    await supabase.functions.invoke("gocuotas", {
      body: { action: "cancel", intent_id: id },
    });
  },

  // ── Directo (ADR-041): orden de la API de comercios como QR + link ─────────
  // create devuelve el redirect_Url como init_point. La confirmación llega por
  // el webhook (directo_webhook); status re-verifica contra Directo cuando ya
  // hay una notificación conocida.
  createDirectoLink: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("directo", {
      body: { action: "create", amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string };
  },

  directoIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("directo", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // Baja local best-effort (si el cliente ya pagó, gana el pago).
  cancelDirectoIntent: async (id: string): Promise<void> => {
    const supabase = createClient();
    await supabase.functions.invoke("directo", {
      body: { action: "cancel", intent_id: id },
    });
  },

  // ── Nave (H21c): QR interoperable + link (Edge nave) ───────────────────────
  // create devuelve qr_data (QR EMV: se renderiza TAL CUAL) y el checkout_url
  // como init_point ("Abrir link de pago"). La confirmación principal llega por
  // el webhook (nave_webhook); status es el respaldo que re-verifica contra
  // la API de Nave.
  createNaveQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string; qr_data: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("nave", {
      body: { action: "create", amount, title, ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string; init_point: string; qr_data: string };
  },

  naveIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("nave", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // Baja best-effort de la intención (si el pago ya entró, gana el pago).
  cancelNaveIntent: async (id: string): Promise<void> => {
    const supabase = createClient();
    await supabase.functions.invoke("nave", {
      body: { action: "cancel", intent_id: id },
    });
  },

  // ── Nave Point (H21c): terminal smart_pos (Edge nave_point) ────────────────
  // Usa la MISMA conexión de Nave; las terminales son los ids de punto de
  // venta que el dueño cargó al conectar Nave.
  navePointDevices: async (): Promise<{ id: string; label: string }[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("nave_point", {
      body: { action: "devices", ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return (data as { devices: { id: string; label: string }[] }).devices;
  },

  createNavePointIntent: async (
    deviceId: string,
    amount: number,
    loc?: PaymentLocation,
  ): Promise<{ intent_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("nave_point", {
      body: { action: "create", device_id: deviceId, amount, ...locationBody(loc) },
    });
    if (error) throw await edgeError(error);
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string };
  },

  navePointIntentStatus: async (
    intentId: string,
  ): Promise<{
    status: string;
    mp_payment_id: string | null;
    card_type: "debit" | "credit" | null;
    reason?: string | null;
  }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("nave_point", {
      body: { action: "status", intent_id: intentId },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as {
      status: string;
      mp_payment_id: string | null;
      card_type: "debit" | "credit" | null;
      reason?: string | null;
    };
  },

  cancelNavePointIntent: async (intentId: string): Promise<void> => {
    const supabase = createClient();
    await supabase.functions.invoke("nave_point", {
      body: { action: "cancel", intent_id: intentId },
    });
  },

  // ── Clover Point (ADR-047): terminal Clover por Cloud Pay Display ──────────
  // Todas pasan por la Edge clover_point (conexión Fiserv del tenant; gating
  // de plan server-side en create). El POS sondea el estado hasta approved.
  cloverDevices: async (): Promise<{ id: string; label: string }[]> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("clover_point", {
      body: { action: "devices", ...posStoreBody() },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return (data as { devices: { id: string; label: string }[] }).devices;
  },

  cloverPing: async (deviceId: string): Promise<boolean> => {
    const supabase = createClient();
    const { data } = await supabase.functions.invoke("clover_point", {
      body: { action: "ping", device_id: deviceId, ...posStoreBody() },
    });
    return Boolean((data as { connected?: boolean } | null)?.connected);
  },

  // Sin `installments` la terminal pregunta las cuotas (Argentina).
  createCloverIntent: async (
    deviceId: string,
    amount: number,
    installments?: number,
    loc?: PaymentLocation,
  ): Promise<{ intent_id: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("clover_point", {
      body: {
        action: "create",
        device_id: deviceId,
        amount,
        installments: installments ?? null,
        ...locationBody(loc),
      },
    });
    if (error) throw await edgeError(error);
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { intent_id: string };
  },

  cloverIntentStatus: async (
    intentId: string,
  ): Promise<{
    status: string;
    mp_payment_id: string | null;
    card_type: "debit" | "credit" | null;
    reason?: string | null;
  }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("clover_point", {
      body: { action: "status", intent_id: intentId },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as {
      status: string;
      mp_payment_id: string | null;
      card_type: "debit" | "credit" | null;
      reason?: string | null;
    };
  },

  cancelCloverIntent: async (intentId: string): Promise<{ status: string; cancel_requested: boolean }> => {
    const supabase = createClient();
    const { data } = await supabase.functions.invoke("clover_point", {
      body: { action: "cancel", intent_id: intentId },
    });
    return { status: String((data as { status?: string } | null)?.status ?? "cancelled"), cancel_requested: false };
  },

  // Estado del intent MODO sincronizado server-side (Edge modo_create_qr,
  // action status): MODO no tiene webhook por intención, así que el poll del
  // POS consulta la API real en cada tick (patrón pagos360).
  modoIntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("modo_create_qr", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  pagos360IntentStatus: async (
    id: string,
  ): Promise<{ status: string; mp_payment_id: string | null }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("pagos360", {
      body: { action: "status", intent_id: id },
    });
    if (error) throw error;
    if ((data as { error?: string })?.error) {
      throw new Error((data as { error: string }).error);
    }
    return data as { status: string; mp_payment_id: string | null };
  },

  // Conciliación: intents de cobro QR (MP + Mobbex) cruzados con la venta que
  // los referenció (payments.reference = intent.id). Un intent "approved" sin
  // venta = plata cobrada sin ticket → hay que revisarlo.
  listQrIntents: async (range?: {
    from?: Date;
    to?: Date;
  }): Promise<QrIntentRow[]> => {
    const supabase = createClient();
    let q = supabase
      .from("mp_payment_intents")
      .select(
        "id, provider_key, amount, status, mp_payment_id, sale_id, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(range?.from || range?.to ? 1000 : 200);
    if (range?.from) q = q.gte("created_at", range.from.toISOString());
    if (range?.to) {
      const end = new Date(range.to);
      end.setHours(23, 59, 59, 999);
      q = q.lte("created_at", end.toISOString());
    }
    const { data, error } = await q;
    if (error) throw error;
    const intents = data ?? [];
    if (intents.length === 0) return [];

    // Venta vinculada: por payments.reference (el POS guarda el intent id) o
    // por intent.sale_id si está seteado.
    const ids = intents.map((i) => i.id);
    const { data: pays } = await supabase
      .from("payments")
      .select("reference, sale_id, sales(number, status)")
      .eq("method", "qr")
      .in("reference", ids);
    type PayRow = {
      reference: string | null;
      sale_id: string;
      sales: { number: number; status: string } | null;
    };
    const byRef = new Map<string, PayRow>();
    for (const p of (pays ?? []) as unknown as PayRow[]) {
      if (p.reference) byRef.set(p.reference, p);
    }

    // sale_id directo (fallback) → buscar números de esas ventas.
    const directSaleIds = intents
      .filter((i) => i.sale_id && !byRef.has(i.id))
      .map((i) => i.sale_id as string);
    const directSales = new Map<string, { number: number; status: string }>();
    if (directSaleIds.length > 0) {
      const { data: sales } = await supabase
        .from("sales")
        .select("id, number, status")
        .in("id", directSaleIds);
      for (const s of sales ?? []) {
        directSales.set(s.id, { number: s.number, status: s.status });
      }
    }

    return intents.map((i) => {
      const viaPay = byRef.get(i.id);
      const viaDirect = i.sale_id ? directSales.get(i.sale_id) : undefined;
      const sale = viaPay?.sales ?? viaDirect ?? null;
      return {
        id: i.id,
        provider_key: i.provider_key ?? "mercadopago",
        amount: Number(i.amount),
        status: i.status,
        mp_payment_id: i.mp_payment_id,
        created_at: i.created_at,
        saleNumber: sale?.number ?? null,
        saleStatus: sale?.status ?? null,
      };
    });
  },

  createSale: async (
    items: SaleItemInput[],
    payments: SalePaymentInput[],
    discountTotal: number,
    customerId?: string | null,
    extras?: SaleExtraInput[],
    // Cobro de mesa atómico (F13 · H44): pedido de mesa a cerrar EN LA MISMA
    // transacción que la venta. Cuando viene, create_sale toma el pedido FOR
    // UPDATE, valida que esté abierto y, al final, lo enlaza/marca 'cobrada' y
    // libera la mesa (sin close_dining_table aparte → no hay doble cobro por
    // concurrencia). Mostrador (sin mesa) NO lo pasa y el flujo es idéntico.
    tableOrderId?: string | null,
    // Cobro de delivery atómico (F13 · H49 · Bug 🟠): ESPEJA tableOrderId. Cuando
    // viene, create_sale toma el delivery_order FOR UPDATE, aborta si ya está
    // cobrado/cancelado y, al final, lo enlaza/marca 'entregado' EN LA MISMA
    // transacción (sin cierre aparte → sin doble cobro). El costo de envío lo
    // agrega create_sale como LÍNEA AUTORITATIVA desde delivery_orders.delivery_fee
    // (server-side, inviolable): el POS ya NO lo manda como ítem del carrito.
    deliveryOrderId?: string | null,
    // Promoción aplicada (F9 · H53): descuento calculado por el motor en el POS.
    // Va en un canal SEPARADO del descuento manual: create_sale lo resta del
    // total pero NO lo pasa por el gating de 'descuentos' ni por el tope de
    // descuento por rol. Sólo se manda si descontó algo (> 0).
    promo?: { discount: number; id: string | null; name: string | null } | null,
    // Cupón aplicado (F9 · H54): sólo el ID. create_sale valida el cupón, calcula
    // el descuento de forma AUTORITATIVA (lock de la fila), lo resta del total
    // (bypass del gating de 'descuentos' y del tope por rol) y registra el canje
    // (used_count + redemption) EN LA MISMA transacción — a prueba de concurrencia.
    couponId?: string | null,
    // Servicios profesionales (ADR-116): período del servicio y vencimiento del
    // pago. create_sale los guarda si la venta tiene servicios y la factura de
    // ARCA los manda (concepto 2 o 3). Sin él, la fecha de la venta.
    service?: SaleServiceInput | null,
  ): Promise<CreateSaleResult> => {
    const supabase = createClient();
    const promoDisc = promo && promo.discount > 0 ? promo.discount : 0;
    // ADR-051 (H116): si el descuento general pide supervisor, el servidor
    // contesta supervisor_required y se reintenta con el PIN (mismo payload).
    const subtotal = items.reduce((a, it) => a + it.unit_price * it.quantity - (it.discount ?? 0), 0);
    const discountPct = subtotal > 0 ? Math.round((discountTotal / subtotal) * 10000) / 100 : 0;
    // ADR-056: el PIN de 'cambio_precio' cubre el mayor desvío contra la lista.
    const priceDev = items.reduce(
      (m, it) => (it.price_override && it.list_price != null ? Math.max(m, priceDeviationPct(it.list_price, it.unit_price)) : m),
      0,
    );
    const run = async (): Promise<CreateSaleResult> => {
    const { data, error } = await supabase.rpc("create_sale", {
      p_items: items as unknown as Json,
      p_payments: toSalePayments(payments) as unknown as Json,
      p_discount_total: discountTotal,
      p_customer_id: customerId ?? undefined,
      // Señal de gating (garantía/recargos). `p_extras` aún no está en los tipos
      // generados (no se regeneran): se castea el payload.
      p_extras: (extras ?? []) as unknown as Json,
      // `p_table_order_id` / `p_delivery_order_id` aún no están en los tipos
      // generados (no se regeneran): viajan en el cast del payload. undefined =
      // mostrador (default null server). Sólo uno de los dos viene a la vez.
      ...(tableOrderId ? { p_table_order_id: tableOrderId } : {}),
      ...(deliveryOrderId ? { p_delivery_order_id: deliveryOrderId } : {}),
      // Promoción (F9): sólo si descontó algo.
      ...(promoDisc > 0
        ? {
            p_promo_discount: promoDisc,
            p_promo_id: promo?.id ?? undefined,
            p_promo_name: promo?.name ?? undefined,
          }
        : {}),
      // Cupón (F9 · H54): sólo el id; create_sale calcula y valida el resto.
      ...(couponId ? { p_coupon_id: couponId } : {}),
      // F17 · H90: turno de la caja de este dispositivo. La venta queda en la
      // sucursal de ese turno (no en la sucursal principal).
      ...(getActiveShiftId() ? { p_cash_shift_id: getActiveShiftId() } : {}),
      ...(service ? { p_service: service } : {}),
    } as never);
    if (error) throw error;
    return data as unknown as CreateSaleResult;
    };
    const res = await withSupervisor(run, { discount_over: discountPct, cambio_precio: priceDev });
    // F3 · ADR-072: la factura electrónica se pide en segundo plano. Nunca
    // frena ni avisa al cajero; si falla, la cola fiscal la toma con el cron.
    emitirVentaEnSegundoPlano(res?.sale_id);
    return res;
  },
};
