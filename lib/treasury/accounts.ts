// lib/treasury/accounts.ts
//
// Cuentas de dinero unificadas (F23 · H150, ADR-158). Lógica PURA: tipos de
// cuenta, procesadores, grupos de la pantalla Posición, origen de cada
// movimiento (etiqueta, "Ver origen" y documento del asiento) y mensajes de
// error de las RPC de Tesorería.

import { purchaseErrorMessage } from "@/lib/purchases/orders";

export type TreasuryKind = "cash" | "bank" | "pos_cash" | "wallet" | "receivable";

export const KIND_LABEL: Record<TreasuryKind, string> = {
  pos_cash: "Caja del POS",
  cash: "Caja general",
  bank: "Banco",
  wallet: "Billetera",
  receivable: "A acreditar",
};

/** Grupos de la pantalla Posición, en orden de lectura. */
export const POSITION_GROUPS: Array<{ kind: TreasuryKind; title: string; hint: string }> = [
  { kind: "pos_cash", title: "Cajas del POS", hint: "Lo que hay en cada cajón: el esperado del turno abierto o lo contado al cerrar." },
  { kind: "cash", title: "Caja general y fondo fijo", hint: "La caja fuerte y los fondos fuera del POS." },
  { kind: "bank", title: "Bancos", hint: "Tus cuentas bancarias. Los cobros por transferencia entran solos en la cuenta vinculada." },
  { kind: "wallet", title: "Billeteras", hint: "Mercado Pago, Ualá Bis y otras billeteras donde te acreditan." },
  {
    kind: "receivable",
    title: "A acreditar",
    hint: "Lo que cobraste con tarjeta, QR o billeteras y el procesador todavía no te depositó. Es un estimado de los últimos 180 días.",
  },
];

/** Billeteras que se pueden elegir al crear una cuenta (provider_key). */
export const WALLET_PROVIDERS: Array<{ key: string; label: string }> = [
  { key: "mercadopago", label: "Mercado Pago" },
  { key: "ualabis", label: "Ualá Bis" },
  { key: "modo", label: "MODO" },
  { key: "naranjax", label: "Naranja X" },
  { key: "personalpay", label: "Personal Pay" },
  { key: "otro", label: "Otra billetera" },
];

const PROVIDER_LABEL: Record<string, string> = {
  mercadopago: "Mercado Pago",
  ualabis: "Ualá Bis",
  modo: "MODO",
  naranjax: "Naranja X",
  personalpay: "Personal Pay",
  payway: "Payway",
  prisma: "Payway",
  fiserv: "Fiserv",
  posnet: "Fiserv",
  getnet: "Getnet",
  nave: "Nave",
  mercadolibre: "Mercado Libre",
  plataforma: "Plataformas de delivery",
  tarjetas: "Tarjetas sin adquirente",
  qr: "QR sin procesador",
  directo: "Directo",
  otro: "Otra billetera",
};

export function providerLabel(key: string | null | undefined): string {
  if (!key) return "Sin procesador";
  return PROVIDER_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Cuentas que el sistema crea y mueve solo: se ven, no se editan. */
export function isSystemKind(kind: string): boolean {
  return kind === "pos_cash" || kind === "receivable";
}

/** Sólo los bancos y las billeteras reciben cobros por transferencia. */
export function canLinkTransfers(kind: string): boolean {
  return kind === "bank" || kind === "wallet";
}

export interface PositionLike {
  account_id: string;
  kind: string;
  name: string;
  currency: string;
  is_active: boolean;
  balance: number;
}

/** Agrupa las cuentas por tipo, en el orden de POSITION_GROUPS, con el total en pesos de cada grupo. */
export function groupPositions<T extends PositionLike>(rows: T[]): Array<{ kind: TreasuryKind; title: string; hint: string; rows: T[]; totalArs: number }> {
  return POSITION_GROUPS.map((g) => {
    const list = rows
      .filter((r) => r.kind === g.kind)
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name, "es"));
    const totalArs = list
      .filter((r) => r.is_active && (r.currency || "ARS").toUpperCase() === "ARS")
      .reduce((t, r) => Math.round((t + (Number(r.balance) || 0)) * 100) / 100, 0);
    return { ...g, rows: list, totalArs };
  });
}

