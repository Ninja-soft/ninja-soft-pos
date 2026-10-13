// @vitest-environment node
// supabase/functions/_shared/requestGuard.ts (F1.5 · ADR-098): tope de cuerpo
// y límite por IP de las Edge Functions públicas.
import { describe, it, expect } from "vitest";
import {
  BodyTooLargeError,
  clientIp,
  createIpLimiter,
  readJsonLimited,
} from "@/supabase/functions/_shared/requestGuard";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://x.supabase.co/functions/v1/mp_webhook", { method: "POST", body, headers, duplex: "half" } as RequestInit);

function chunked(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

describe("readJsonLimited", () => {
  it("parsea un cuerpo chico", async () => {
    await expect(readJsonLimited(post('{"type":"payment","data":{"id":"1"}}'))).resolves.toEqual({
      type: "payment",
      data: { id: "1" },
    });
  });

  it("corta por Content-Length declarado sin leer", async () => {
    await expect(readJsonLimited(post("{}", { "content-length": "999999" }), 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it("corta un cuerpo chunked que supera el tope mientras lo lee", async () => {
    const big = chunked(['{"a":"', "x".repeat(800), "x".repeat(800), '"}']);
    await expect(readJsonLimited(post(big), 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("un cuerpo vacío o no JSON lanza como req.json()", async () => {
    await expect(readJsonLimited(post(null))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readJsonLimited(post("hola"))).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("límite por IP", () => {
  it("toma la primera IP de x-forwarded-for", () => {
    expect(clientIp(post(null, { "x-forwarded-for": "200.1.1.1, 10.0.0.1" }))).toBe("200.1.1.1");
    expect(clientIp(post(null))).toBe("unknown");
  });

  it("ventana fija: corta pasado el límite y se reinicia", () => {
    const l = createIpLimiter(2, 1_000);
    expect([l.hit("a", 0), l.hit("a", 10), l.hit("a", 20)]).toEqual([true, true, false]);
    expect(l.hit("b", 20)).toBe(true);
    expect(l.hit("a", 1_000)).toBe(true);
  });

  it("no crece sin límite de claves", () => {
    const l = createIpLimiter(1, 1_000, 3);
    for (const k of ["a", "b", "c", "d"]) expect(l.hit(k, 0)).toBe(true);
    // Se vació al llenarse: "a" vuelve a entrar.
    expect(l.hit("a", 0)).toBe(true);
  });
});
