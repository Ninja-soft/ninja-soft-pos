import { describe, expect, it } from "vitest";
import { isStatementTimeout, upsertResilient, type UpsertResult } from "@/supabase/functions/_shared/catalogSync";

const ok = (n: number): UpsertResult => ({
  recibidos: n, nuevos: n, actualizados: 0, ofertas: n, ofertas_nuevas: n, ofertas_actualizadas: 0, faltantes: 0,
  por_tienda: { COTO: { nuevas: n } },
});
const timeout = { data: null, error: { message: "canceling statement due to statement timeout" } };
const noSleep = async () => {};

describe("upsertResilient", () => {
  it("detecta el corte por tiempo", () => {
    expect(isStatementTimeout("canceling statement due to statement timeout")).toBe(true);
    expect(isStatementTimeout("duplicate key")).toBe(false);
  });

  it("si un lote grande se corta, lo parte y guarda todo", async () => {
    const calls: number[] = [];
    const r = await upsertResilient(Array.from({ length: 40 }, (_, i) => i), async (chunk) => {
      calls.push(chunk.length);
      return chunk.length > 10 ? timeout : { data: ok(chunk.length), error: null };
    }, { sleep: noSleep });
    expect(r.recibidos).toBe(40);
    expect(r.por_tienda.COTO?.nuevas).toBe(40);
    expect(Math.max(...calls.filter((n) => n <= 10))).toBeLessThanOrEqual(10);
  });

  it("con lote chico reintenta y después falla", async () => {
    let n = 0;
    await expect(upsertResilient([1, 2], async () => { n++; return timeout; }, { sleep: noSleep, retries: 2 }))
      .rejects.toThrow(/upsert: canceling statement/);
    expect(n).toBe(3);
  });

  it("otros errores no se reintentan", async () => {
    let n = 0;
    await expect(upsertResilient([1], async () => { n++; return { data: null, error: { message: "boom" } }; }, { sleep: noSleep }))
      .rejects.toThrow("upsert: boom");
    expect(n).toBe(1);
  });
});