// ── Origen de los movimientos ──────────────────────────────────────────────

export interface MovementOriginLike {
  id: string;
  type: string;
  reference_type: string | null;
  reference_id: string | null;
  cheque_id: string | null;
  counterpart_id: string | null;
  sale_id?: string | null;
}

export type OriginKind = "manual" | "venta" | "orden_pago" | "cheque" | "transferencia";

export const ORIGIN_LABEL: Record<OriginKind, string> = {
  manual: "Carga manual",
  venta: "Venta",
  orden_pago: "Orden de pago",
  cheque: "Cheque",
  transferencia: "Entre cuentas",
};

export function movementOrigin(m: MovementOriginLike): OriginKind {
  if (m.type === "sale_collection" || m.type === "sale_collection_void") return "venta";
  if (m.type === "supplier_payment" || m.type === "supplier_payment_void" || m.reference_type === "supplier_payment") return "orden_pago";
  if (m.cheque_id || m.type.startsWith("cheque_")) return "cheque";
  if (m.type === "transfer_in" || m.type === "transfer_out") return "transferencia";
  return "manual";
}

/** Pantalla del documento que generó el movimiento (null si es una carga manual). */
export function movementOriginHref(m: MovementOriginLike): string | null {
  switch (movementOrigin(m)) {
    case "venta":
      return m.sale_id ? `/ventas?venta=${m.sale_id}` : "/ventas";
    case "orden_pago":
      return "/compras/facturas";
    case "cheque":
      return "/tesoreria/cheques";
    default:
      return null;
  }
}

// ── Errores ────────────────────────────────────────────────────────────────

const TREASURY_ERRORS: Array<[RegExp, string]> = [
  [/treasury_system_account/, "Esta cuenta la maneja el sistema: se ve, pero no se edita."],
  [/treasury_opening_locked/, "La cuenta ya tiene movimientos: el saldo inicial, la fecha y la moneda no se cambian. Cargá un ajuste."],
  [/treasury_account_kind_not_linkable/, "Sólo los bancos y las billeteras reciben cobros por transferencia."],
  [/currency_mismatch/, "Las dos cuentas tienen que ser de la misma moneda."],
  [/transfer_account_not_found/, "No encontramos esa cuenta de cobro por transferencia."],
  [/expense_account_invalid/, "Elegí una cuenta de gasto activa e imputable."],
  [/receipt_vat_invalid/, "El IVA del comprobante tiene que ser mayor o igual a cero y menor que el importe."],
  [/proof_path_invalid/, "No se pudo guardar el adjunto. Probá subirlo de nuevo."],
  [/acc_not_setup/, "Primero activá la contabilidad del negocio."],
  [/feature_not_in_plan: contabilidad/, "Contabilidad no está incluida en tu plan."],
  [/feature_not_in_plan: tesoreria/, "Tesorería no está incluida en tu plan."],
  [/movement_not_manual/, "Este movimiento lo generó un documento: se corrige desde la venta, la orden de pago o el cheque."],
  [/close_zero_needs_confirmation/, "Confirmá el cierre con $0 contados y escribí el motivo."],
  [/Could not find the function|PGRST202|does not exist/i, "Falta actualizar la base para usar esta función. Probá en unos minutos."],
];

export function treasuryErrorMessage(e: unknown): string {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e ?? "");
  for (const [re, text] of TREASURY_ERRORS) if (re.test(msg)) return text;
  return purchaseErrorMessage(e);
}

/** true si el error es porque la base todavía no tiene la RPC o la columna (migración sin aplicar). */
export function isMissingSchema(e: unknown): boolean {
  const msg =
    e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "";
  const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
  return code === "PGRST202" || code === "42703" || code === "42883" || /Could not find the function|does not exist|schema cache/i.test(msg);
}
