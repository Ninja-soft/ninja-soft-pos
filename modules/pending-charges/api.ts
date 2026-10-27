// =============================================================================
// Cobros en espera (ADR-048): acceso a datos. Lectura directa con RLS (por
// sucursal permitida); toda escritura por RPC SECURITY DEFINER o por la Edge
// pending_charge_share (email). Los tipos generados no se regeneran: las
// tablas y RPC nuevas viajan con cast.
// =============================================================================
import { createClient } from "@/lib/supabase/client";
import { getCurrentTenantId } from "@/lib/supabase/currentUser";
import { posApi } from "@/modules/pos/api";
import { withSupervisor } from "@/modules/security/supervisor";
import { priceDeviationPct } from "@/lib/pos/priceMismatch";
import type {
  PendingCharge,
  PendingChargeEvent,
  PendingChargeLine,
  PendingChargeStatus,
  ShareChannel,
} from "./logic";

const COLS =
  "id, tenant_id, store_id, register_id, cash_shift_id, origin_shift_id, created_by, customer_id, customer_name, customer_email, customer_phone, lines, cart, amount, sale_total, provider_key, channel, intent_id, previous_intent_ids, share_url, qr_data, shared_via, share_count, status, expires_at, paid_at, paid_amount, completed_at, sale_id, sale_number, cancelled_at, cancel_reason, carry_over, needs_review, last_error, attempts, acknowledged_at, notes, version, created_at, updated_at";

function normalize(r: Record<string, unknown>): PendingCharge {
  return {
    ...(r as unknown as PendingCharge),
    amount: Number(r.amount) || 0,
    sale_total: Number(r.sale_total) || 0,
    paid_amount: r.paid_amount == null ? null : Number(r.paid_amount),
    sale_number: r.sale_number == null ? null : Number(r.sale_number),
    lines: (Array.isArray(r.lines) ? r.lines : []) as PendingChargeLine[],
    shared_via: (Array.isArray(r.shared_via) ? r.shared_via : []) as ShareChannel[],
    previous_intent_ids: (Array.isArray(r.previous_intent_ids) ? r.previous_intent_ids : []) as string[],
  };
}

export interface ListFilters {
  storeId: string | null;
  statuses?: PendingChargeStatus[];
  /** Sólo los creados desde esta fecha (ISO). */
  since?: string | null;
  limit?: number;
}

export interface ParkArgs {
  intentId: string;
  sale: Record<string, unknown>;
  cart: Record<string, unknown>;
  lines: PendingChargeLine[];
  cashShiftId: string | null;
  channel: "qr" | "link";
  shareUrl: string | null;
  qrData: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  expiresMinutes: number;
  notes?: string | null;
}

export interface ReplaceArgs {
  id: string;
  newIntentId: string;
  version: number | null;
  sale?: Record<string, unknown> | null;
  cart?: Record<string, unknown> | null;
  lines?: PendingChargeLine[] | null;
  channel?: "qr" | "link" | null;
  shareUrl?: string | null;
  qrData?: string | null;
  expiresMinutes?: number | null;
}

export interface ProviderCharge {
  intent_id: string;
  init_point: string;
  qr_data?: string;
}

// Porcentaje de descuento general manual del carrito (ADR-051): estacionar corre
// create_sale en seco y puede pedir PIN de supervisor por el descuento.
function discountPct(sale: Record<string, unknown> | null | undefined): number {
  const items = (Array.isArray(sale?.items) ? sale!.items : []) as { unit_price?: number; quantity?: number; discount?: number }[];
  const subtotal = items.reduce((a, it) => a + (Number(it.unit_price) || 0) * (Number(it.quantity) || 0) - (Number(it.discount) || 0), 0);
  const disc = Number(sale?.discount_total) || 0;
  return subtotal > 0 ? Math.round((disc / subtotal) * 10000) / 100 : 0;
}

// ADR-056: mayor desvío de un precio cambiado a mano (monto del PIN de 'cambio_precio').
function priceOverridePct(sale: Record<string, unknown> | null | undefined): number {
  const items = (Array.isArray(sale?.items) ? sale!.items : []) as {
    unit_price?: number;
    price_override?: boolean;
    list_price?: number;
  }[];
  return items.reduce(
    (m, it) =>
      it.price_override && it.list_price != null
        ? Math.max(m, priceDeviationPct(Number(it.list_price), Number(it.unit_price) || 0))
        : m,
    0,
  );
}

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await createClient().rpc(fn as never, args as never);
  if (error) throw new Error(error.message);
  return data as T;
};

