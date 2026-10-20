// @vitest-environment node
// =============================================================================
// Alertas programadas (ADR-176, migración 20270114100000_h162_alertas): forma
// de la RLS, feature y funciones internas.
//
// Corre contra un Supabase LOCAL con las migraciones aplicadas (mismas
// variables que tests/integration/rls.test.ts). Sin ellas la suite se salta.
// NUNCA apuntar estas variables a producción. Sólo lee.
// =============================================================================
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_TEST_URL;
const SERVICE = process.env.SUPABASE_TEST_SERVICE_KEY;
const ANON = process.env.SUPABASE_TEST_ANON_KEY;
const enabled = Boolean(URL_ && SERVICE);

describe.skipIf(!enabled)("ADR-176 · alertas programadas: RLS y funciones", () => {
  const admin = () => createClient(URL_!, SERVICE!, { auth: { persistSession: false } });

  it("feature OPTIONAL del grupo reportes", async () => {
    const { data } = await admin().from("features").select("grupo, is_basic").eq("key", "alertas_programadas").single();
    expect(data).toMatchObject({ grupo: "reportes", is_basic: false });
  });

  // La marca por plan (pro, business, enterprise) se verifica al aplicar la
  // migración en producción: en CI los planes los crea el seed después.

  it("los guardarraíles de RLS siguen en cero", async () => {
    for (const fn of ["rls_internal_scope_leaks", "rls_bare_current_tenant_policies", "rls_policies_without_initplan"]) {
      const { data, error } = await admin().rpc(fn as never);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it("catálogo y próxima corrida", async () => {
    const { data: cat } = await admin().rpc("alert_catalog" as never);
    expect(Object.keys((cat ?? {}) as Record<string, unknown>)).toHaveLength(16);
    // Martes 20/10/2026 10:30 en Argentina -> diaria a las 8 = miércoles 8:00 (11:00 UTC).
    const { data: next } = await admin().rpc("alert_next_run" as never, {
      p_frequency: "daily",
      p_hour: 8,
      p_weekdays: [],
      p_from: "2026-10-20T13:30:00Z",
    } as never);
    expect(new Date(String(next)).toISOString()).toBe("2026-10-21T11:00:00.000Z");
  });

  it.skipIf(!ANON)("sin sesión no se lee ni se evalúa nada", async () => {
    const anon = createClient(URL_!, ANON!, { auth: { persistSession: false } });
    for (const t of ["alert_rules", "alert_events", "alert_seen"]) {
      const { data } = await anon.from(t).select("*").limit(1);
      expect(data ?? []).toEqual([]);
    }
    const { error } = await anon.rpc("alert_evaluate" as never, {
      p_tenant: "00000000-0000-0000-0000-000000000000",
      p_kind: "stock_bajo",
      p_params: {},
      p_store: null,
    } as never);
    expect(error).not.toBeNull();
    const { error: e2 } = await anon.rpc("alert_run_due" as never, { p_limit: 1 } as never);
    expect(e2).not.toBeNull();
  });
});
