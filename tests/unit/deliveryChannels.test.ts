// @vitest-environment node
// =============================================================================
// Canales de delivery externos (ADR-102): firma, adaptador simulador, máquina
// de estados (espejo del SQL), idempotencia de la reconciliación, cola
// saliente, sugerencias de mapeo, esqueletos de Rappi y PedidosYa y chequeos
// estáticos de las migraciones 20261110200*.
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildSignatureHeader,
  hmacSha256Hex,
  parseSignatureHeader,
  verifySignatureHeader,
} from "@/supabase/functions/_shared/deliveryChannels/signature";
import {
  buildSimulatedOrder,
  parseSimOrder,
  parseSimWebhook,
  SIM_SIGNATURE_HEADER,
  signSimBody,
  simulateCourier,
  simulatorAdapter,
  simWebhookBody,
  type SimProduct,
} from "@/supabase/functions/_shared/deliveryChannels/simulator";
import {
  boardStatusFor,
  canTransition,
  EXTERNAL_STATUSES,
  localActions,
  outboxBackoffSeconds,
} from "@/supabase/functions/_shared/deliveryChannels/stateMachine";
import { reconcileEvents, runOutboxAction, type OutboxRow } from "@/supabase/functions/_shared/deliveryChannels/worker";
import { getAdapter } from "@/supabase/functions/_shared/deliveryChannels/registry";
import { RAPPI_SIGNATURE_HEADER } from "@/supabase/functions/_shared/deliveryChannels/rappi";
import {
  NotImplementedError,
  type ConnectionContext,
  type DeliveryChannelAdapter,
  type ExternalStatus,
  type SimStore,
} from "@/supabase/functions/_shared/deliveryChannels/types";
import { nameSimilarity, simulatorExternalId, suggestMappings } from "@/lib/deliveryChannels/mapping";
import { channelErrorMessage } from "@/modules/deliveryChannels/api";

const SECRET = "s3cret-de-prueba-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 13, 15, 0, 0);

function memoryStore() {
  const rows = new Map<string, { payload: unknown; status: string; sent: boolean; at: number }>();
  const store: SimStore = {
    async put(id, payload, status, sent) {
      const prev = rows.get(id);
      rows.set(id, { payload: payload ?? prev?.payload ?? {}, status, sent: (prev?.sent ?? false) || sent, at: prev?.at ?? NOW });
    },
    async recent() {
      return [...rows.entries()].map(([id, r]) => ({
        external_order_id: id,
        payload: r.payload as never,
        platform_status: r.status,
        webhook_sent: r.sent,
      }));
    },
  };
  return { rows, store };
}

function ctx(extra: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: "00000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-0000000000aa",
    provider: "simulador",
    externalStoreId: "SIM-ABC",
    webhookSecret: SECRET,
    credentials: {},
    now: () => NOW,
    ...extra,
  };
}

const products: SimProduct[] = [
  { product_id: "p1", name: "Milanesa napolitana", sku: "MILA", price: 1000, external_id: "SIM-MILA" },
  { product_id: "p2", name: "Papas fritas", sku: "PAPAS", price: 500, external_id: "SIM-PAPAS" },
  { product_id: "p3", name: "Gaseosa", sku: null, price: 800, external_id: "SIM-12345678" },
];

