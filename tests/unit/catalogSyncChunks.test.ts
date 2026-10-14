import { describe, expect, it } from "vitest";
import { mergeUpsertResults, UPSERT_CHUNK, type UpsertResult } from "@/supabase/functions/_shared/catalogSync";

const r = (n: number, tienda: string): UpsertResult => ({
  recibidos: n, nuevos: n, actualizados: 0, ofertas: n, ofertas_nuevas: n, ofertas_actualizadas: 0, faltantes: 0,
  por_tienda: { [tienda]: { nuevas: n } },
});

describe("catalog sync por lotes", () => {
  it("lotes chicos para no pasar el statement_timeout", () => {
    expect(UPSERT_CHUNK).toBeLessThanOrEqual(100);
  });
  it("suma resultados y tiendas de varios lotes", () => {
    const empty: UpsertResult = { recibidos: 0, nuevos: 0, actualizados: 0, ofertas: 0, ofertas_nuevas: 0, ofertas_actualizadas: 0, faltantes: 0, por_tienda: {} };
    const m = [r(50, "COTO"), r(50, "COTO"), r(20, "JUMBO")].reduce(mergeUpsertResults, empty);
    expect(m.recibidos).toBe(120);
    expect(m.por_tienda.COTO?.nuevas).toBe(100);
    expect(m.por_tienda.JUMBO?.nuevas).toBe(20);
  });
});
