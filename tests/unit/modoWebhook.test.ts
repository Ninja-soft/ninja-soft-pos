// SEC-63: webhook de MODO (modo_webhook) con una base en memoria y la API de
// MODO falsa. El handler vive en supabase/functions/_shared/modoWebhookHandler.ts;
// la Edge sólo arma las dependencias reales. Regla: sólo se aplica el estado que
// devuelve la re-consulta a MODO; si la re-consulta falla, 503 sin escribir.
import { describe, expect, it } from "vitest";
import {
  handleModoWebhook,
  mapModoStatus,
  type ModoWebhookDb,
  type ModoWebhookDeps,
  type ModoWebhookQuery,
  type ModoDbResult,
} from "@/supabase/functions/_shared/modoWebhookHandler";
import type { WebhookCtx } from "@/supabase/functions/_shared/webhookLog";

const TENANT = "11111111-2222-4333-8444-555555555555";
const INTENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_INTENT = "99999999-8888-4777-8666-555555555555";
const MODO_ID = "modo-pi-123";
const TOKEN_URL = "https://modo.test/merchants/v2/auth/token";
const INTENT_URL = "https://modo.test/merchants/v2/payment-intentions";

// ---------------------------------------------------------------------------
// Base en memoria (subconjunto del query builder de supabase-js).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Write = { table: string; values: Row; affected: number };

function createFakeDb(rows: Row[]) {
  const writes: Write[] = [];
  const db: ModoWebhookDb = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let update: Row | null = null;
      const run = (): ModoDbResult => {
        const matched = (table === "mp_payment_intents" ? rows : []).filter((r) => filters.every((f) => f(r)));
        if (update) {
          for (const r of matched) Object.assign(r, update);
          writes.push({ table, values: update, affected: matched.length });
          return { data: null, error: null };
        }
        return { data: matched, error: null };
      };
      const q: ModoWebhookQuery = {
        select: () => q,
        update(values) {
          update = values;
          return q;
        },
        eq(column, value) {
          filters.push((r) => r[column] === value);
          return q;
        },
        neq(column, value) {
          filters.push((r) => r[column] !== value);
          return q;
        },
        maybeSingle() {
          const res = run();
          const list = res.data as Row[];
          return Promise.resolve({ data: list[0] ?? null, error: null });
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(run()).then(onFulfilled, onRejected);
        },
      };
      return q;
    },
  };
  return { db, writes, rows };
}

function fakeWh() {
  const state = { tenant: null as string | null, ref: null as string | number | null, done: false, failures: [] as unknown[] };
  const wh: WebhookCtx = {
    tenant(id) {
      if (id) state.tenant = id;
    },
    ref(id) {
      if (id != null && id !== "") state.ref = id;
    },
    done() {
      state.done = true;
    },
    fail(err) {
      state.failures.push(err ?? "error");
    },
    note() {},
    defer() {},
  };
  return { wh, state };
}

/** API de MODO falsa: token OK y la intención con `view`, o falla según `mode`. */
type ModoMode =
  | { kind: "ok"; view: Row }
  | { kind: "network" }
  | { kind: "http"; status: number }
  | { kind: "token_http"; status: number }
  | { kind: "hang" };

function fakeModo(mode: ModoMode) {
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch: ModoWebhookDeps["fetch"] = (url, init) => {
    calls.push(url);
    if (mode.kind === "network") return Promise.reject(new TypeError("fetch failed"));
    if (mode.kind === "hang")
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    if (url === TOKEN_URL) {
      if (mode.kind === "token_http") return Promise.resolve(json(mode.status, { error: "x" }));
      return Promise.resolve(json(200, { access_token: "tok" }));
    }
    if (url === `${INTENT_URL}/${encodeURIComponent(MODO_ID)}`) {
      if (mode.kind === "http") return Promise.resolve(json(mode.status, { error: "x" }));
      if (mode.kind === "ok") return Promise.resolve(json(200, { data: mode.view }));
    }
    return Promise.resolve(json(404, {}));
  };
  return { fetch, calls };
}

function intentRow(extra: Row = {}): Row {
  return {
    id: INTENT,
    tenant_id: TENANT,
    provider_key: "modo",
    amount: 1500,
    status: "pending",
    preference_id: MODO_ID,
    mp_payment_id: null,
    ...extra,
  };
}