// rng determinístico
function seq(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("firma HMAC (formato Rappi)", () => {
  it("firma y verifica el cuerpo crudo", async () => {
    const body = JSON.stringify({ a: 1 });
    const header = await buildSignatureHeader(SECRET, body, NOW / 1000);
    expect(parseSignatureHeader(header)).toEqual({ t: NOW / 1000, sign: await hmacSha256Hex(SECRET, `${NOW / 1000}.${body}`) });
    expect(await verifySignatureHeader(header, SECRET, body, NOW)).toBe(true);
  });

  it("rechaza cuerpo alterado, otro secreto, firma vieja y header roto", async () => {
    const body = JSON.stringify({ a: 1 });
    const header = await buildSignatureHeader(SECRET, body, NOW / 1000);
    expect(await verifySignatureHeader(header, SECRET, body + " ", NOW)).toBe(false);
    expect(await verifySignatureHeader(header, "otro-secreto-que-no-es", body, NOW)).toBe(false);
    expect(await verifySignatureHeader(header, SECRET, body, NOW + 301_000)).toBe(false);
    expect(await verifySignatureHeader("t=abc,sign=zz", SECRET, body, NOW)).toBe(false);
    expect(await verifySignatureHeader(null, SECRET, body, NOW)).toBe(false);
    expect(await verifySignatureHeader(header, "", body, NOW)).toBe(false);
  });

  it("acepta el header con espacios y en otro orden", async () => {
    const sign = await hmacSha256Hex(SECRET, `${NOW / 1000}.x`);
    expect(await verifySignatureHeader(` sign=${sign} , t=${NOW / 1000}`, SECRET, "x", NOW)).toBe(true);
  });
});

describe("adaptador simulador", () => {
  it("verifica la firma con el secreto de la conexión", async () => {
    const raw = JSON.stringify(simWebhookBody("SIM-ABC", "O1", "ORDER_CANCELLED", { reason: "x" }, "ev-1"));
    const headers = new Headers({ [SIM_SIGNATURE_HEADER]: await signSimBody(SECRET, raw, NOW) });
    expect(await simulatorAdapter.verifySignature({ headers, rawBody: raw }, ctx())).toBe(true);
    expect(await simulatorAdapter.verifySignature({ headers, rawBody: raw }, ctx({ webhookSecret: "otro-secreto-xxxxxxxx" }))).toBe(false);
  });

  it("normaliza un pedido nuevo con ítems, modificadores y marca", () => {
    const order = buildSimulatedOrder(products, { brand: "rappi", rng: seq([0.1, 0.5, 0.2, 0.9, 0.3]), now: NOW });
    const raw = JSON.stringify(simWebhookBody("SIM-ABC", order.external_order_id, "ORDER_NEW", { order }, "ev-new"));
    const parsed = parseSimWebhook(raw, { externalStoreId: "SIM-ABC" });
    expect(parsed.events).toHaveLength(1);
    const ev = parsed.events[0]!;
    expect(ev.type).toBe("order.new");
    if (ev.type !== "order.new") return;
    expect(ev.external_event_id).toBe("ev-new");
    expect(ev.order.brand).toBe("rappi");
    expect(ev.order.items.length).toBeGreaterThan(0);
    expect(ev.order.items.every((i) => i.unit_price > 0 && i.quantity >= 1)).toBe(true);
    expect(ev.order.total).toBe(
      Math.round(ev.order.items.reduce((a, i) => a + i.quantity * i.unit_price, 0) * 100) / 100,
    );
  });

  it("otro local, evento desconocido o estado inválido se rechazan", () => {
    const body = (event: string, data: Record<string, unknown>, store = "SIM-ABC") =>
      JSON.stringify({ event_id: "e", event, store_id: store, order_id: "O1", data });
    expect(() => parseSimWebhook(body("ORDER_CANCELLED", {}, "OTRO"), { externalStoreId: "SIM-ABC" })).toThrow(/store_mismatch/);
    expect(() => parseSimWebhook(body("NOPE", {}), { externalStoreId: "SIM-ABC" })).toThrow(/invalid_event/);
    expect(() => parseSimWebhook(body("ORDER_STATUS", { status: "volando" }), { externalStoreId: "SIM-ABC" })).toThrow(/invalid_status/);
    expect(() => parseSimOrder({ external_order_id: "X", items: [] })).toThrow(/items/);
  });

  it("repartidor: se acerca y el ETA baja hasta 0", () => {
    const first = simulateCourier(0, () => 0);
    const last = simulateCourier(4, () => 0);
    expect(first.eta_minutes).toBe(12);
    expect(last.eta_minutes).toBe(0);
    expect(last.tracking_url).toMatch(/^https:\/\/www\.google\.com\/maps\?q=/);
    const raw = JSON.stringify(simWebhookBody("SIM-ABC", "O1", "COURIER", { courier: first }, "c1"));
    const ev = parseSimWebhook(raw, { externalStoreId: "SIM-ABC" }).events[0]!;
    expect(ev.type).toBe("courier.update");
  });

  it("ítem sin mapear y reparto propio con envío", () => {
    const order = buildSimulatedOrder(products, { brand: "pedidosya", unmappedItem: true, logistics: "propia", rng: () => 0.2, now: NOW });
    expect(order.items.some((i) => i.external_id === "SIM-NOMAP-1")).toBe(true);
    expect(order.delivery_fee).toBe(900);
    expect(() => buildSimulatedOrder([], { brand: "rappi" })).toThrow(/sin_productos/);
  });

  it("las acciones salientes cambian el estado en la plataforma simulada", async () => {
    const { rows, store } = memoryStore();
    await store.put("O1", parseSimOrder({ external_order_id: "O1", items: [{ name: "x", unit_price: 1 }] }), "nuevo", false);
    const c = ctx({ simStore: store });
    expect((await simulatorAdapter.accept({ external_order_id: "O1" }, 20, c)).ok).toBe(true);
    expect(rows.get("O1")!.status).toBe("aceptado");
    expect(rows.get("O1")!.sent).toBe(true);
    await simulatorAdapter.markReady({ external_order_id: "O1" }, c);
    expect(rows.get("O1")!.status).toBe("listo");
  });

  it("con fail_actions la plataforma no responde y el error es reintentable", async () => {
    const r = await simulatorAdapter.accept({ external_order_id: "O1" }, 20, ctx({ credentials: { fail_actions: ["accept"] } }));
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it("pedidos recientes: saltea los que no tienen datos", async () => {
    const { store } = memoryStore();
    await store.put("A", parseSimOrder({ external_order_id: "A", items: [{ name: "x", unit_price: 1 }] }), "cancelado", false);
    await store.put("B", null, "aceptado", true);
    const recent = await simulatorAdapter.fetchRecentOrders(new Date(NOW - 60_000), ctx({ simStore: store }));
    expect(recent).toHaveLength(1);
    expect(recent[0]!.status).toBe("cancelado");
  });
});

describe("máquina de estados (espejo del SQL)", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "supabase", "migrations", "20261110200200_canales_delivery_flujo.sql"),
    "utf8",
  );

  it("canTransition coincide con _channel_can_transition", () => {
    const body = /function _channel_can_transition[\s\S]*?\$\$;/.exec(sql)![0];
    const sqlNext = new Map<string, string[]>();
    for (const m of body.matchAll(/when '(\w+)'\s+then p_to (?:in \(([^)]*)\)|= '(\w+)')/g)) {
      const list = m[2] ? [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]!) : [m[3]!];
      sqlNext.set(m[1]!, list);
    }
    for (const from of EXTERNAL_STATUSES) {
      for (const to of EXTERNAL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe((sqlNext.get(from) ?? []).includes(to));
      }
    }
  });

  it("no retrocede ni repite", () => {
    expect(canTransition("listo", "aceptado")).toBe(false);
    expect(canTransition("aceptado", "aceptado")).toBe(false);
    expect(canTransition("cancelado", "aceptado")).toBe(false);
    expect(canTransition("entregado", "cancelado")).toBe(true);
  });

  it("columna del tablero: hasta facturar no pasa a entregado", () => {
    expect(boardStatusFor("nuevo", "delivery")).toBe("recibido");
    expect(boardStatusFor("aceptado", "delivery")).toBe("preparando");
    expect(boardStatusFor("listo", "delivery")).toBe("listo");
    expect(boardStatusFor("retirado", "delivery")).toBe("en_camino");
    expect(boardStatusFor("entregado", "takeaway")).toBe("listo");
    expect(boardStatusFor("cancelado", "delivery")).toBe("cancelado");
  });

  it("backoff 15 s, 30 s, 1 min... tope 15 min (igual al SQL)", () => {
    expect([1, 2, 3, 4, 7, 20].map(outboxBackoffSeconds)).toEqual([15, 30, 60, 120, 900, 900]);
    expect(outboxBackoffSeconds(0)).toBe(15);
    expect(sql).toMatch(/least\(15 \* power\(2, greatest\(coalesce\(p_attempt, 1\), 1\) - 1\), 900\)/);
  });

  it("acciones del local por estado", () => {
    expect(localActions("nuevo")).toEqual(["accept", "reject"]);
    expect(localActions("aceptado")).toEqual(["ready", "picked_up"]);
    expect(localActions("cancelado")).toEqual([]);
  });
});

