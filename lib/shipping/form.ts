// =============================================================================
// lib/shipping/form.ts  (Envíos · ADR-103) · PURO
// Validación del formulario "Nuevo envío" (espejo de shipment_create; la base
// valida igual) y armado del payload.
// =============================================================================
import { z } from "zod";

export const POSTAL_CODE_RE = /^([0-9]{4}|[A-Za-z][0-9]{4}[A-Za-z]{3})$/;

const num = (label: string, max: number) =>
  z.coerce
    .number({ invalid_type_error: `${label}: número` })
    .positive(`${label}: mayor a 0`)
    .max(max, `${label}: hasta ${max}`);

export const packageSchema = z.object({
  weight_kg: num("Peso", 1000),
  length_cm: num("Largo", 500),
  width_cm: num("Ancho", 500),
  height_cm: num("Alto", 500),
  description: z.string().max(120).optional(),
});

export const shipmentFormSchema = z
  .object({
    store_id: z.string().uuid("Elegí la sucursal que despacha"),
    source: z.enum(["pos_sale", "order", "manual"]),
    sale_id: z.string().uuid().optional().nullable(),
    order_ref: z.string().max(80).optional(),
    service_type: z.enum(["door", "branch"]),
    recipient: z.object({
      name: z.string().trim().min(2, "Nombre del destinatario").max(120),
      document: z.string().trim().max(20).optional(),
      email: z.string().trim().email("Email inválido").max(160).optional().or(z.literal("")),
      phone: z.string().trim().max(40).optional(),
    }),
    destination: z.object({
      street: z.string().trim().max(120).optional(),
      number: z.string().trim().max(20).optional(),
      floor: z.string().trim().max(20).optional(),
      apartment: z.string().trim().max(20).optional(),
      city: z.string().trim().max(80).optional(),
      province: z.string().trim().max(80).optional(),
      postal_code: z.string().trim().regex(POSTAL_CODE_RE, "Código postal de 4 dígitos o CPA"),
      reference: z.string().trim().max(200).optional(),
    }),
    pickup_point: z.object({ id: z.string(), name: z.string().optional() }).nullable().optional(),
    packages: z.array(packageSchema).min(1, "Al menos un bulto").max(20, "Hasta 20 bultos"),
    declared_value: z.coerce.number().min(0).max(1_000_000_000),
    notes: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source === "pos_sale" && !v.sale_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sale_id"], message: "Elegí la venta" });
    }
    if (v.source === "order" && !(v.order_ref ?? "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["order_ref"], message: "Número de pedido" });
    }
    if (v.service_type === "door") {
      const d = v.destination;
      if ((d.street ?? "").trim().length < 2) ctx.addIssue({ code: "custom", path: ["destination", "street"], message: "Calle" });
      if (!(d.number ?? "").trim()) ctx.addIssue({ code: "custom", path: ["destination", "number"], message: "Número" });
      if ((d.city ?? "").trim().length < 2) ctx.addIssue({ code: "custom", path: ["destination", "city"], message: "Localidad" });
      if ((d.province ?? "").trim().length < 2) ctx.addIssue({ code: "custom", path: ["destination", "province"], message: "Provincia" });
    } else if (!v.pickup_point?.id) {
      ctx.addIssue({ code: "custom", path: ["pickup_point"], message: "Elegí la sucursal o punto de retiro" });
    }
  });

export type ShipmentForm = z.infer<typeof shipmentFormSchema>;

export interface QuoteChoice {
  provider_key: string;
  service_type: "door" | "branch";
  service_code: string;
  service_name: string;
  cost: number;
  eta_days?: { min: number; max: number };
  sandbox?: boolean;
}

/** Clave de idempotencia por intento del formulario (no por clic). */
export function newIdempotencyKey(prefix = "envio"): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${rnd}`;
}

export function buildCreatePayload(
  form: ShipmentForm,
  opts: { idempotencyKey: string; quote: QuoteChoice | null; submit: boolean },
): Record<string, unknown> {
  const clean = <T extends Record<string, unknown>>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;
  return {
    idempotency_key: opts.idempotencyKey,
    store_id: form.store_id,
    source: form.source,
    sale_id: form.source === "pos_sale" ? form.sale_id : null,
    order_ref: form.source === "order" ? form.order_ref?.trim() : null,
    service_type: opts.quote?.service_type ?? form.service_type,
    service_code: opts.quote?.service_code ?? null,
    provider_key: opts.quote?.provider_key ?? null,
    pickup_point: form.service_type === "branch" ? form.pickup_point : null,
    recipient: clean({ ...form.recipient }),
    destination: clean({ ...form.destination, postal_code: form.destination.postal_code.toUpperCase() }),
    packages: form.packages.map((p) => clean({ ...p })),
    declared_value: form.declared_value,
    quote: opts.quote ? { ...opts.quote } : null,
    notes: form.notes?.trim() || null,
    submit: opts.submit && Boolean(opts.quote),
  };
}

export const EMPTY_PACKAGE = { weight_kg: 1, length_cm: 30, width_cm: 20, height_cm: 10 };

/** Mensaje legible de los errores de las RPC y la Edge de envíos. */
export function shippingErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const map: [RegExp, string][] = [
    [/feature_not_in_plan: envios/, "Tu plan no incluye Envíos. Está desde el plan Pro."],
    [/feature_not_in_plan: multi_sucursal/, "Configurar logísticas por sucursal necesita el plan con varias sucursales."],
    [/feature_not_in_plan: (\w+)/, "Tu plan no incluye esta logística."],
    [/forbidden_read_only/, "Tu usuario es de sólo lectura."],
    [/forbidden_role/, "Sólo el dueño o un encargado puede hacer esto."],
    [/forbidden/, "No tenés acceso a esta sucursal o acción."],
    [/carrier_not_connected/, "Esa logística no está conectada para esta sucursal. Conectala en Configuración > Envíos."],
    [/provider_not_available/, "Esa logística todavía no está disponible para crear envíos."],
    [/invalid_postal_code/, "Revisá el código postal."],
    [/destination_address_required/, "Completá calle, número, localidad y provincia del destino."],
    [/pickup_point_required/, "Elegí la sucursal o punto de retiro."],
    [/recipient_name_required/, "Falta el nombre del destinatario."],
    [/invalid_package/, "Revisá peso y medidas de los bultos."],
    [/packages_required|too_many_packages/, "Cargá entre 1 y 20 bultos."],
    [/sale_not_found|sale_not_completed/, "La venta no existe o no está completada."],
    [/reason_required/, "Escribí el motivo."],
    [/carrier_cannot_cancel/, "La logística no cancela por API: confirmá cancelarlo sólo en NinjaSoft y avisale al carrier."],
    [/create_in_progress/, "El envío se está generando en este momento: probá en unos segundos."],
    [/create_uncertain/, "No sabemos si la logística creó el envío. Revisá su panel antes de reintentar."],
    [/not_cancellable/, "El envío ya terminó: no se puede cancelar."],
    [/cancel_already_requested/, "La cancelación ya está pedida."],
    [/label_not_ready/, "La etiqueta todavía no está lista."],
    [/format_not_available/, "Esa logística no genera la etiqueta en ese formato."],
    [/no_labels/, "Ninguno de los envíos elegidos tiene etiqueta en ese formato."],
    [/Could not find the (function|table)|does not exist|schema cache/, "Falta aplicar la migración de Envíos en la base."],
  ];
  for (const [re, text] of map) if (re.test(msg)) return text;
  return msg && msg.length < 200 ? msg : "No se pudo completar la operación. Probá de nuevo.";
}
