// =============================================================================
// _shared/shipping/types.ts  (Envíos y logística · ADR-103)
//
// Modelo normalizado de envíos y contrato común de los adaptadores de
// logística (CarrierAdapter). PURO: sin Deno.* ni imports remotos, así lo usan
// las Edge Functions y los tests de Vitest.
// =============================================================================

/** Estado normalizado (mismo CHECK que shipments.status). */
export type ShipmentStatus =
  | "draft"
  | "quoted"
  | "pending"
  | "created"
  | "label_ready"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "ready_for_pickup"
  | "delivered"
  | "failed_attempt"
  | "returned"
  | "cancelled"
  | "error";

export type ServiceType = "door" | "branch";
export type LabelFormat = "pdf" | "zpl";
export type LabelSize = "a4" | "10x15";

export interface Capabilities {
  quote: boolean;
  label: boolean;
  points: boolean;
  track: boolean;
  cancel: boolean;
  webhooks: boolean;
  pickup: boolean;
}

export interface Address {
  street?: string;
  number?: string;
  floor?: string;
  apartment?: string;
  city?: string;
  province?: string;
  postal_code: string;
  reference?: string;
}

export interface Party {
  name: string;
  document?: string;
  email?: string;
  phone?: string;
}

export interface Package {
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  description?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Lo que un adaptador recibe para hablar con su logística. */
export interface CarrierContext {
  /** true = ambiente de prueba del carrier. */
  sandbox: boolean;
  /** Configuración no secreta de la conexión (shipping_connections.config). */
  config: Record<string, unknown>;
  /** Secretos de la conexión (shipping_secrets.secrets). Nunca se loguean. */
  secrets: Record<string, string>;
  fetch: FetchLike;
  now: () => Date;
  /** Intento del trabajo de la cola (1 = primero). */
  attempt?: number;
}

export interface QuoteRequest {
  origin: Address;
  destination: Address;
  packages: Package[];
  declared_value: number;
  /** Sin valor: el adaptador cotiza todos los servicios que tenga. */
  service_type?: ServiceType;
}

export interface Quote {
  provider_key: string;
  service_type: ServiceType;
  service_code: string;
  service_name: string;
  /** Precio final con impuestos, en pesos. */
  cost: number;
  cost_without_tax?: number;
  currency: "ARS";
  eta_days?: { min: number; max: number };
  /** Peso que cobra el carrier (aforado). */
  billable_weight_kg?: number;
}

export interface PickupPoint {
  id: string;
  name: string;
  address: string;
  city?: string;
  province?: string;
  postal_code?: string;
  hours?: string;
  lat?: number;
  lng?: number;
  kind: "branch" | "point" | "locker";
}

export interface PointsQuery {
  postal_code: string;
}

export interface CreateShipmentRequest {
  /** Id del envío en NinjaSoft (va como referencia al carrier). */
  reference: string;
  service_type: ServiceType;
  service_code?: string;
  origin: Address;
  sender: Party;
  recipient: Party;
  destination: Address;
  pickup_point_id?: string;
  packages: Package[];
  declared_value: number;
  description?: string;
}

export interface CreatedShipment {
  /** Id del envío u orden en el carrier (para etiqueta y cancelación). */
  external_id: string;
  /** Número de seguimiento que ve el cliente. */
  tracking_number: string;
  status: ShipmentStatus;
  carrier_status?: string;
  /** Números de cada bulto si el carrier los separa. */
  package_tracking?: string[];
}

/** Lo que el worker sabe de un envío ya creado en el carrier. */
export interface ShipmentRef {
  reference: string;
  external_id: string;
  tracking_number: string;
  service_type: ServiceType;
  created_at: string;
  /** Datos para imprimir una etiqueta propia (simulador). */
  label_data?: LabelPrintData;
}

export interface LabelPrintData {
  sender_name: string;
  sender_address: string;
  recipient_name: string;
  recipient_address: string;
  recipient_city: string;
  recipient_postal_code: string;
  recipient_phone?: string;
  packages: string;
  weight: string;
}

export interface LabelFile {
  format: LabelFormat;
  size: LabelSize;
  mime: string;
  bytes: Uint8Array;
}

export interface TrackingEvent {
  /** null = evento informativo que no cambia el estado. */
  status: ShipmentStatus | null;
  carrier_status: string;
  description?: string;
  location?: string;
  /** ISO 8601 con zona. */
  occurred_at: string;
  external_event_id?: string;
}

export interface WebhookInput {
  headers: Record<string, string>;
  body: string;
}

export interface CarrierAdapter {
  key: string;
  name: string;
  capabilities: Capabilities;
  labelFormats: LabelFormat[];
  /** Qué hay que pedirle al carrier y qué campos carga el dueño. */
  testConnection(ctx: CarrierContext): Promise<{ ok: true; detail?: string }>;
  quote(ctx: CarrierContext, req: QuoteRequest): Promise<Quote[]>;
  listPoints(ctx: CarrierContext, q: PointsQuery): Promise<PickupPoint[]>;
  create(ctx: CarrierContext, req: CreateShipmentRequest): Promise<CreatedShipment>;
  label(ctx: CarrierContext, ref: ShipmentRef, format?: LabelFormat): Promise<LabelFile>;
  track(ctx: CarrierContext, ref: ShipmentRef): Promise<TrackingEvent[]>;
  cancel(ctx: CarrierContext, ref: ShipmentRef): Promise<void>;
  /** Sólo carriers con webhooks: valida firma o token y normaliza. */
  parseWebhook?(ctx: CarrierContext, input: WebhookInput): Promise<{ tracking_number: string; events: TrackingEvent[] }[]>;
  /** Estado del carrier → estado normalizado (null = no cambia el estado). */
  mapStatus(carrierStatus: string, code?: string | number | null): ShipmentStatus | null;
}

export type CarrierErrorCode =
  | "not_implemented"
  | "not_supported"
  | "invalid_credentials"
  | "missing_config"
  | "validation"
  | "not_found"
  | "not_ready"
  | "rate_limited"
  | "carrier_unavailable"
  | "timeout"
  | "network"
  | "already_final"
  | "unknown";

/**
 * Error de un adaptador. `retryable`: se puede reintentar sin riesgo.
 * `uncertain`: no sabemos si el carrier ejecutó la operación (timeout o 5xx en
 * un alta): NO se reintenta solo, porque cada orden creada se cobra.
 */
export class CarrierError extends Error {
  readonly code: CarrierErrorCode;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly httpStatus?: number;

  constructor(
    code: CarrierErrorCode,
    message: string,
    opts: { retryable?: boolean; uncertain?: boolean; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "CarrierError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.uncertain = opts.uncertain ?? false;
    this.httpStatus = opts.httpStatus;
  }
}

export function isCarrierError(e: unknown): e is CarrierError {
  return e instanceof CarrierError || (typeof e === "object" && e !== null && (e as { name?: string }).name === "CarrierError");
}

export const NO_CAPABILITIES: Capabilities = {
  quote: false,
  label: false,
  points: false,
  track: false,
  cancel: false,
  webhooks: false,
  pickup: false,
};
