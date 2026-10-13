// @vitest-environment node
// Worker de la cola de envíos (ADR-103) con base, Storage y carrier falsos.
// Lo central: un envío NUNCA se crea dos veces en el carrier.
import { describe, expect, it, vi } from "vitest";
import {
  backoffSeconds,
  originAddress,
  processJob,
  splitStreet,
  type JobKind,
  type JobRow,
  type ShipmentRow,
  type WorkerDeps,
} from "@/supabase/functions/_shared/shipping/worker";
import { simulatorAdapter } from "@/supabase/functions/_shared/shipping/simulator";
import { CarrierError, type CarrierAdapter, type TrackingEvent } from "@/supabase/functions/_shared/shipping/types";

const NOW = new Date("2026-10-13T12:00:00Z");

function shipment(over: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "t",
    store_id: "s",
    provider_key: "fake",
    connection_id: "c",
    status: "pending",
    service_type: "door",
    service_code: null,
    pickup_point: null,
    recipient: { name: "Ana" },
    destination: { street: "Alberdi", number: "3000", city: "CABA", province: "CABA", postal_code: "1406" },
    origin: { name: "Local", street: "Thames 100", city: "CABA", province: "CABA", postal_code: "1414" },
    packages: [{ weight_kg: 1, length_cm: 10, width_cm: 10, height_cm: 10 }],
    total_weight_kg: 1,
    declared_value: 1000,
    external_id: null,
    tracking_number: null,
    label_path: null,
    label_format: null,
    create_attempted_at: null,
    create_uncertain: false,
    cancel_requested_at: null,
    notes: null,
    created_at: NOW.toISOString(),
    ...over,
  };
}

function fakeAdapter(over: Partial<CarrierAdapter> = {}): CarrierAdapter {
  return {
    key: "fake",
    name: "Fake",
    capabilities: { quote: true, label: true, points: false, track: true, cancel: true, webhooks: false, pickup: false },
    labelFormats: ["pdf"],
    mapStatus: () => null,
    testConnection: async () => ({ ok: true }),
    quote: async () => [],
    listPoints: async () => [],
    create: vi.fn(async () => ({ external_id: "EXT-1", tracking_number: "TRK-1", status: "created" as const, carrier_status: "Pendiente" })),
    label: vi.fn(async () => ({ format: "pdf" as const, size: "10x15" as const, mime: "application/pdf", bytes: new Uint8Array([1]) })),
    track: vi.fn(async () => [] as TrackingEvent[]),
    cancel: vi.fn(async () => undefined),
    ...over,
  };
}

function harness(row: ShipmentRow, adapter: CarrierAdapter, opts: { creds?: boolean } = {}) {
  const state = { row: { ...row } };
  const events: { events: TrackingEvent[]; source: string }[] = [];
  const enqueued: JobKind[] = [];
  const uploads: string[] = [];
  const deps: WorkerDeps = {
    now: () => NOW,
    fetch: async () => new Response(""),
    adapters: { fake: adapter, simulador: simulatorAdapter },
    loadShipment: async () => ({ ...state.row }),
    loadCredentials: async () => (opts.creds === false ? null : { sandbox: true, config: {}, secrets: { k: "v" } }),
    loadSender: async () => ({ name: "Negocio" }),
    updateShipment: async (_id, patch) => {
      state.row = { ...state.row, ...(patch as Partial<ShipmentRow>) };
    },
    recordEvents: async (_id, e, source) => {
      events.push({ events: e, source });
    },
    enqueue: async (_s, kind) => {
      enqueued.push(kind);
    },
    uploadLabel: async (s, f) => {
      const p = `${s.tenant_id}/${s.id}.${f.format}`;
      uploads.push(p);
      return p;
    },
  };
  return { deps, state, events, enqueued, uploads };
}

const job = (kind: JobKind, attempts = 1, max = 5): JobRow => ({
  id: "j",
  tenant_id: "t",
  shipment_id: "11111111-1111-4111-8111-111111111111",
  kind,
  attempts,
  max_attempts: max,
});