function setup(opts: { rows?: Row[]; modo: ModoMode; secrets?: Row | null; timeoutMs?: number }) {
  const fake = createFakeDb(opts.rows ?? [intentRow()]);
  const modo = fakeModo(opts.modo);
  const logs: string[] = [];
  const deps: ModoWebhookDeps = {
    db: () => fake.db,
    loadSecret: async () =>
      (opts.secrets === undefined ? { client_id: "cid", client_secret: "csec" } : opts.secrets) as never,
    fetch: modo.fetch,
    tokenUrl: TOKEN_URL,
    intentUrl: INTENT_URL,
    log: { error: (m) => logs.push(m) },
    timeoutMs: opts.timeoutMs,
  };
  return { ...fake, modo, deps, logs };
}

function delivery(body: unknown, intent = INTENT): Request {
  return new Request(`https://example.supabase.co/functions/v1/modo_webhook?intent=${intent}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const notice = (status: string, extra: Row = {}) => ({
  status,
  payment_id: "pay-1",
  external_intention_id: INTENT,
  ...extra,
});

describe("modo_webhook · re-consulta OK", () => {
  it("MODO confirma approved con el monto esperado → acredita", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "approved", amount: 1500, external_intention_id: INTENT } } });
    const { wh, state } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("approved")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toEqual([
      { table: "mp_payment_intents", values: { status: "approved", mp_payment_id: "pay-1" }, affected: 1 },
    ]);
    expect(t.rows[0]?.status).toBe("approved");
    expect(state.done).toBe(true);
    expect(state.tenant).toBe(TENANT);
    expect(t.modo.calls).toEqual([TOKEN_URL, `${INTENT_URL}/${MODO_ID}`]);
  });

  it("MODO dice rejected → rechaza (aunque el cuerpo diga approved)", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "rejected", amount: 1500 } } });
    const { wh } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("approved")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.rows[0]?.status).toBe("rejected");
    expect(t.writes).toHaveLength(1);
  });

  it("el estado aplicado es el de MODO, no el del cuerpo (cuerpo cancelled, MODO pending)", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "pending" } } });
    const { wh } = fakeWh();
    await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(t.rows[0]?.status).toBe("pending");
  });

  it("approved de MODO con monto distinto → no acredita ni escribe", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "approved", amount: 15 } } });
    const { wh, state } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("approved")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toHaveLength(0);
    expect(state.failures).toContain("amount_mismatch");
  });

  it("respuesta de MODO sin estado legible → no completa con el cuerpo", async () => {
    const t = setup({ modo: { kind: "ok", view: { amount: 1500 } } });
    const { wh, state } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toHaveLength(0);
    expect(state.failures).toContain("reconsult_without_status");
  });
});

describe("modo_webhook · re-consulta imposible (SEC-63)", () => {
  it.each([
    ["red caída", { kind: "network" } as ModoMode],
    ["MODO 500 en la intención", { kind: "http", status: 500 } as ModoMode],
    ["MODO 401 en el token", { kind: "token_http", status: 401 } as ModoMode],
  ])("%s + cuerpo cancelled → 503 sin escribir", async (_name, mode) => {
    const t = setup({ modo: mode });
    const { wh, state } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, retry: true });
    expect(t.writes).toHaveLength(0);
    expect(t.rows[0]?.status).toBe("pending");
    expect(state.failures).toHaveLength(1);
    expect(state.done).toBe(false);
  });

  it("MODO no responde (timeout) + cuerpo expired → 503 sin escribir", async () => {
    const t = setup({ modo: { kind: "hang" }, timeoutMs: 20 });
    const { wh } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("expired")), wh, t.deps);
    expect(res.status).toBe(503);
    expect(t.writes).toHaveLength(0);
  });

  it("sin credenciales del negocio + cuerpo rejected → 200 sin escribir (reintentar no lo arregla)", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "rejected" } }, secrets: null });
    const { wh, state } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("rejected")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toHaveLength(0);
    expect(t.modo.calls).toHaveLength(0);
    expect(state.failures).toHaveLength(1);
  });
});

describe("modo_webhook · intent ajeno", () => {
  it("external_intention_id de otro intent → no consulta ni escribe", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "approved", amount: 1500 } } });
    const { wh } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("cancelled", { external_intention_id: OTHER_INTENT })), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toHaveLength(0);
    expect(t.modo.calls).toHaveLength(0);
  });

  it("sin external_intention_id → no escribe", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "cancelled" } } });
    const { wh } = fakeWh();
    await handleModoWebhook(delivery({ status: "cancelled" }), wh, t.deps);
    expect(t.writes).toHaveLength(0);
  });

  it("intent de otro proveedor → no escribe", async () => {
    const t = setup({ rows: [intentRow({ provider_key: "mobbex" })], modo: { kind: "ok", view: { status: "cancelled" } } });
    const { wh } = fakeWh();
    const res = await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(res.status).toBe(200);
    expect(t.writes).toHaveLength(0);
  });

  it("MODO devuelve otra referencia → no escribe", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "cancelled", external_intention_id: OTHER_INTENT } } });
    const { wh, state } = fakeWh();
    await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(t.writes).toHaveLength(0);
    expect(state.failures).toContain("reference_mismatch");
  });
});

describe("modo_webhook · reentrega", () => {
  it("la segunda entrega del mismo approved no escribe (idempotente)", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "approved", amount: 1500 } } });
    const first = fakeWh();
    expect((await handleModoWebhook(delivery(notice("approved")), first.wh, t.deps)).status).toBe(200);
    const second = fakeWh();
    expect((await handleModoWebhook(delivery(notice("approved")), second.wh, t.deps)).status).toBe(200);
    expect(t.writes).toHaveLength(1);
    expect(t.rows[0]?.status).toBe("approved");
    expect(t.modo.calls).toHaveLength(2); // sólo la primera consultó a MODO
  });

  it("un intent ya approved no pasa a otro estado aunque MODO diga cancelled", async () => {
    const t = setup({ rows: [intentRow({ status: "approved" })], modo: { kind: "ok", view: { status: "cancelled" } } });
    const { wh } = fakeWh();
    await handleModoWebhook(delivery(notice("cancelled")), wh, t.deps);
    expect(t.writes).toHaveLength(0);
    expect(t.rows[0]?.status).toBe("approved");
  });

  it("la escritura filtra .neq('status','approved') (carrera entre dos entregas)", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "rejected" } } });
    // Otra entrega acreditó entre la lectura y la escritura.
    const orig = t.deps.fetch;
    t.deps.fetch = async (url, init) => {
      const r = await orig(url, init);
      if (url.startsWith(INTENT_URL) && t.rows[0]) t.rows[0].status = "approved";
      return r;
    };
    const { wh } = fakeWh();
    await handleModoWebhook(delivery(notice("rejected")), wh, t.deps);
    expect(t.writes).toEqual([
      { table: "mp_payment_intents", values: { status: "rejected", mp_payment_id: "pay-1" }, affected: 0 },
    ]);
    expect(t.rows[0]?.status).toBe("approved");
  });
});

describe("modo_webhook · entrada", () => {
  it("GET o sin ?intent → 200 sin tocar la base", async () => {
    const t = setup({ modo: { kind: "ok", view: { status: "approved", amount: 1500 } } });
    const { wh } = fakeWh();
    const get = new Request(`https://example.supabase.co/functions/v1/modo_webhook?intent=${INTENT}`);
    expect((await handleModoWebhook(get, wh, t.deps)).status).toBe(200);
    const noIntent = new Request("https://example.supabase.co/functions/v1/modo_webhook", {
      method: "POST",
      body: JSON.stringify(notice("approved")),
    });
    expect((await handleModoWebhook(noIntent, wh, t.deps)).status).toBe(200);
    expect(t.writes).toHaveLength(0);
  });

  it("mapModoStatus", () => {
    expect(mapModoStatus("Accredited")).toBe("approved");
    expect(mapModoStatus("declined")).toBe("rejected");
    expect(mapModoStatus("expirado")).toBe("expired");
    expect(mapModoStatus("canceled")).toBe("cancelled");
    expect(mapModoStatus("processing")).toBe("pending");
  });
});