describe("idempotencia de la reconciliación y cola saliente", () => {
  it("eventos con ids estables: correrla dos veces da los mismos", () => {
    const order = parseSimOrder({ external_order_id: "R1", items: [{ name: "x", unit_price: 1 }] });
    const a = reconcileEvents([{ order, status: "cancelado" }]);
    const b = reconcileEvents([{ order, status: "cancelado" }]);
    expect(a.map((e) => e.external_event_id)).toEqual(["recon:R1", "recon-cancel:R1"]);
    expect(b.map((e) => e.external_event_id)).toEqual(a.map((e) => e.external_event_id));
    expect(reconcileEvents([{ order, status: "retirado" }]).map((e) => e.type)).toEqual(["order.new", "order.status"]);
    expect(reconcileEvents([{ order }])).toHaveLength(1);
  });

  const row = (action: OutboxRow["action"], payload: Record<string, unknown> = {}): OutboxRow => ({
    id: "x",
    tenant_id: "t",
    connection_id: "c",
    provider: "simulador",
    external_store_id: "SIM",
    action,
    payload,
    attempts: 1,
    channel_order_id: "o",
    external_order_id: "O1",
    brand: "rappi",
  });

  it("sin implementar no se reintenta; un error de red sí", async () => {
    const rappi = getAdapter("rappi")!;
    expect(await runOutboxAction(rappi, row("accept"), ctx({ provider: "rappi" }))).toMatchObject({ ok: false, retryable: false });
    const broken: DeliveryChannelAdapter = {
      ...simulatorAdapter,
      accept: async () => {
        throw new Error("fetch failed");
      },
    };
    expect(await runOutboxAction(broken, row("accept"), ctx())).toMatchObject({ ok: false, retryable: true, error: "fetch failed" });
    const ni: DeliveryChannelAdapter = {
      ...simulatorAdapter,
      markReady: async () => {
        throw new NotImplementedError("ubereats", "markReady");
      },
    };
    expect(await runOutboxAction(ni, row("mark_ready"), ctx())).toMatchObject({ ok: false, retryable: false });
  });

  it("acota el tiempo de preparación y pasa el motivo del rechazo", async () => {
    const accept = vi.fn(async () => ({ ok: true, retryable: false }));
    const reject = vi.fn(async () => ({ ok: true, retryable: false }));
    const a: DeliveryChannelAdapter = { ...simulatorAdapter, accept, reject };
    await runOutboxAction(a, row("accept", { prep_minutes: 999 }), ctx());
    expect(accept).toHaveBeenCalledWith({ external_order_id: "O1", brand: "rappi" }, 180, expect.anything());
    await runOutboxAction(a, row("reject", { reason: "Sin stock" }), ctx());
    expect(reject).toHaveBeenCalledWith({ external_order_id: "O1", brand: "rappi" }, "Sin stock", expect.anything());
  });
});

