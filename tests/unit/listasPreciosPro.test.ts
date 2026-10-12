import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_INFO, featureRequires } from "@/lib/saas/featureInfo";

// Listas de precios PRO (ADR-058): convenciones de las migraciones y del plan.

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const MIGS = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.startsWith("202610211"))
  .map((f) => `supabase/migrations/${f}`);

describe("feature listas_precios_pro", () => {
  it("OPTIONAL de Business que requiere listas_precios", () => {
    expect(FEATURE_INFO.listas_precios_pro?.minPlan).toBe("Business");
    expect(featureRequires("listas_precios_pro")).toEqual(["listas_precios"]);
    expect(FEATURE_INFO.listas_precios_pro?.needs).toMatch(/modo profesional/);
    const sql = read("supabase/migrations/20261021100000_features_listas_precios_pro.sql");
    expect(sql).toMatch(/'listas_precios_pro'[\s\S]*'catalogo', false/);
    expect(sql).toMatch(/p\.key in \('business', 'enterprise'\)/);
  });
});

describe("migraciones de ADR-058", () => {
  it("son cuatro, desde 20261021100000", () => {
    expect(MIGS.length).toBe(4);
  });

  it("RLS de negocio con internal_scope(), nunca is_internal()", () => {
    for (const f of MIGS) {
      const s = read(f);
      expect(s, f).not.toMatch(/is_internal\(\)/);
      for (const m of s.matchAll(/create policy (\w+)_select on (\w+)\s+for select using \(([^;]*)\);/g)) {
        expect(m[3], m[1]).toMatch(/internal_scope\(\)/);
      }
    }
  });

  it("no recrea create_sale (sigue llamando al resolver por posición)", () => {
    for (const f of MIGS) expect(read(f), f).not.toMatch(/function (public\.)?create_sale\(/);
    const r = read("supabase/migrations/20261021100200_resolver_listas_pro.sql");
    expect(r).toMatch(/drop function if exists _resolve_unit_price\(uuid, uuid, uuid, numeric, uuid, uuid, uuid, timestamptz\)/);
    expect(r).toMatch(/p_term\s+text default null,\s*\n\s*p_pos_list uuid default null/);
  });

  it("lo PRO se gatea en el servidor", () => {
    const m = read("supabase/migrations/20261021100100_listas_precios_pro.sql");
    expect(m).toMatch(/feature_not_in_plan: listas_precios_pro/);
    expect(m).toMatch(/create policy price_list_breaks_insert[\s\S]*price_pro_can_write\(\)/);
    expect(m).toMatch(/create policy payment_terms_insert[\s\S]*price_pro_can_write\(\)/);
    expect(m).toMatch(/'multi_sucursal'/);
    const b = read("supabase/migrations/20261021100300_precios_masivos_etiquetas.sql");
    expect(b).toMatch(/mode = 'index'[\s\S]*price_pro_enabled/);
    expect(b).toMatch(/audit_logs/);
  });

  it("sin rayas largas en los textos nuevos", () => {
    const EM_DASH = String.fromCharCode(0x2014);
    for (const f of [
      ...MIGS,
      "lib/prices/resolve.ts",
      "lib/prices/rounding.ts",
      "lib/prices/bulk.ts",
      "modules/prices/proApi.ts",
      "components/prices/PriceListsCard.tsx",
      "components/prices/BulkUpdateWizard.tsx",
      "components/prices/PriceProPanels.tsx",
      "components/prices/PriceListFormModal.tsx",
      "components/pos/PosPriceContextBar.tsx",
    ]) {
      expect(read(f).includes(EM_DASH), f).toBe(false);
    }
  });
});
