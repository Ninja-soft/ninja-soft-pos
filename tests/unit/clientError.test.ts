// Errores del front (F1.5 · ADR-098): mensaje humano, limpieza del reporte y
// endpoint /api/client-error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  __resetReportedErrors,
  buildReport,
  classifyError,
  humanError,
  redact,
  reportClientError,
  safePath,
} from "@/lib/errors/clientError";
import { POST } from "@/app/api/client-error/route";

describe("clasificación y mensaje humano", () => {
  it("chunk viejo después de un deploy = versión nueva", () => {
    const e = Object.assign(new Error("Loading chunk 123 failed."), { name: "ChunkLoadError" });
    expect(classifyError(e)).toBe("update");
    expect(humanError(e).title).toMatch(/versión nueva/);
    expect(classifyError(new TypeError("Failed to fetch dynamically imported module: /x.js"))).toBe("update");
  });

  it("sin red = conexión, y avisa revisar Ventas antes de repetir un cobro", () => {
    const h = humanError(new TypeError("Failed to fetch"));
    expect(h.kind).toBe("network");
    expect(h.description).toMatch(/Ventas/);
  });

  it("cualquier otro = genérico, sin jerga ni em dash", () => {
    const h = humanError(new Error("Cannot read properties of undefined (reading 'x')"));
    expect(h.kind).toBe("unknown");
    expect(`${h.title} ${h.description}`).not.toMatch(/undefined|—/);
  });
});

describe("reporte", () => {
  it("limpia emails, JWT, tokens, CUIT y documentos", () => {
    const out = redact(
      "user ana@x.com token eyJhbGciOi.eyJzdWIiOjF9.abc_DEF sbp_abcdefghijklmnopqrstuv cuit 20-12345678-9 dni 30111222",
    );
    expect(out).toBe("user [email] token [jwt] [token] cuit [cuit] dni [doc]");
  });

  it("el path va sin query (token_hash, intents)", () => {
    expect(safePath("https://pos.soft.ninja/reset-password?token_hash=abc&type=recovery")).toBe("/reset-password");
  });

  it("arma el reporte con topes", () => {
    const e = Object.assign(new Error("x".repeat(900)), { digest: "123abc" });
    const r = buildReport({ error: e, boundary: "panel", href: "https://a.b/pos?x=1", release: "abcdef1234" });
    expect(r).toMatchObject({ boundary: "panel", kind: "unknown", name: "Error", digest: "123abc", path: "/pos" });
    expect(r.message).toHaveLength(500);
    expect(r.stack!.length).toBeLessThanOrEqual(2000);
  });

  describe("envío", () => {
    beforeEach(() => __resetReportedErrors());
    afterEach(() => vi.restoreAllMocks());

    it("manda por sendBeacon una sola vez por error", () => {
      const beacon = vi.fn((..._args: unknown[]) => true);
      Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
      const r = buildReport({ error: new Error("boom"), boundary: "root", href: "http://localhost/x" });
      expect(reportClientError(r)).toBe(true);
      expect(reportClientError(r)).toBe(false);
      expect(beacon).toHaveBeenCalledTimes(1);
      expect(beacon.mock.calls[0]?.[0]).toBe("/api/client-error");
    });

    it("como mucho 5 por carga de página", () => {
      Object.defineProperty(navigator, "sendBeacon", { value: vi.fn(() => true), configurable: true });
      const sent = Array.from({ length: 8 }, (_, i) =>
        reportClientError(buildReport({ error: new Error(`e${i}`), boundary: "root", href: "http://localhost/" })),
      );
      expect(sent.filter(Boolean)).toHaveLength(5);
    });
  });
});

describe("POST /api/client-error", () => {
  const valid = buildReport({ error: new Error("boom ana@x.com"), boundary: "panel", href: "http://localhost/pos" });
  const req = (body: string, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost:3000/api/client-error", {
      method: "POST",
      body,
      headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registra una línea JSON y responde 204", async () => {
    const res = await POST(req(JSON.stringify({ ...valid, message: "boom pepe@x.com" }), { "x-forwarded-for": "1.1.1.1" }));
    expect(res.status).toBe(204);
    const line = JSON.parse(String((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0]?.[0]));
    expect(line).toMatchObject({ event: "client_error", boundary: "panel", path: "/pos", message: "boom [email]" });
  });

  it("rechaza otro origen, cuerpos grandes y esquemas abiertos", async () => {
    expect((await POST(req(JSON.stringify(valid), { origin: "https://evil.example", "x-forwarded-for": "2.2.2.2" }))).status).toBe(403);
    expect((await POST(req("x".repeat(9000), { "x-forwarded-for": "2.2.2.3" }))).status).toBe(413);
    expect((await POST(req(JSON.stringify({ ...valid, extra: 1 }), { "x-forwarded-for": "2.2.2.4" }))).status).toBe(400);
    expect((await POST(req("no json", { "x-forwarded-for": "2.2.2.5" }))).status).toBe(400);
  });

  it("tope por IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      codes.push((await POST(req(JSON.stringify(valid), { "x-forwarded-for": "9.9.9.9" }))).status);
    }
    expect(codes.slice(0, 20).every((c) => c === 204)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });
});