export const pendingChargesApi = {
  list: async (f: ListFilters): Promise<PendingCharge[]> => {
    // Siempre por el negocio activo (ADR-052): la RLS no es el único filtro.
    const tenantId = await getCurrentTenantId();
    if (!tenantId) return [];
    let q = createClient()
      .from("pending_charges" as never)
      .select(COLS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(f.limit ?? 200);
    if (f.storeId) q = q.eq("store_id", f.storeId);
    if (f.statuses?.length) q = q.in("status", f.statuses);
    if (f.since) q = q.gte("created_at", f.since);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as Record<string, unknown>[]).map(normalize);
  },

  get: async (id: string): Promise<PendingCharge | null> => {
    const { data, error } = await createClient()
      .from("pending_charges" as never)
      .select(COLS)
      .eq("id", id)
      .eq("tenant_id", (await getCurrentTenantId()) ?? "")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? normalize(data as unknown as Record<string, unknown>) : null;
  },

  events: async (id: string): Promise<PendingChargeEvent[]> => {
    const { data, error } = await createClient()
      .from("pending_charge_events" as never)
      .select("id, pending_charge_id, kind, data, actor_user_id, created_at")
      .eq("pending_charge_id", id)
      .eq("tenant_id", (await getCurrentTenantId()) ?? "")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as PendingChargeEvent[];
  },

  park: (a: ParkArgs) =>
    withSupervisor(() => rpc<{ id: string; expires_at: string; amount: number }>("park_pending_charge", {
      p_intent_id: a.intentId,
      p_sale: a.sale,
      p_cart: a.cart,
      p_lines: a.lines,
      p_cash_shift_id: a.cashShiftId,
      p_channel: a.channel,
      p_share_url: a.shareUrl,
      p_qr_data: a.qrData,
      p_customer_name: a.customerName,
      p_customer_email: a.customerEmail,
      p_customer_phone: a.customerPhone,
      p_expires_minutes: a.expiresMinutes,
      p_notes: a.notes ?? null,
    }), { discount_over: discountPct(a.sale), cambio_precio: priceOverridePct(a.sale) }),

  complete: (id: string, force = false) =>
    rpc<{ status: string; sale_id?: string; number?: number; error?: string }>("complete_pending_charge", {
      p_id: id,
      p_force: force,
    }),

  cancel: (id: string, reason: string | null, version: number | null) =>
    rpc<{ id: string; intent_id: string; provider_key: string; channel: "qr" | "link" }>("cancel_pending_charge", {
      p_id: id,
      p_reason: reason,
      p_version: version,
    }),

  update: (id: string, patch: Record<string, unknown>, version: number | null) =>
    rpc<{ id: string; expires_at: string; version: number }>("update_pending_charge", {
      p_id: id,
      p_patch: patch,
      p_version: version,
    }),

  // Con carrito nuevo corre el mismo ensayo de create_sale: puede pedir PIN.
  replace: (a: ReplaceArgs) =>
    withSupervisor(() => rpc<{
      id: string;
      intent_id: string;
      amount: number;
      expires_at: string;
      old_intent_id: string;
      old_provider_key: string;
      old_channel: "qr" | "link";
    }>("replace_pending_charge_intent", {
      p_id: a.id,
      p_new_intent_id: a.newIntentId,
      p_version: a.version,
      p_sale: a.sale ?? null,
      p_cart: a.cart ?? null,
      p_lines: a.lines ?? null,
      p_channel: a.channel ?? null,
      p_share_url: a.shareUrl ?? null,
      p_qr_data: a.qrData ?? null,
      p_expires_minutes: a.expiresMinutes ?? null,
    }), { discount_over: discountPct(a.sale), cambio_precio: priceOverridePct(a.sale) }),

  markShared: (id: string, via: ShareChannel, to?: string | null) =>
    rpc<void>("mark_pending_charge_shared", { p_id: id, p_via: via, p_to: to ?? null }),

  ack: (id: string) => rpc<void>("ack_pending_charge", { p_id: id }),

  /** Email con el link de pago (Edge pending_charge_share, diseño del negocio). */
  sendEmail: async (id: string, to: string, note?: string): Promise<void> => {
    const { data, error } = await createClient().functions.invoke("pending_charge_share", {
      body: { pending_charge_id: id, to, note: note ?? "" },
    });
    if (error) {
      const ctx = (error as { context?: Response }).context;
      const body = ctx ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
      throw new Error(body?.error ?? error.message);
    }
    if ((data as { error?: string } | null)?.error) throw new Error((data as { error: string }).error);
  },
};