describe("worker · alta idempotente", () => {
  it("crea, guarda los números, marca el intento y encola la etiqueta", async () => {
    const a = fakeAdapter();
    const h = harness(shipment(), a);
    const out = await processJob(job("create"), h.deps);
    expect(out.outcome).toBe("done");
    expect(a.create).toHaveBeenCalledTimes(1);
    expect(h.state.row).toMatchObject({ external_id: "EXT-1", tracking_number: "TRK-1", status: "created" });
    expect(h.state.row.create_attempted_at).toBe(NOW.toISOString());
    expect(h.enqueued).toEqual(["label"]);
    expect(h.events[0]!.source).toBe("system");
  });

  it("el mismo trabajo dos veces NO crea dos envíos en el carrier", async () => {
    const a = fakeAdapter();
    const h = harness(shipment(), a);
    await processJob(job("create"), h.deps);
    const again = await processJob(job("create"), h.deps);
    expect(again).toMatchObject({ outcome: "done", result: { skipped: "already_created" } });
    expect(a.create).toHaveBeenCalledTimes(1);
  });

  it("error seguro y reintentable: limpia el intento y reintenta con espera", async () => {
    const a = fakeAdapter({
      create: vi.fn(async () => {
        throw new CarrierError("rate_limited", "Demasiados pedidos", { retryable: true });
      }),
    });
    const h = harness(shipment(), a);
    const out = await processJob(job("create", 2), h.deps);
    expect(out).toMatchObject({ outcome: "retry", retrySeconds: backoffSeconds(2) });
    expect(h.state.row.create_attempted_at).toBeNull();
    expect(h.state.row.status).toBe("pending");
  });

  it("agotados los intentos queda en error con el motivo", async () => {
    const a = fakeAdapter({
      create: vi.fn(async () => {
        throw new CarrierError("carrier_unavailable", "Caído", { retryable: true });
      }),
    });
    const h = harness(shipment(), a);
    const out = await processJob(job("create", 5, 5), h.deps);
    expect(out.outcome).toBe("failed");
    expect(h.state.row).toMatchObject({ status: "error", status_detail: "Caído", create_attempted_at: null });
  });

  it("validación del carrier: falla sin reintento", async () => {
    const a = fakeAdapter({
      create: vi.fn(async () => {
        throw new CarrierError("validation", "CP inexistente");
      }),
    });
    const h = harness(shipment(), a);
    expect((await processJob(job("create"), h.deps)).outcome).toBe("failed");
    expect(h.state.row.status).toBe("error");
  });

  it("timeout en el alta: queda EN DUDA y no se vuelve a llamar al carrier", async () => {
    const create = vi.fn(async () => {
      throw new CarrierError("timeout", "Sin respuesta", { uncertain: true });
    });
    const a = fakeAdapter({ create });
    const h = harness(shipment(), a);
    const out = await processJob(job("create"), h.deps);
    expect(out.outcome).toBe("failed");
    expect(h.state.row).toMatchObject({ status: "error", create_uncertain: true });
    // Aunque el trabajo se reintente (lock vencido), no llama de nuevo.
    expect((await processJob(job("create", 2), h.deps)).error).toBe("create_uncertain");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("worker caído a mitad del alta (intento marcado sin resultado): no repite", async () => {
    const a = fakeAdapter();
    const h = harness(shipment({ create_attempted_at: "2026-10-13T11:59:00Z" }), a);
    const out = await processJob(job("create", 2), h.deps);
    expect(out.error).toBe("create_uncertain");
    expect(a.create).not.toHaveBeenCalled();
    expect(h.state.row.create_uncertain).toBe(true);
  });

  it("envío cancelado antes del alta: no llama al carrier", async () => {
    const a = fakeAdapter();
    const h = harness(shipment({ status: "cancelled" }), a);
    expect((await processJob(job("create"), h.deps)).result).toEqual({ skipped: "cancelled" });
    expect(a.create).not.toHaveBeenCalled();
  });

  it("sin conexión: error claro (salvo el simulador, que no la necesita)", async () => {
    const h = harness(shipment(), fakeAdapter(), { creds: false });
    expect((await processJob(job("create"), h.deps)).error).toBe("carrier_not_connected");
    expect(h.state.row.status).toBe("error");
    const sim = harness(shipment({ provider_key: "simulador" }), fakeAdapter(), { creds: false });
    expect((await processJob(job("create"), sim.deps)).outcome).toBe("done");
    expect(sim.state.row.tracking_number).toMatch(/^SIM/);
  });
});

describe("worker · etiqueta, seguimiento y cancelación", () => {
  it("etiqueta: sube el archivo y pasa a 'etiqueta lista'", async () => {
    const h = harness(shipment({ external_id: "EXT-1", tracking_number: "TRK-1", status: "created" }), fakeAdapter());
    expect((await processJob(job("label"), h.deps)).outcome).toBe("done");
    expect(h.state.row).toMatchObject({ status: "label_ready", label_format: "pdf", label_path: "t/11111111-1111-4111-8111-111111111111.pdf" });
  });

  it("etiqueta cuando el envío ya avanzó: guarda el archivo sin retroceder el estado", async () => {
    const h = harness(shipment({ external_id: "EXT-1", status: "in_transit" }), fakeAdapter());
    await processJob(job("label"), h.deps);
    expect(h.state.row.status).toBe("in_transit");
    expect(h.state.row.label_path).toBeTruthy();
  });

  it("etiqueta no lista: reintenta", async () => {
    const a = fakeAdapter({
      label: vi.fn(async () => {
        throw new CarrierError("not_ready", "Todavía no");
      }),
    });
    const h = harness(shipment({ external_id: "EXT-1", status: "created" }), a);
    expect((await processJob(job("label", 1), h.deps)).outcome).toBe("retry");
  });

  it("el formato preferido de la conexión se respeta si el carrier lo genera", async () => {
    const h = harness(shipment({ provider_key: "simulador", external_id: "SIM-1", tracking_number: "SIM1", status: "created" }), fakeAdapter());
    h.deps.loadCredentials = async () => ({ sandbox: true, config: { label_format: "zpl" }, secrets: {} });
    await processJob(job("label"), h.deps);
    expect(h.state.row.label_format).toBe("zpl");
    expect(h.uploads[0]).toMatch(/\.zpl$/);
  });

  it("seguimiento: pasa los eventos a la base como 'poll'", async () => {
    const evs: TrackingEvent[] = [{ status: "in_transit", carrier_status: "En viaje", occurred_at: NOW.toISOString() }];
    const h = harness(shipment({ external_id: "EXT-1", status: "label_ready" }), fakeAdapter({ track: vi.fn(async () => evs) }));
    expect((await processJob(job("track"), h.deps)).result).toEqual({ events: 1 });
    expect(h.events).toEqual([{ events: evs, source: "poll" }]);
  });

  it("seguimiento de un envío entregado: no consulta", async () => {
    const a = fakeAdapter();
    const h = harness(shipment({ external_id: "EXT-1", status: "delivered" }), a);
    await processJob(job("track"), h.deps);
    expect(a.track).not.toHaveBeenCalled();
  });

  it("cancelación aceptada: queda cancelado con evento", async () => {
    const h = harness(shipment({ external_id: "EXT-1", status: "label_ready", cancel_requested_at: NOW.toISOString() }), fakeAdapter());
    expect((await processJob(job("cancel"), h.deps)).outcome).toBe("done");
    expect(h.state.row.status).toBe("cancelled");
    expect(h.events.at(-1)!.events[0]!.status).toBe("cancelled");
  });

  it("cancelación rechazada: se libera el pedido de cancelación y se explica", async () => {
    const a = fakeAdapter({
      cancel: vi.fn(async () => {
        throw new CarrierError("already_final", "Ya fue entregado");
      }),
    });
    const h = harness(shipment({ external_id: "EXT-1", status: "in_transit", cancel_requested_at: NOW.toISOString() }), a);
    expect((await processJob(job("cancel"), h.deps)).outcome).toBe("failed");
    expect(h.state.row).toMatchObject({ status: "in_transit", cancel_requested_at: null });
  });
});

describe("worker · origen", () => {
  it("separa calle y número de la dirección de la sucursal", () => {
    expect(splitStreet("Thames 1234 piso 2")).toEqual({ street: "Thames", number: "1234" });
    expect(splitStreet("Av. San Martín, 55")).toEqual({ street: "Av. San Martín", number: "55" });
    expect(splitStreet("Ruta 3 km 40")).toEqual({ street: "Ruta", number: "3" });
    expect(splitStreet("Sin número")).toEqual({ street: "Sin número", number: "S/N" });
  });

  it("la dirección de despacho de la conexión pisa a la de la sucursal", () => {
    const s = shipment();
    expect(originAddress(s, {})).toMatchObject({ street: "Thames", number: "100", postal_code: "1414" });
    expect(originAddress(s, { origin_postal_code: "1650", origin_street: "Depósito", origin_number: "9" })).toMatchObject({
      street: "Depósito",
      number: "9",
      postal_code: "1650",
    });
  });

  it("espera creciente con tope", () => {
    expect([1, 2, 3, 10].map(backoffSeconds)).toEqual([30, 60, 120, 3600]);
  });
});
