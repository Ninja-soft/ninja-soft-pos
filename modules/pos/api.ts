import { createClient } from "@/lib/supabase/client";
import type { Json, Tables } from "@/types/database";

export type CashShift = Tables<"cash_shifts">;
export type CashRegister = Tables<"cash_registers">;

export interface SalePaymentInput {
  method: "cash" | "debit" | "credit" | "transfer" | "qr" | "other" | "store_credit";
  amount: number;
  reference?: string;
}
export interface SaleItemInput {
  product_id: string | null; // null = ítem de monto libre (venta rápida)
  name?: string; // nombre del ítem libre (cuando product_id es null)
  serial?: string; // N° de serie (producto serializado)
  variant_id?: string | null; // variante (producto con has_variants)
  quantity: number;
  unit_price: number;
  discount: number;
}
export interface CreateSaleResult {
  sale_id: string;
  number: number;
  total: number;
}

// Descriptor de un extra del cobro para el gating server-side. 'warranty' (prima
// de garantía extendida) se gatea contra la feature 'garantias'; 'surcharge'
// (recargo de medio/plan) no se gatea. El importe del extra sigue entrando como
// ítem de venta en `items` (no se duplica el total) — esto es solo la señal.
export interface SaleExtraInput {
  kind: "warranty" | "surcharge";
  amount: number;
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

export type PaymentPlan = Tables<"payment_plans">;
export interface PaymentPlanInput {
  provider_key: string;
  label: string;
  base: string;
  brand: string | null;
  installments: number;
  surcharge_pct: number;
  sort?: number;
  code?: string | null;
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
  };
}

export const paymentPlansApi = {
  // Planes de un medio (provider). activeOnly false en el editor.
  listByProvider: async (
    providerKey: string,
    activeOnly = false,
  ): Promise<PaymentPlan[]> => {
    const supabase = createClient();
    let q = supabase
      .from("payment_plans")
      .select("*")
      .eq("provider_key", providerKey)
      .order("sort")
      .order("label");
    if (activeOnly) q = q.eq("is_active", true);
    const { data } = await q;
    return (data ?? []) as PaymentPlan[];
  },

  // Todos los planes activos (para el POS al cobrar).
  listActive: async (): Promise<PaymentPlan[]> => {
    const supabase = createClient();
    const { data } = await supabase
      .from("payment_plans")
      .select("*")
      .eq("is_active", true)
      .order("sort")
      .order("label");
    return (data ?? []) as PaymentPlan[];
  },

  create: async (v: PaymentPlanInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").insert(planRow(v));
    if (error) throw error;
  },

  update: async (id: string, v: Partial<PaymentPlanInput>): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update(v).eq("id", id);
    if (error) throw error;
  },

  // Celda del grid: crea o actualiza el plan (provider+base+marca+cuotas).
  setCell: async (v: PaymentPlanInput): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("payment_plans")
      .upsert(planRow(v), { onConflict: "tenant_id,provider_key,code" });
    if (error) throw error;
  },

  // Borra la celda (combinación) de un medio.
  removeCell: async (
    providerKey: string,
    base: string,
    brand: string | null,
    installments: number,
  ): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("payment_plans")
      .delete()
      .eq("provider_key", providerKey)
      .eq("code", planCode(base, brand, installments));
    if (error) throw error;
  },

  // Siembra los planes AR que falten en el medio (no pisa los existentes).
  seedTypical: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("payment_plans")
      .upsert(
        rows.map((r) => planRow({ ...r, provider_key: providerKey })),
        { onConflict: "tenant_id,provider_key,code", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    return (data ?? []).length;
  },

  // Import XLSX: agrega/actualiza (upsert por code) sin borrar el resto.
  bulkUpsert: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
  ): Promise<number> => {
    if (rows.length === 0) return 0;
    const supabase = createClient();
    const { error } = await supabase
      .from("payment_plans")
      .upsert(rows.map((r) => planRow({ ...r, provider_key: providerKey })), {
        onConflict: "tenant_id,provider_key,code",
      });
    if (error) throw error;
    return rows.length;
  },

  // Import XLSX: reemplaza todos los planes del medio por los del archivo.
  replaceProvider: async (
    providerKey: string,
    rows: Omit<PaymentPlanInput, "provider_key">[],
  ): Promise<number> => {
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from("payment_plans")
      .delete()
      .eq("provider_key", providerKey);
    if (delErr) throw delErr;
    if (rows.length === 0) return 0;
    const { error } = await supabase
      .from("payment_plans")
      .insert(rows.map((r) => planRow({ ...r, provider_key: providerKey })));
    if (error) throw error;
    return rows.length;
  },

  setActive: async (id: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").update({ is_active }).eq("id", id);
    if (error) throw error;
  },
  // Activa/desactiva todos los planes de un medio (modo "recargo único" del medio
  // desactiva los planes para que no se ofrezcan al cobrar).
  setProviderActive: async (providerKey: string, is_active: boolean): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase
      .from("payment_plans")
      .update({ is_active })
      .eq("provider_key", providerKey);
    if (error) throw error;
  },
  remove: async (id: string): Promise<void> => {
    const supabase = createClient();
    const { error } = await supabase.from("payment_plans").delete().eq("id", id);
    if (error) throw error;
  },
};

export const posApi = {
  defaultRegister: async (): Promise<CashRegister | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("cash_registers")
      .select("*")
      .eq("is_active", true)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  openShift: async (): Promise<CashShift | null> => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("cash_shifts")
      .select("*")
      .eq("status", "open")
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
  ): Promise<number> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("close_cash_shift", {
      p_shift_id: shiftId,
      p_closing_amount: closing,
      p_notes: notes,
    });
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
  createMobbexQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mobbex_create_qr", {
      body: { amount, title },
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
      body: { amount, title },
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

  // Settings operativos del POS (H30): descuento máximo por rol y redondeo.
  // Incluye los settings de la pantalla del cliente (H25): mostrar precios
  // unitarios y mensajes de idle/agradecimiento.
  posSettings: async (): Promise<{
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
  } | null> => {
    const supabase = createClient();
    // Las columnas display_* (H25) y offer_warranty (H28) aún no están en los
    // tipos generados (no se regeneran): select("*") + cast del payload.
    const { data: raw } = await supabase.from("pos_settings").select("*").maybeSingle();
    if (!raw) return null;
    const data = raw as Record<string, unknown>;
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
    };
  },

  // Crea la preferencia/QR de cobro y devuelve el init_point.
  createMpQr: async (
    amount: number,
    title: string,
  ): Promise<{ intent_id: string; init_point: string }> => {
    const supabase = createClient();
    const { data, error } = await supabase.functions.invoke("mp_create_qr", {
      body: { amount, title },
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
  ): Promise<CreateSaleResult> => {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("create_sale", {
      p_items: items as unknown as Json,
      p_payments: payments as unknown as Json,
      p_discount_total: discountTotal,
      p_customer_id: customerId ?? undefined,
      // Señal de gating (garantía/recargos). `p_extras` aún no está en los tipos
      // generados (no se regeneran): se castea el payload.
      p_extras: (extras ?? []) as unknown as Json,
    } as never);
    if (error) throw error;
    return data as unknown as CreateSaleResult;
  },
};
