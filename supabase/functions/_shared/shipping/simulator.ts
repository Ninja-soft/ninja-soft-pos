// =============================================================================
// _shared/shipping/simulator.ts  (ADR-103)
//
// Logística simulada para probar el flujo completo en cualquier negocio con
// `envios`, sin contrato con ningún carrier: cotiza (estándar y express, a
// domicilio y a sucursal), lista puntos de retiro, crea, genera etiqueta PDF
// (10x15 o A4) y ZPL, avanza el seguimiento solo según el tiempo transcurrido
// y cancela. Determinístico (mismo pedido = mismo resultado). PURO.
//
// Escenarios por el nombre del destinatario (para probar errores):
//   "[rechazo]"  el alta falla por validación (no se reintenta).
//   "[caido]"    el carrier no responde en los 2 primeros intentos (reintento).
//   "[timeout]"  el alta queda en duda (no se sabe si se creó): revisión manual.
//   "[ausente]"  visita fallida y devolución al remitente.
// config.minutes_per_step (default 1): minutos entre cada avance del
// seguimiento.
// =============================================================================
import { labelFile } from "./labelDoc.ts";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierContext,
  type PickupPoint,
  type Quote,
  type ShipmentRef,
  type ShipmentStatus,
  type TrackingEvent,
} from "./types.ts";

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Peso que cobra el simulador: el mayor entre real y volumétrico (/4000). */
export function billableWeight(pkgs: { weight_kg: number; length_cm: number; width_cm: number; height_cm: number }[]): number {
  let total = 0;
  for (const p of pkgs) total += Math.max(p.weight_kg, (p.length_cm * p.width_cm * p.height_cm) / 4000);
  return Math.round(total * 100) / 100;
}

function zoneFactor(fromCp: string, toCp: string): number {
  const a = fromCp.replace(/\D/g, "").slice(0, 1);
  const b = toCp.replace(/\D/g, "").slice(0, 1);
  if (!a || !b) return 1.6;
  if (a === b) return fromCp.slice(0, 2) === toCp.slice(0, 2) ? 1 : 1.25;
  return 1.6;
}

const SCENARIOS = ["rechazo", "caido", "timeout", "ausente"] as const;
type Scenario = (typeof SCENARIOS)[number] | "ok";

export function scenarioOf(name: string): Scenario {
  const low = name.toLowerCase();
  return SCENARIOS.find((s) => low.includes(`[${s}]`)) ?? "ok";
}

function minutesPerStep(ctx: CarrierContext): number {
  const n = Number(ctx.config.minutes_per_step ?? 1);
  return Number.isFinite(n) && n > 0 && n <= 1440 ? n : 1;
}

const STATUS_TEXT: Record<string, string> = {
  created: "Envío generado",
  picked_up: "Retirado por el simulador",
  in_transit: "En viaje a la sucursal de destino",
  out_for_delivery: "En distribución",
  ready_for_pickup: "Disponible para retirar en el punto",
  delivered: "Entregado",
  failed_attempt: "Visita sin éxito: nadie en el domicilio",
  returned: "Devuelto al remitente",
};

/** Línea de tiempo según el escenario y el servicio (pasos de N minutos). */
export function simulatedTimeline(ref: ShipmentRef, ctx: CarrierContext): TrackingEvent[] {
  const step = minutesPerStep(ctx) * 60_000;
  const start = Date.parse(ref.created_at);
  const now = ctx.now().getTime();
  const away = ref.external_id.endsWith("-A");
  const plan: ShipmentStatus[] = away
    ? ["created", "picked_up", "in_transit", "out_for_delivery", "failed_attempt", "returned"]
    : ref.service_type === "branch"
      ? ["created", "picked_up", "in_transit", "ready_for_pickup", "delivered"]
      : ["created", "picked_up", "in_transit", "out_for_delivery", "delivered"];
  const out: TrackingEvent[] = [];
  plan.forEach((status, i) => {
    const at = start + i * 2 * step;
    if (at > now) return;
    out.push({
      status,
      carrier_status: `SIM_${status.toUpperCase()}`,
      description: STATUS_TEXT[status] ?? status,
      location: status === "created" || status === "picked_up" ? "Centro de distribución simulado" : "Sucursal simulada destino",
      occurred_at: new Date(at).toISOString(),
      external_event_id: `${ref.external_id}:${i}`,
    });
  });
  return out;
}

const SIM_STATUS: Record<string, ShipmentStatus> = Object.fromEntries(
  ["created", "picked_up", "in_transit", "out_for_delivery", "ready_for_pickup", "delivered", "failed_attempt", "returned", "cancelled"].map(
    (s) => [`SIM_${s.toUpperCase()}`, s as ShipmentStatus],
  ),
);

