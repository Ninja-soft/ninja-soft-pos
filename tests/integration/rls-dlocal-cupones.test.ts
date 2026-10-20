// @vitest-environment node
// =============================================================================
// dLocal Go y cupones Rapipago / Pago Fácil (ADR-180, migración
// 20270118100000_dlocal_cupones): catálogo, features de plan,
// payment_method_plan_key, topes de cobros en espera, mp_payment_intents.voucher
// y RLS de dlocalgo_refunds.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción. Sólo lee: no crea datos ni llama
// a dLocal Go ni a Mercado Pago.
// =============================================================================
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const enabled = Boolean(URL_ && SERVICE);

describe.skipIf(!enabled)("ADR-180 · dLocal Go y cupones en efectivo", () => {
  const admin = () => createClient(URL_!, SERVICE!, { auth: { persistSession: false } });

  it("payment_method_plan_key mapea los medios a su feature", async () => {
    const a = await admin().rpc("payment_method_plan_key" as never, { p_method: "dlocalgo" } as never);
    expect(a.error).toBeNull();
    expect(a.data).toBe("dlocalgo");
    const b = await admin().rpc("payment_method_plan_key" as never, { p_method: "mp_cupon" } as never);
    expect(b.data).toBe("cupones_efectivo");
    // Lo que ya existía sigue igual.
    const c = await admin().rpc("payment_method_plan_key" as never, { p_method: "talo" } as never);
    expect(c.data).toBe("talo");
  });

  it("proveedor y features OPTIONAL del grupo pagos", async () => {
    const { data: prov } = await admin().from("payment_providers").select("brand, channel, is_active").eq("key", "dlocalgo").single();
    expect(prov).toMatchObject({ brand: "dlocalgo", channel: "qr_link", is_active: true });
    const { data: feats } = await admin()
      .from("features")
      .select("key, grupo, is_basic")
      .in("key", ["dlocalgo", "cupones_efectivo"]);
    expect(feats).toHaveLength(2);
    for (const f of feats ?? []) expect(f).toMatchObject({ grupo: "pagos", is_basic: false });
  });

  // La marca por plan (pro, business, enterprise) se verifica al aplicar la
  // migración en producción: en CI los planes los crea el seed después de las
  // migraciones, sin las claves nuevas.

  it("topes de vencimiento de los cobros en espera", async () => {
    const d = await admin().rpc("pending_charge_max_ttl" as never, { p_provider: "dlocalgo" } as never);
    expect(d.data).toBe(1440);
    const m = await admin().rpc("pending_charge_max_ttl" as never, { p_provider: "mp_cupon" } as never);
    expect(m.data).toBe(4320);
    const t = await admin().rpc("pending_charge_max_ttl" as never, { p_provider: "talo" } as never);
    expect(t.data).toBe(4320);
  });

  it("mp_payment_intents.voucher existe", async () => {
    const { error } = await admin().from("mp_payment_intents").select("voucher").limit(1);
    expect(error).toBeNull();
  });

  it.skipIf(!ANON)("dlocalgo_refunds: anon no lee nada", async () => {
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    const { data } = await anon.from("dlocalgo_refunds" as never).select("id").limit(1);
    expect(data ?? []).toEqual([]);
  });
});
