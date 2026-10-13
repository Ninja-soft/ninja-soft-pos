// =============================================================================
// _shared/shipping/worker.ts  (ADR-103)
//
// Procesa UN trabajo de la cola shipping_jobs (create, label, track, cancel)
// con dependencias inyectadas (base, Storage, adaptadores, reloj). PURO: la
// Edge `shipping` le pasa la implementación real y los tests una falsa.
//
// Garantía central: un envío NUNCA se crea dos veces en el carrier (cada
// orden se cobra).
//   • Si el envío ya tiene external_id, el alta no se repite (idempotente).
//   • Antes de llamar al carrier se marca create_attempted_at. Si un intento
//     termina con un error SEGURO (validación, 429, conexión rechazada antes
//     de mandar) se limpia y se puede reintentar. Si termina EN DUDA (timeout,
//     5xx o el worker se cayó en el medio y el lock venció), el envío queda en
//     "error" con create_uncertain: se revisa el panel del carrier y se
//     reintenta a mano (shipment_retry con p_force).
// =============================================================================
import { isFinal } from "./status.ts";
import {
  CarrierError,
  isCarrierError,
  type Address,
  type CarrierAdapter,
  type CarrierContext,
  type CreateShipmentRequest,
  type FetchLike,
  type LabelFile,
  type LabelFormat,
  type Package,
  type Party,
  type ServiceType,
  type ShipmentRef,
  type ShipmentStatus,
  type TrackingEvent,
} from "./types.ts";

export type JobKind = "create" | "label" | "track" | "cancel";

export interface JobRow {
  id: string;
  tenant_id: string;
  shipment_id: string;
  kind: JobKind;
  attempts: number;
  max_attempts: number;
}

