// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWebhookEvent,
  errorText,
  resolveWebhookStatus,
  withWebhookLog,
} from "@/supabase/functions/_shared/webhookLog";

const TENANT = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("resolveWebhookStatus", () => {
  it("2xx procesado es ok, 2xx sin procesar es ignored", () => {
    expect(resolveWebhookStatus({ httpStatus: 200, processed: true, failed: false })).toBe("ok");
    expect(resolveWebhookStatus({ httpStatus: 200, processed: false, failed: false })).toBe("ignored");
  });
  it("un fallo marcado gana aunque la respuesta sea 200", () => {
    expect(resolveWebhookStatus({ httpStatus: 200, processed: true, failed: true })).toBe("error");
  });
  it("5xx, 401, 403 y excepción (sin status) son error; otros 4xx ignored", () => {
    expect(resolveWebhookStatus({ httpStatus: 503, processed: false, failed: false })).toBe("error");
    expect(resolveWebhookStatus({ httpStatus: 401, processed: false, failed: false })).toBe("error");
    expect(resolveWebhookStatus({ httpStatus: 403, processed: false, failed: false })).toBe("error");
    expect(resolveWebhookStatus({ httpStatus: null, processed: false, failed: false })).toBe("error");
    expect(resolveWebhookStatus({ httpStatus: 405, processed: false, failed: false })).toBe("ignored");
  });
});

describe("errorText", () => {
  it("normaliza, recorta a 500 y tapa tokens", () => {
    expect(errorText(null)).toBeNull();
    expect(errorText(new Error("  boom\n  x "))).toBe("boom x");
    expect(errorText("Authorization: Bearer APP_USR-123.abc falló")).toBe("Authorization: Bearer *** falló");
    expect(errorText("url?access_token=secreto&x=1")).toBe("url?access_token=***&x=1");
    expect(errorText({ code: 7 })).toBe('{"code":7}');
    const long = errorText("x".repeat(900))!;
    expect(long.length).toBe(500);
  });
});

describe("buildWebhookEvent", () => {
  it("arma la fila sin payload y valida tenant y ref", () => {
    const row = buildWebhookEvent({
      provider: "getnet",
      functionName: "getnet_webhook",
      httpStatus: 200,
      processed: true,
      error: null,
      durationMs: 12.6,
      tenantId: TENANT,
      payloadRef: 12345,
    });
    expect(row).toEqual({
      tenant_id: TENANT,
      provider: "getnet",
      function_name: "getnet_webhook",
      status: "ok",
      http_status: 200,
      error: null,
      duration_ms: 13,
      payload_ref: "12345",
    });
  });
  it("tenant inválido queda null, ref se recorta a 200 y un error da status error", () => {
    const row = buildWebhookEvent({
      provider: "mp",
      functionName: "mp_webhook",
      httpStatus: 200,
      processed: true,
      error: "amount_mismatch",
      durationMs: -3,
      tenantId: "no-uuid",
      payloadRef: "r".repeat(300),
    });
    expect(row.tenant_id).toBeNull();
    expect(row.payload_ref).toHaveLength(200);
    expect(row.status).toBe("error");
    expect(row.duration_ms).toBe(0);
  });
});

describe("withWebhookLog", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.Deno;
    delete g.EdgeRuntime;
    vi.restoreAllMocks();
  });

  function setup() {
    g.Deno = {
      env: {
        get: (k: string) =>
          ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k],
      },
    };
    const waits: Promise<unknown>[] = [];
    g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return { waits, fetchMock };
  }

  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>) =>
    JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

  it("no cambia la respuesta e inserta la fila con el resultado", async () => {
    const { waits, fetchMock } = setup();
    const handler = withWebhookLog("modo", "modo_webhook", (_req, wh) => {
      wh.ref("abc");
      wh.tenant(TENANT);
      wh.done();
      return new Response("ok", { status: 200 });
    });
    const res = await handler(new Request("https://f/modo_webhook", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://x.supabase.co/rest/v1/webhook_events");
    expect(bodyOf(fetchMock)).toMatchObject({
      provider: "modo",
      status: "ok",
      tenant_id: TENANT,
      payload_ref: "abc",
      http_status: 200,
    });
  });

  it("si el registro falla, el webhook responde igual", async () => {
    const { waits } = setup();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("red caída");
    }));
    const handler = withWebhookLog("nave", "nave_webhook", () => new Response("ok"));
    const res = await handler(new Request("https://f", { method: "POST" }));
    expect(res.status).toBe(200);
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });

  it("una excepción del handler se registra como error y se vuelve a lanzar", async () => {
    const { waits, fetchMock } = setup();
    const handler = withWebhookLog("payway", "payway_webhook", () => {
      throw new Error("boom");
    });
    await expect(handler(new Request("https://f", { method: "POST" }))).rejects.toThrow("boom");
    await Promise.all(waits);
    expect(bodyOf(fetchMock)).toMatchObject({ status: "error", error: "boom", http_status: null });
  });

  it("espera el trabajo diferido y registra su error", async () => {
    const { waits, fetchMock } = setup();
    const handler = withWebhookLog("mercadopago_orders", "mp_orders_webhook", (_req, wh) => {
      wh.defer(Promise.reject(new Error("order 500")));
      return new Response("ok");
    });
    await handler(new Request("https://f", { method: "POST" }));
    await Promise.all(waits);
    expect(bodyOf(fetchMock)).toMatchObject({ status: "error", error: "order 500" });
  });

  it("no registra las GET (páginas de retorno del navegador)", async () => {
    const { waits, fetchMock } = setup();
    const handler = withWebhookLog("getnet", "getnet_webhook", () => new Response("<h1>Listo</h1>"));
    await handler(new Request("https://f", { method: "GET" }));
    await Promise.all(waits);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
