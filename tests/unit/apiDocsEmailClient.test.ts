// ADR-163: el navegador arma la colección de Postman (con el secreto en
// memoria, si se manda) y el HTML, y llama a la Edge send_api_docs_email.
// Sin credencial y sin la Edge desplegada, cae al envío de links por la cola.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ functions: { invoke }, rpc }) }));

import { apiPublicaApi, utf8ToBase64 } from "@/modules/api-publica/api";

const ID = `nsc_test_${"a".repeat(24)}`;
const SECRET = `nss_test_${"c".repeat(64)}`;
const decode = (b: string) => Buffer.from(b, "base64").toString("utf8");

describe("apiPublicaApi.sendDocsEmail", () => {
  beforeEach(() => {
    invoke.mockReset();
    rpc.mockReset();
  });

  it("manda la colección con las variables y el secreto, y el HTML", async () => {
    invoke.mockResolvedValue({ data: { ok: true, with_secret: true }, error: null });
    const r = await apiPublicaApi.sendDocsEmail({
      email: "dev@x.example",
      note: null,
      client: { client_id: ID, environment: "test" },
      clientSecret: SECRET,
      ackSecret: true,
      includePostman: true,
      includeHtml: true,
    });
    expect(r.with_secret).toBe(true);
    const [fn, { body }] = invoke.mock.calls[0]!;
    expect(fn).toBe("send_api_docs_email");
    const postman = JSON.parse(decode(body.postman)) as { variable: { key: string; value: string }[] };
    const vars = Object.fromEntries(postman.variable.map((v) => [v.key, v.value]));
    expect(vars.client_id).toBe(ID);
    expect(vars.client_secret).toBe(SECRET);
    expect(vars.base_url).toMatch(/\/api\/v1$/);
    expect(decode(body.docs_html)).toMatch(/^<!doctype html>/);
    expect(body).toMatchObject({ client_id: ID, client_secret: SECRET, ack_secret: true });
  });

  it("sin credencial y sin la Edge: manda el link por la cola", async () => {
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsFetchError", message: "Failed to send a request" } });
    rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const r = await apiPublicaApi.sendDocsEmail({
      email: "dev@x.example",
      note: null,
      client: null,
      clientSecret: null,
      ackSecret: false,
      includePostman: true,
      includeHtml: false,
    });
    expect(r.fallback).toBe(true);
    expect(rpc).toHaveBeenCalledWith("api_docs_send_email", { p_recipient: "dev@x.example", p_note: null });
  });

  it("con credencial nunca cae a la cola", async () => {
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsFetchError", message: "x" } });
    await expect(
      apiPublicaApi.sendDocsEmail({
        email: "dev@x.example",
        note: null,
        client: { client_id: ID, environment: "test" },
        clientSecret: null,
        ackSecret: false,
        includePostman: false,
        includeHtml: false,
      }),
    ).rejects.toThrow("edge_not_deployed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("base64 de UTF-8", () => {
    expect(decode(utf8ToBase64("Año ñandú"))).toBe("Año ñandú");
  });
});