export const simulatorAdapter: CarrierAdapter = {
  key: "simulador",
  name: "Simulador de envíos",
  capabilities: { quote: true, label: true, points: true, track: true, cancel: true, webhooks: false, pickup: false },
  labelFormats: ["pdf", "zpl"],

  mapStatus(carrierStatus) {
    return SIM_STATUS[carrierStatus] ?? null;
  },

  async testConnection() {
    return { ok: true, detail: "El simulador no necesita credenciales." };
  },

  async quote(_ctx, req) {
    const kg = billableWeight(req.packages);
    const zone = zoneFactor(req.origin.postal_code ?? "", req.destination.postal_code);
    const base = 2500 + 900 * kg;
    const insurance = Math.round(req.declared_value * 0.01);
    const make = (service_type: "door" | "branch", code: string, name: string, mult: number, eta: [number, number]): Quote => {
      const cost = Math.round((base * zone * mult + insurance) * 100) / 100;
      return {
        provider_key: "simulador",
        service_type,
        service_code: code,
        service_name: name,
        cost,
        cost_without_tax: Math.round((cost / 1.21) * 100) / 100,
        currency: "ARS",
        eta_days: { min: eta[0], max: eta[1] },
        billable_weight_kg: kg,
      };
    };
    const all = [
      make("door", "SIM_STD_DOOR", "Estándar a domicilio", 1, [3, 5]),
      make("door", "SIM_EXP_DOOR", "Express a domicilio", 1.5, [1, 2]),
      make("branch", "SIM_STD_BRANCH", "Estándar a punto de retiro", 0.8, [3, 5]),
    ];
    return req.service_type ? all.filter((q) => q.service_type === req.service_type) : all;
  },

  async listPoints(_ctx, q) {
    const cp = q.postal_code.replace(/\D/g, "").slice(0, 4) || "0000";
    const names = ["Punto Centro", "Punto Estación", "Locker Plaza"];
    return names.map((name, i): PickupPoint => ({
      id: `SIM-${cp}-${i + 1}`,
      name: `${name} (simulado)`,
      address: `Calle Simulada ${100 * (i + 1)}`,
      postal_code: cp,
      city: "Ciudad simulada",
      hours: "Lunes a sábado de 9 a 19",
      kind: i === 2 ? "locker" : "point",
    }));
  },

  async create(ctx, req) {
    const sc = scenarioOf(req.recipient.name);
    const attempt = ctx.attempt ?? 1;
    if (sc === "rechazo") {
      throw new CarrierError("validation", "El simulador rechazó el envío: dirección incompleta (escenario [rechazo]).");
    }
    if (sc === "caido" && attempt < 3) {
      throw new CarrierError("carrier_unavailable", "El simulador no responde (escenario [caido]).", { retryable: true, httpStatus: 503 });
    }
    if (sc === "timeout") {
      throw new CarrierError("timeout", "El simulador no respondió a tiempo: no se sabe si creó el envío (escenario [timeout]).", {
        uncertain: true,
      });
    }
    const h = hashString(req.reference).toString().padStart(10, "0").slice(0, 10);
    return {
      external_id: `SIM-${req.reference.slice(0, 8).toUpperCase()}${sc === "ausente" ? "-A" : ""}`,
      tracking_number: `SIM${h}`,
      status: "created",
      carrier_status: "SIM_CREATED",
      package_tracking: req.packages.map((_, i) => `SIM${h}${String(i + 1).padStart(2, "0")}`),
    };
  },

  async label(ctx, ref, format) {
    const size = ctx.config.label_size === "a4" ? "a4" : "10x15";
    const meta = ref.label_data;
    return labelFile(
      {
        carrier: "SIMULADOR",
        service: ref.service_type === "branch" ? "A PUNTO" : "A DOMICILIO",
        tracking: ref.tracking_number,
        reference: ref.reference.slice(0, 8),
        sender: { name: meta?.sender_name ?? "Remitente", address: meta?.sender_address ?? "" },
        recipient: {
          name: meta?.recipient_name ?? "Destinatario",
          address: meta?.recipient_address ?? "",
          city: meta?.recipient_city ?? "",
          postal_code: meta?.recipient_postal_code ?? "",
          phone: meta?.recipient_phone,
        },
        packages: meta?.packages ?? "1",
        weight: meta?.weight ?? "",
        createdAt: ref.created_at.slice(0, 10),
        note: "Etiqueta de prueba: no sirve para despachar",
      },
      format === "zpl" ? "zpl" : "pdf",
      size,
    );
  },

  async track(ctx, ref) {
    return simulatedTimeline(ref, ctx);
  },

  async cancel(ctx, ref) {
    const done = simulatedTimeline(ref, ctx).some((e) => e.status === "delivered" || e.status === "returned");
    if (done) throw new CarrierError("already_final", "El envío simulado ya fue entregado o devuelto.");
  },
};
