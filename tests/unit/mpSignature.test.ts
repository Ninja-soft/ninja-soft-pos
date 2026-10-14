import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMpManifest,
  parseMpSignature,
  signMpWebhook,
  verifyMpSignature,
} from "@/supabase/functions/_shared/mpSignature";

const SECRET = "clave-secreta-de-prueba";
const NOW = 1_760_000_000_000; // ms
const TS = String(Math.floor(NOW / 1000));

describe("firma x-signature de Mercado Pago", () => {
  it("arma el manifest de la doc y omite lo que no vino", () => {
    expect(buildMpManifest("ABC123", "req-1", TS)).toBe(`id:abc123;request-id:req-1;ts:${TS};`);
    expect(buildMpManifest("", "req-1", TS)).toBe(`request-id:req-1;ts:${TS};`);
    expect(buildMpManifest("123", null, TS)).toBe(`id:123;ts:${TS};`);
  });

  it("coincide con un HMAC calculado aparte (node:crypto)", async () => {
    const header = await signMpWebhook(SECRET, "123456", "req-xyz", TS);
    const expected = createHmac("sha256", SECRET).update(`id:123456;request-id:req-xyz;ts:${TS};`).digest("hex");
    expect(parseMpSignature(header)).toEqual({ ts: TS, v1: expected });
  });

  it("acepta una firma válida", async () => {
    const signature = await signMpWebhook(SECRET, "123456", "req-xyz", TS);
    await expect(
      verifyMpSignature({ secret: SECRET, signature, requestId: "req-xyz", dataId: "123456", nowMs: NOW }),
    ).resolves.toBe("valid");
  });

  it("rechaza firma de otra clave, otro recurso o manipulada", async () => {
    const signature = await signMpWebhook("otra-clave", "123456", "req-xyz", TS);
    await expect(
      verifyMpSignature({ secret: SECRET, signature, requestId: "req-xyz", dataId: "123456", nowMs: NOW }),
    ).resolves.toBe("invalid");
    const good = await signMpWebhook(SECRET, "123456", "req-xyz", TS);
    await expect(
      verifyMpSignature({ secret: SECRET, signature: good, requestId: "req-xyz", dataId: "999", nowMs: NOW }),
    ).resolves.toBe("invalid");
    await expect(
      verifyMpSignature({ secret: SECRET, signature: "ts=1,v1=zz", requestId: "r", dataId: "1", nowMs: NOW }),
    ).resolves.toBe("invalid");
  });

  it("sin header es 'missing' y una firma vieja es 'expired'", async () => {
    await expect(
      verifyMpSignature({ secret: SECRET, signature: null, requestId: "r", dataId: "1", nowMs: NOW }),
    ).resolves.toBe("missing");
    const oldTs = String(Math.floor(NOW / 1000) - 3600);
    const old = await signMpWebhook(SECRET, "1", "r", oldTs);
    await expect(
      verifyMpSignature({ secret: SECRET, signature: old, requestId: "r", dataId: "1", nowMs: NOW }),
    ).resolves.toBe("expired");
  });

  it("acepta ts en milisegundos", async () => {
    const tsMs = String(NOW);
    const signature = await signMpWebhook(SECRET, "1", "r", tsMs);
    await expect(
      verifyMpSignature({ secret: SECRET, signature, requestId: "r", dataId: "1", nowMs: NOW }),
    ).resolves.toBe("valid");
  });

  it("clave vacía nunca valida", async () => {
    const signature = await signMpWebhook(SECRET, "1", "r", TS);
    await expect(
      verifyMpSignature({ secret: "", signature, requestId: "r", dataId: "1", nowMs: NOW }),
    ).resolves.toBe("invalid");
  });
});
