// @vitest-environment node
// =============================================================================
// Viumi (ADR-173, migración 20270111100000_viumi): catálogo, feature de plan,
// payment_method_plan_key('viumi') y tope de vencimiento de cobros en espera.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción. Sólo lee: no crea datos ni llama
// a Viumi.
// =============================================================================
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const enabled = Boolean(URL_ && SERVICE);

describe.skipIf(!enabled)("ADR-173 · Viumi: catálogo, plan y gating", () => {
  const admin = () => createClient(URL_!, SERVICE!, { auth: { persistSession: false } });

  it("payment_method_plan_key mapea el medio a su feature", async () => {
    const { data, error } = await admin().rpc("payment_method_plan_key" as never, { p_method: "viumi" } as never);
    expect(error).toBeNull();
    expect(data).toBe("viumi");
  });

  it("proveedor y feature OPTIONAL del grupo pagos", async () => {
    const { data: prov } = await admin().from("payment_providers").select("brand, channel, is_active").eq("key", "viumi").single();
    expect(prov).toMatchObject({ brand: "viumi", channel: "qr_link", is_active: true });
    const { data: feat } = await admin().from("features").select("grupo, is_basic").eq("key", "viumi").single();
    expect(feat).toMatchObject({ grupo: "pagos", is_basic: false });
  });

  // La marca por plan (pro, business, enterprise) se verifica al aplicar la
  // migración en producción: en CI los planes los crea el seed después de las
  // migraciones, sin las claves nuevas.

  it("tope de vencimiento del link", async () => {
    const { data } = await admin().rpc("pending_charge_max_ttl" as never, { p_provider: "viumi" } as never);
    expect(data).toBe(1440);
  });
});