describe("esqueletos de plataformas", () => {
  it("Rappi: verifica Rappi-Signature y responde el PING", async () => {
    const rappi = getAdapter("rappi")!;
    expect(rappi.ready).toBe(false);
    const raw = JSON.stringify({ event: "PING" });
    const headers = new Headers({ [RAPPI_SIGNATURE_HEADER]: await buildSignatureHeader(SECRET, raw, NOW / 1000) });
    expect(await rappi.verifySignature({ headers, rawBody: raw }, ctx({ provider: "rappi" }))).toBe(true);
    expect(rappi.parseEvent(raw, ctx({ provider: "rappi" })).reply).toEqual({ status: 200, body: { status: "OK" } });
    expect(() => rappi.parseEvent(JSON.stringify({ event: "NEW_ORDER" }), ctx({ provider: "rappi" }))).toThrow(NotImplementedError);
  });

  it("PedidosYa, Uber Eats y MP Delivery rechazan el webhook hasta tener el alta", async () => {
    for (const p of ["pedidosya", "ubereats", "mp_delivery"]) {
      const a = getAdapter(p)!;
      expect(a.ready).toBe(false);
      expect(await a.verifySignature({ headers: new Headers(), rawBody: "{}" }, ctx())).toBe(false);
    }
    expect(getAdapter("nope")).toBeNull();
    expect(getAdapter("simulador")!.ready).toBe(true);
  });
});