// ── Proveedor: crear, consultar y dar de baja el cobro ──────────────────────
// Mismo mapeo que QrCheckoutModal. Mercado Pago en espera va siempre por link
// (Checkout Pro): el QR de la caja (Orders API) bloquea la caja para la venta
// siguiente.

export async function createProviderCharge(
  provider: string,
  channel: "qr" | "link",
  amount: number,
  customerId: string | null,
  /** Link anterior: Getnet con /pagar = checkout propio (ADR-069). */
  previousShareUrl: string | null = null,
): Promise<ProviderCharge> {
  const title = "Venta NinjaPos";
  switch (provider) {
    case "mercadopago":
      return posApi.createMpQr(amount, title);
    case "mobbex":
      return posApi.createMobbexQr(amount, title, customerId);
    case "modo":
      return posApi.createModoQr(amount, title);
    case "pagos360":
      return posApi.createPagos360Link(amount, title);
    case "payway":
      return posApi.createPaywayLink(amount, title);
    case "getnet":
      return posApi.createGetnetLink(amount, title, previousShareUrl?.includes("/pagar/") ? "own" : undefined);
    case "nave":
      return posApi.createNaveQr(amount, title);
    case "gocuotas":
      return posApi.createGoCuotasLink(amount, title);
    case "directo":
      // Directo (ADR-181) exige DNI y nombre: salen del cliente del cobro.
      return posApi.createDirectoLink(amount, title, { customerId });
    case "ualabis":
      return posApi.createUalaBisLink(amount, title);
    case "viumi":
      return posApi.createViumiLink(amount, title);
    case "talo":
      return posApi.createTaloPayment(amount, title);
    default:
      void channel;
      throw new Error("provider_not_supported");
  }
}

/** Sondea el estado en el proveedor (sincroniza el intent; el trigger completa). */
export async function syncProviderStatus(
  provider: string,
  channel: "qr" | "link",
  intentId: string,
): Promise<string | null> {
  const pick = (): Promise<{ status: string }> | null => {
    switch (provider) {
      case "mercadopago":
        return channel === "qr" ? posApi.mpOrderStatus(intentId) : posApi.mpIntentStatus(intentId);
      case "pagos360":
        return posApi.pagos360IntentStatus(intentId);
      case "modo":
        return posApi.modoIntentStatus(intentId);
      case "payway":
        return posApi.paywayIntentStatus(intentId);
      case "getnet":
        return posApi.getnetIntentStatus(intentId);
      case "nave":
        return posApi.naveIntentStatus(intentId);
      case "gocuotas":
        return posApi.gocuotasIntentStatus(intentId);
      case "directo":
        return posApi.directoIntentStatus(intentId);
      case "ualabis":
        return posApi.ualabisIntentStatus(intentId);
      case "viumi":
        return posApi.viumiIntentStatus(intentId);
      case "talo":
        return posApi.taloIntentStatus(intentId);
      case "mobbex":
        return posApi.mpIntentStatus(intentId);
      default:
        return null;
    }
  };
  try {
    const r = await pick();
    return r?.status ?? null;
  } catch {
    return null;
  }
}

/** Baja en el proveedor donde la API lo permite (best-effort). */
export async function cancelAtProvider(provider: string, channel: "qr" | "link", intentId: string): Promise<void> {
  try {
    if (provider === "mercadopago" && channel === "qr") await posApi.cancelMpOrder(intentId);
    else if (provider === "nave") await posApi.cancelNaveIntent(intentId);
    else if (provider === "gocuotas") await posApi.cancelGoCuotasIntent(intentId);
    else if (provider === "directo") await posApi.cancelDirectoIntent(intentId);
    else if (provider === "ualabis") await posApi.cancelUalaBisIntent(intentId);
    else if (provider === "viumi") await posApi.cancelViumiIntent(intentId);
    else if (provider === "talo") await posApi.cancelTaloIntent(intentId);
  } catch {
    /* el intent ya quedó cancelado localmente: un pago tardío queda para revisión */
  }
}