export interface ShipmentRow {
  id: string;
  tenant_id: string;
  store_id: string;
  provider_key: string | null;
  connection_id: string | null;
  status: ShipmentStatus;
  service_type: ServiceType;
  service_code: string | null;
  pickup_point: { id?: string; name?: string } | null;
  recipient: Party;
  destination: Address;
  origin: Address & { name?: string; phone?: string; email?: string };
  packages: Package[];
  total_weight_kg: number;
  declared_value: number;
  external_id: string | null;
  tracking_number: string | null;
  label_path: string | null;
  label_format: LabelFormat | null;
  create_attempted_at: string | null;
  create_uncertain: boolean;
  cancel_requested_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface Credentials {
  sandbox: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export type ShipmentPatch = Partial<
  Pick<
    ShipmentRow,
    | "status"
    | "external_id"
    | "tracking_number"
    | "label_path"
    | "label_format"
    | "create_attempted_at"
    | "create_uncertain"
    | "cancel_requested_at"
  >
> & {
  status_detail?: string | null;
  carrier_status?: string | null;
  label_ready_at?: string;
  cancelled_at?: string;
  next_track_at?: string | null;
};

export interface WorkerDeps {
  now(): Date;
  fetch: FetchLike;
  adapters: Record<string, CarrierAdapter>;
  loadShipment(id: string): Promise<ShipmentRow | null>;
  /** Credencial con la que se opera (la de la conexión del envío; si no, la efectiva). */
  loadCredentials(s: ShipmentRow): Promise<Credentials | null>;
  /** Remitente: datos del negocio y la sucursal. */
  loadSender(s: ShipmentRow): Promise<Party>;
  updateShipment(id: string, patch: ShipmentPatch): Promise<void>;
  recordEvents(id: string, events: TrackingEvent[], source: "system" | "poll"): Promise<void>;
  enqueue(s: ShipmentRow, kind: JobKind, delaySeconds: number): Promise<void>;
  uploadLabel(s: ShipmentRow, file: LabelFile): Promise<string>;
}

export interface JobOutcome {
  outcome: "done" | "retry" | "failed";
  error?: string;
  retrySeconds?: number;
  result?: Record<string, unknown>;
}

export const UNCERTAIN_DETAIL =
  "No sabemos si la logística creó el envío (no respondió a tiempo). Revisá su panel antes de reintentar: si lo creó, cargalo a mano; si no, reintentá.";

/** Espera antes del próximo intento: 30 s, 1, 2, 4... minutos, tope 1 h. */
export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function toCarrierError(e: unknown): CarrierError {
  if (isCarrierError(e)) return e as CarrierError;
  const msg = e instanceof Error ? e.message : String(e);
  return new CarrierError("unknown", msg.slice(0, 300) || "Error de la logística");
}

/** "Thames 1234 piso 2" → calle y número (el número es el primer token con dígitos). */
export function splitStreet(address: string | undefined): { street: string; number: string } {
  const a = (address ?? "").trim();
  const m = /^(.*?)[\s,]+(\d+[a-zA-Z]?)\b(.*)$/.exec(a);
  if (!m) return { street: a, number: "S/N" };
  return { street: m[1]!.trim(), number: m[2]! };
}

/** Origen: dirección de despacho de la conexión o, si no, la de la sucursal. */
export function originAddress(s: ShipmentRow, config: Record<string, unknown>): Address {
  const c = (k: string) => (typeof config[k] === "string" && (config[k] as string).trim() ? (config[k] as string).trim() : undefined);
  if (c("origin_postal_code")) {
    return {
      street: c("origin_street"),
      number: c("origin_number"),
      city: c("origin_city"),
      province: c("origin_province"),
      postal_code: c("origin_postal_code")!,
    };
  }
  const o = s.origin ?? ({} as ShipmentRow["origin"]);
  const st = o.number ? { street: o.street ?? "", number: o.number } : splitStreet(o.street);
  return { street: st.street, number: st.number, city: o.city, province: o.province, postal_code: o.postal_code ?? "" };
}

export function shipmentRef(s: ShipmentRow): ShipmentRef {
  const d = s.destination ?? ({} as Address);
  const o = s.origin ?? ({} as ShipmentRow["origin"]);
  return {
    reference: s.id,
    external_id: s.external_id ?? "",
    tracking_number: s.tracking_number ?? s.external_id ?? "",
    service_type: s.service_type,
    created_at: s.created_at,
    label_data: {
      sender_name: o.name ?? "",
      sender_address: [o.street, o.city].filter(Boolean).join(", "),
      recipient_name: s.recipient?.name ?? "",
      recipient_address:
        s.service_type === "branch"
          ? `Retira en: ${s.pickup_point?.name ?? s.pickup_point?.id ?? ""}`
          : [d.street, d.number, d.floor ? `piso ${d.floor}` : "", d.apartment ? `dto. ${d.apartment}` : ""].filter(Boolean).join(" "),
      recipient_city: d.city ?? "",
      recipient_postal_code: d.postal_code ?? "",
      recipient_phone: s.recipient?.phone,
      packages: String(s.packages?.length ?? 1),
      weight: `${Number(s.total_weight_kg ?? 0).toLocaleString("es-AR")} kg`,
    },
  };
}

export function createRequest(s: ShipmentRow, sender: Party, config: Record<string, unknown>): CreateShipmentRequest {
  return {
    reference: s.id,
    service_type: s.service_type,
    service_code: s.service_code ?? undefined,
    origin: originAddress(s, config),
    sender,
    recipient: s.recipient,
    destination: s.destination,
    pickup_point_id: s.pickup_point?.id,
    packages: s.packages,
    declared_value: Number(s.declared_value ?? 0),
    description: s.notes ?? undefined,
  };
}

function sysEvent(status: ShipmentStatus | null, description: string, now: Date, carrier = "NINJASOFT"): TrackingEvent {
  return { status, carrier_status: carrier, description: description.slice(0, 500), occurred_at: now.toISOString() };
}

export function preferredLabelFormat(adapter: CarrierAdapter, config: Record<string, unknown>): LabelFormat {
  const want = config.label_format;
  if ((want === "pdf" || want === "zpl") && adapter.labelFormats.includes(want)) return want;
  return adapter.labelFormats[0] ?? "pdf";
}

export async function processJob(job: JobRow, deps: WorkerDeps): Promise<JobOutcome> {
  const s = await deps.loadShipment(job.shipment_id);
  if (!s) return { outcome: "failed", error: "shipment_not_found" };
  const adapter = deps.adapters[s.provider_key ?? ""];
  if (!adapter) return { outcome: "failed", error: "no_adapter" };

  let cred = await deps.loadCredentials(s);
  if (!cred && s.provider_key === "simulador") cred = { sandbox: true, config: {}, secrets: {} };
  if (!cred) {
    if (job.kind === "create") {
      await deps.updateShipment(s.id, { status: "error", status_detail: "La logística no está conectada para esta sucursal." });
      await deps.recordEvents(s.id, [sysEvent("error", "La logística no está conectada para esta sucursal.", deps.now())], "system");
    }
    return { outcome: "failed", error: "carrier_not_connected" };
  }
  const ctx: CarrierContext = { ...cred, fetch: deps.fetch, now: deps.now, attempt: job.attempts };
  const now = deps.now();

  switch (job.kind) {
    case "create":
      return runCreate(job, s, adapter, ctx, deps, now);
    case "label":
      return runLabel(job, s, adapter, ctx, deps, now);
    case "track":
      return runTrack(job, s, adapter, ctx, deps);
    case "cancel":
      return runCancel(job, s, adapter, ctx, deps, now);
    default:
      return { outcome: "failed", error: "invalid_kind" };
  }
}

async function runCreate(
  job: JobRow,
  s: ShipmentRow,
  adapter: CarrierAdapter,
  ctx: CarrierContext,
  deps: WorkerDeps,
  now: Date,
): Promise<JobOutcome> {
  if (s.status === "cancelled") return { outcome: "done", result: { skipped: "cancelled" } };
  if (s.external_id) {
    if (!s.label_path && adapter.capabilities.label) await deps.enqueue(s, "label", 0);
    return { outcome: "done", result: { skipped: "already_created" } };
  }
  // Un intento anterior quedó sin resultado conocido: no se repite solo.
  if (s.create_attempted_at || s.create_uncertain) {
    await deps.updateShipment(s.id, { create_uncertain: true, status: "error", status_detail: UNCERTAIN_DETAIL });
    await deps.recordEvents(s.id, [sysEvent("error", UNCERTAIN_DETAIL, now)], "system");
    return { outcome: "failed", error: "create_uncertain" };
  }

  await deps.updateShipment(s.id, { create_attempted_at: now.toISOString() });
  const sender = await deps.loadSender(s);
  try {
    const created = await adapter.create(ctx, createRequest(s, sender, ctx.config));
    await deps.updateShipment(s.id, {
      external_id: created.external_id,
      tracking_number: created.tracking_number,
      status: "created",
      carrier_status: created.carrier_status ?? null,
      status_detail: null,
      next_track_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
    });
    await deps.recordEvents(
      s.id,
      [sysEvent("created", `Envío creado en ${adapter.name}. Seguimiento ${created.tracking_number}.`, now, created.carrier_status ?? "CREATED")],
      "system",
    );
    if (adapter.capabilities.label) await deps.enqueue(s, "label", 0);
    return { outcome: "done", result: { external_id: created.external_id, tracking_number: created.tracking_number } };
  } catch (e) {
    const ce = toCarrierError(e);
    if (ce.uncertain) {
      await deps.updateShipment(s.id, { create_uncertain: true, status: "error", status_detail: `${UNCERTAIN_DETAIL} (${ce.message})`.slice(0, 500) });
      await deps.recordEvents(s.id, [sysEvent("error", UNCERTAIN_DETAIL, now)], "system");
      return { outcome: "failed", error: `uncertain: ${ce.message}` };
    }
    // Error seguro: no se creó nada en el carrier.
    if (ce.retryable && job.attempts < job.max_attempts) {
      await deps.updateShipment(s.id, { create_attempted_at: null, status_detail: `Reintentando: ${ce.message}`.slice(0, 500) });
      return { outcome: "retry", error: ce.message, retrySeconds: backoffSeconds(job.attempts) };
    }
    await deps.updateShipment(s.id, { create_attempted_at: null, status: "error", status_detail: ce.message.slice(0, 500) });
    await deps.recordEvents(s.id, [sysEvent("error", `La logística rechazó el envío: ${ce.message}`, now)], "system");
    return { outcome: "failed", error: ce.message };
  }
}

async function runLabel(
  job: JobRow,
  s: ShipmentRow,
  adapter: CarrierAdapter,
  ctx: CarrierContext,
  deps: WorkerDeps,
  now: Date,
): Promise<JobOutcome> {
  if (!s.external_id) return { outcome: "failed", error: "not_created" };
  if (s.status === "cancelled") return { outcome: "done", result: { skipped: "cancelled" } };
  try {
    const file = await adapter.label(ctx, shipmentRef(s), preferredLabelFormat(adapter, ctx.config));
    const path = await deps.uploadLabel(s, file);
    const keep = !["pending", "created", "error"].includes(s.status);
    await deps.updateShipment(s.id, {
      label_path: path,
      label_format: file.format,
      label_ready_at: now.toISOString(),
      ...(keep ? {} : { status: "label_ready" as ShipmentStatus, status_detail: null }),
    });
    await deps.recordEvents(s.id, [sysEvent("label_ready", "Etiqueta lista para imprimir.", now, "LABEL")], "system");
    return { outcome: "done", result: { path, format: file.format } };
  } catch (e) {
    const ce = toCarrierError(e);
    if ((ce.retryable || ce.code === "not_ready") && job.attempts < job.max_attempts) {
      return { outcome: "retry", error: ce.message, retrySeconds: Math.min(backoffSeconds(job.attempts), 600) };
    }
    await deps.updateShipment(s.id, { status_detail: `No se pudo generar la etiqueta: ${ce.message}`.slice(0, 500) });
    return { outcome: "failed", error: ce.message };
  }
}

async function runTrack(job: JobRow, s: ShipmentRow, adapter: CarrierAdapter, ctx: CarrierContext, deps: WorkerDeps): Promise<JobOutcome> {
  if (!s.external_id || isFinal(s.status)) return { outcome: "done", result: { skipped: true } };
  try {
    const events = await adapter.track(ctx, shipmentRef(s));
    await deps.recordEvents(s.id, events, "poll");
    return { outcome: "done", result: { events: events.length } };
  } catch (e) {
    const ce = toCarrierError(e);
    if (ce.retryable && job.attempts < job.max_attempts) {
      return { outcome: "retry", error: ce.message, retrySeconds: backoffSeconds(job.attempts) };
    }
    return { outcome: "failed", error: ce.message };
  }
}

async function runCancel(
  job: JobRow,
  s: ShipmentRow,
  adapter: CarrierAdapter,
  ctx: CarrierContext,
  deps: WorkerDeps,
  now: Date,
): Promise<JobOutcome> {
  if (s.status === "cancelled") return { outcome: "done", result: { skipped: "cancelled" } };
  const finish = async (detail: string) => {
    await deps.updateShipment(s.id, {
      status: "cancelled",
      cancelled_at: now.toISOString(),
      next_track_at: null,
      status_detail: detail,
    });
    await deps.recordEvents(s.id, [sysEvent("cancelled", detail, now, "CANCELLED")], "system");
  };
  if (!s.external_id) {
    await finish("Cancelado antes de crearse en la logística.");
    return { outcome: "done" };
  }
  try {
    await adapter.cancel(ctx, shipmentRef(s));
    await finish(`Cancelado en ${adapter.name}.`);
    return { outcome: "done" };
  } catch (e) {
    const ce = toCarrierError(e);
    if (ce.retryable && job.attempts < job.max_attempts) {
      return { outcome: "retry", error: ce.message, retrySeconds: backoffSeconds(job.attempts) };
    }
    await deps.updateShipment(s.id, { cancel_requested_at: null, status_detail: `La logística no canceló: ${ce.message}`.slice(0, 500) });
    await deps.recordEvents(s.id, [sysEvent(null, `La logística no canceló el envío: ${ce.message}`, now, "CANCEL_FAILED")], "system");
    return { outcome: "failed", error: ce.message };
  }
}