describe("sugerencias de mapeo", () => {
  const pos = [
    { id: "a", name: "Milanesa Napolitana", sku: "MILA-1" },
    { id: "b", name: "Papas fritas grandes", sku: null },
    { id: "c", name: "Coca Cola 500", sku: "COCA500" },
    { id: "d", name: "Remera talle", sku: null, has_variants: true },
  ];

  it("SKU, nombre igual y parecido, sin repetir producto", () => {
    const s = suggestMappings(
      pos,
      [
        { external_id: "X1", name: "Coca-Cola 500ml", sku: "coca 500" },
        { external_id: "X2", name: "milanesa napolitana" },
        { external_id: "X3", name: "Papas fritas" },
        { external_id: "X4", name: "Milanesa Napolitana" },
        { external_id: "X5", name: "Remera talle" },
      ],
      new Set(),
    );
    expect(s.find((x) => x.external_id === "X1")).toMatchObject({ product_id: "c", reason: "sku" });
    expect(s.find((x) => x.external_id === "X2")).toMatchObject({ product_id: "a", reason: "nombre" });
    expect(s.find((x) => x.external_id === "X3")).toMatchObject({ product_id: "b", reason: "parecido" });
    expect(s.find((x) => x.external_id === "X4")).toBeUndefined();
    expect(s.find((x) => x.external_id === "X5")).toBeUndefined();
  });

  it("no pisa lo ya mapeado", () => {
    expect(suggestMappings(pos, [{ external_id: "X2", name: "Milanesa Napolitana" }], new Set(["X2"]))).toEqual([]);
    expect(nameSimilarity("", "algo")).toBe(0);
  });

  it("id del simulador igual al del SQL (SIM- + SKU o id corto)", () => {
    expect(simulatorExternalId({ id: "c0000000-0000-4000-8000-000000000001", sku: "mi-la 1" })).toBe("SIM-MILA1");
    expect(simulatorExternalId({ id: "c0000000-0000-4000-8000-000000000001", sku: null })).toBe("SIM-C0000000");
    const sql = fs.readFileSync(
      path.join(process.cwd(), "supabase", "migrations", "20261110200200_canales_delivery_flujo.sql"),
      "utf8",
    );
    expect(sql).toMatch(/'SIM-' \|\| upper\(coalesce\(nullif\(regexp_replace\(coalesce\(p\.sku, ''\), '\[\^A-Za-z0-9\]', '', 'g'\), ''\),\s*left\(replace\(p\.id::text, '-', ''\), 8\)\)\)/);
  });
});

describe("mensajes de error", () => {
  it("traduce los códigos del servidor", () => {
    expect(channelErrorMessage(new Error("feature_not_in_plan: canales_delivery"))).toMatch(/plan/);
    expect(channelErrorMessage(new Error("channel_wrong_store"))).toMatch(/sucursal/);
    expect(channelErrorMessage(new Error("invalid_transition: listo -> aceptado"))).toMatch(/cambió de estado/);
    expect(channelErrorMessage("no_open_shift")).toMatch(/caja/);
  });
});

describe("Migraciones de canales de delivery (estático)", () => {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("202611102"));
  const sql = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");

  it("son cuatro, no recrean create_sale y registran la feature", () => {
    expect(files).toHaveLength(4);
    expect(sql).not.toMatch(/function\s+(public\.)?create_sale\s*\(/i);
    expect(sql).toMatch(/'canales_delivery', 'Canales de delivery \(apps\)'/);
    expect(sql).toMatch(/when 'plataforma'\s+then 'canales_delivery'/);
  });

  it("policies con (select ...) y nunca is_internal()", () => {
    const policies = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBeGreaterThan(5);
    for (const p of policies) {
      expect(p).not.toMatch(/is_internal\(\)/);
      if (/current_tenant_id/.test(p)) expect(p).toMatch(/\(select current_tenant_id\(\)\)/);
    }
  });

  it("tablas sin DEFAULT current_tenant_id() y con role_write_guard", () => {
    expect(sql).not.toMatch(/default current_tenant_id\(\)/i);
    for (const t of [
      "delivery_channel_connections",
      "delivery_channel_orders",
      "delivery_channel_events",
      "delivery_channel_outbox",
      "delivery_channel_product_map",
      "delivery_channel_settlements",
    ]) {
      expect(sql).toMatch(new RegExp(`'${t}', '(manage|operate)'`));
    }
  });

  it("secretos sin policies ni grants; idempotencia por evento y por pedido", () => {
    expect(sql).toMatch(/revoke all on delivery_channel_secrets from public, anon, authenticated/);
    expect(sql).not.toMatch(/create policy \w+ on delivery_channel_secrets/);
    expect(sql).toMatch(/unique \(connection_id, external_event_id\)/);
    expect(sql).toMatch(/delivery_channel_orders \(connection_id, external_order_id\)/);
  });

  it("las funciones SECURITY DEFINER fijan search_path y las internas no se exponen", () => {
    const fns = sql.match(/create or replace function[\s\S]*?\$\$;/gi) ?? [];
    for (const f of fns) if (/security definer/i.test(f)) expect(f).toMatch(/set search_path/i);
    for (const fn of ["_channel_bill", "_channel_cancel", "_channel_order_new", "_channel_void_sale"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\) from public, anon, authenticated`));
    }
    for (const fn of ["delivery_channel_ingest_event", "delivery_channel_outbox_claim", "delivery_channel_webhook_context"]) {
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role;`));
    }
  });

  it("el webhook es público en config.toml y deploy-check", () => {
    const toml = fs.readFileSync(path.join(process.cwd(), "supabase", "config.toml"), "utf8");
    expect(toml).toMatch(/\[functions\.delivery_channel_webhook\]\s*\nverify_jwt = false/);
    const dc = fs.readFileSync(path.join(process.cwd(), "scripts", "deploy-check.mjs"), "utf8");
    expect(dc).toMatch(/"delivery_channel_webhook",/);
    const src = fs.readFileSync(path.join(process.cwd(), "supabase", "functions", "delivery_channel_webhook", "index.ts"), "utf8");
    expect(src).toMatch(/readTextLimited/);
  });

  it("todos los estados de la máquina están en el CHECK de la tabla", () => {
    const check = /external_status in \(([^)]*)\)/.exec(sql)![1]!;
    for (const s of EXTERNAL_STATUSES as ExternalStatus[]) expect(check).toContain(`'${s}'`);
  });
});
