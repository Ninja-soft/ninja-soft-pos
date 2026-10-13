import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import rawProfiles from "@/lib/profiles/business-profiles.json";
import {
  BUSINESS_PROFILES,
  FLAG_INFO,
  PAYMENT_LABELS,
  PROFILE_KEYS,
  getProfile,
  profileForVertical,
  type BusinessProfile,
} from "@/lib/profiles/businessProfiles";
import { PLAN_FEATURE_LABELS, buildProfilePreview, type ProfileContext } from "@/lib/profiles/preview";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";
import { VERTICALS } from "@/lib/verticals/config";

const root = join(__dirname, "..", "..");
const MIG = readFileSync(join(root, "supabase/migrations/20261102200000_perfiles_rubro.sql"), "utf8");

function seedFromMigration(): unknown {
  const m = MIG.match(/\$profiles\$\s*([\s\S]*?)\s*\$profiles\$/);
  if (!m) throw new Error("no seed");
  return JSON.parse(m[1]!);
}

const profile = (k: string): BusinessProfile => getProfile(k)!;

function ctx(over: Partial<ProfileContext> = {}): ProfileContext {
  return {
    currentProfile: null,
    currentVertical: "otro",
    flags: {},
    posLayout: {},
    categories: [],
    features: { balanza: true, efectivo: true, transferencia: true },
    ...over,
  };
}

describe("perfiles por rubro: datos", () => {
  it("son los 11 rubros pedidos, en orden, con rubro base válido", () => {
    expect(BUSINESS_PROFILES.map((p) => p.key)).toEqual([...PROFILE_KEYS]);
    for (const p of BUSINESS_PROFILES) {
      expect((VERTICALS as readonly string[]).includes(p.vertical), p.key).toBe(true);
      expect(p.version).toBeGreaterThanOrEqual(1);
      expect(p.categories.length, p.key).toBeGreaterThan(0);
    }
  });

  it("la semilla de la migración es idéntica al JSON (datos versionados)", () => {
    expect(seedFromMigration()).toEqual(rawProfiles);
  });

  it("toda feature o medio sugerido tiene copy y plan mínimo", () => {
    for (const p of BUSINESS_PROFILES) {
      for (const f of p.planFeatures) {
        expect(FEATURE_INFO[f], `${p.key}:${f}`).toBeDefined();
        expect(PLAN_FEATURE_LABELS[f], `${p.key}:${f}`).toBeDefined();
      }
      for (const m of p.payments) {
        expect(PAYMENT_LABELS[m], `${p.key}:${m}`).toBeDefined();
        expect(FEATURE_INFO[m], `${p.key}:${m}`).toBeDefined();
      }
    }
    for (const info of Object.values(FLAG_INFO)) {
      if (info.feature) expect(FEATURE_INFO[info.feature]).toBeDefined();
    }
  });

  it("presets clave de cada rubro", () => {
    expect(profile("gastronomia").flags).toEqual(expect.arrayContaining(["dining_enabled", "delivery_enabled"]));
    expect(profile("gastronomia").posPreset).toBe("salon");
    expect(profile("verduleria").flags).toEqual(expect.arrayContaining(["scale_enabled", "plu_enabled"]));
    expect(profile("verduleria").units[0]).toBe("kg");
    // Variantes es feature de plan: el perfil textil la SUGIERE, no es un flag.
    expect(profile("textil").planFeatures).toContain("variantes");
    expect(profile("textil").posPreset).toBe("boutique");
    expect(profile("servicios").planFeatures).toContain("agenda");
    expect(profile("otro").flags).toEqual([]);
  });

  it("perfil sugerido según el rubro del registro", () => {
    expect(profileForVertical("restaurante")).toBe("gastronomia");
    expect(profileForVertical("heladeria")).toBe("cafeteria");
    expect(profileForVertical("peluqueria")).toBe("servicios");
    expect(profileForVertical("textil")).toBe("textil");
    expect(profileForVertical(null)).toBe("otro");
  });

  it("sin rayas largas en textos", () => {
    expect(JSON.stringify(rawProfiles)).not.toContain("—");
    expect(MIG).not.toContain("—");
  });
});

describe("perfiles por rubro: migración", () => {
  it("RPC SECURITY DEFINER que exige dueño, audita y no otorga features", () => {
    expect(MIG).toMatch(/create or replace function apply_business_profile\(/);
    expect(MIG).toMatch(/security definer\s*\nset search_path = public, pg_temp/);
    expect(MIG).toMatch(/and role = 'owner'/);
    expect(MIG).toMatch(/insert into audit_logs[\s\S]*'business_profile_applied'/);
    expect(MIG).toMatch(/tenant_has_feature_for\(v_tenant, 'balanza'\)/);
    expect(MIG).toMatch(/revoke execute on function apply_business_profile\(text, boolean\) from public, anon/);
    // No toca planes ni addons ni feature flags del negocio.
    expect(MIG).not.toMatch(/update (plans|subscriptions|subscription_addons|tenant_feature_flags)/);
  });

  it("sólo prende flags (nunca los pasa a false) y no borra", () => {
    expect(MIG).toMatch(/dining_enabled\s+= dining_enabled\s+or/);
    expect(MIG).not.toMatch(/_enabled\s*=\s*false/);
    expect(MIG).not.toMatch(/\bdelete from\b/i);
    expect(MIG).not.toMatch(/set deleted_at/);
  });

  it("RLS por negocio con internal_scope(), nunca is_internal()", () => {
    expect(MIG).toMatch(/tenant_id = current_tenant_id\(\) or internal_scope\(\)/);
    expect(MIG).not.toMatch(/or is_internal\(\)/);
    expect(MIG).toMatch(/alter table tenant_business_profiles enable row level security/);
    expect(MIG).toMatch(/alter table business_profiles enable row level security/);
    expect(MIG).toMatch(/revoke insert, update, delete on tenant_business_profiles from anon, authenticated/);
  });
});

describe("vista previa (diff)", () => {
  it("negocio nuevo + kiosco: prende venta libre, crea categorías y cambia el rubro", () => {
    const p = buildProfilePreview(profile("kiosco"), ctx());
    expect(p.flags).toEqual([expect.objectContaining({ key: "allow_free_sale", status: "activate" })]);
    expect(p.layout.status).toBe("same"); // mostrador es el diseño de fábrica
    expect(p.categories.create).toEqual(profile("kiosco").categories);
    expect(p.industry).toEqual({ from: "otro", to: "kiosco", changes: true });
    expect(p.changeCount).toBe(1 + profile("kiosco").categories.length + 1);
  });

  it("lo que ya está prendido queda igual y no cuenta como cambio", () => {
    const p = buildProfilePreview(
      profile("almacen"),
      ctx({ flags: { allow_free_sale: true }, currentVertical: "kiosco", categories: profile("almacen").categories }),
    );
    expect(p.flags.find((f) => f.key === "allow_free_sale")?.status).toBe("already_on");
    expect(p.categories.create).toEqual([]);
    expect(p.industry.changes).toBe(false);
    expect(p.changeCount).toBe(2); // scale + plu
  });

  it("balanza sin la feature: bloqueada con su plan, no se activa", () => {
    const p = buildProfilePreview(profile("verduleria"), ctx({ features: {} }));
    const scale = p.flags.find((f) => f.key === "scale_enabled");
    expect(scale?.status).toBe("locked");
    expect(scale?.minPlan).toBe(FEATURE_INFO.balanza!.minPlan);
    expect(p.flags.find((f) => f.key === "plu_enabled")?.status).toBe("activate");
  });

  it("cambiar a un rubro sin mesas NO apaga mesas ni delivery", () => {
    const p = buildProfilePreview(
      profile("textil"),
      ctx({ currentProfile: "gastronomia", flags: { dining_enabled: true, delivery_enabled: true } }),
    );
    expect(p.keptOn).toEqual(["dining_enabled", "delivery_enabled"]);
    expect(p.flags).toEqual([]);
  });

  it("diseño del POS: respeta uno personalizado y Salón sólo con mesas", () => {
    expect(buildProfilePreview(profile("textil"), ctx({ posLayout: { density: "compact" } })).layout.status).toBe(
      "keep_custom",
    );
    expect(buildProfilePreview(profile("textil"), ctx()).layout.status).toBe("apply");
    expect(buildProfilePreview(profile("gastronomia"), ctx()).layout).toEqual({ status: "apply", preset: "salon" });
    expect(buildProfilePreview(profile("verduleria"), ctx({ posLayout: null })).layout.status).toBe("apply");
  });

  it("categorías: sin distinguir mayúsculas y opcionales", () => {
    const p = buildProfilePreview(profile("cafeteria"), ctx({ categories: ["  café ", "BEBIDAS FRÍAS"] }));
    expect(p.categories.existing).toEqual(["Café", "Bebidas frías"]);
    expect(p.categories.create).toEqual(["Pastelería", "Sándwiches"]);
    const off = buildProfilePreview(profile("cafeteria"), ctx({ categories: [] }), { createCategories: false });
    expect(off.categories.create).toEqual([]);
    expect(off.changeCount).toBe(1 + 1); // venta libre + rubro
  });

  it("features de plan y medios: se informan con su plan, nunca se activan", () => {
    const p = buildProfilePreview(profile("textil"), ctx({ features: { variantes: false, efectivo: true } }));
    expect(p.planFeatures).toEqual([
      { key: "variantes", label: PLAN_FEATURE_LABELS.variantes, included: false, minPlan: "Pro" },
    ]);
    expect(p.payments.find((m) => m.key === "efectivo")?.included).toBe(true);
    expect(p.payments.find((m) => m.key === "mercadopago_point")?.included).toBe(false);
    const withPlan = buildProfilePreview(profile("textil"), ctx({ features: { variantes: true } }));
    expect(withPlan.planFeatures[0]!.included).toBe(true);
  });

  it("mismo perfil: se marca y sólo completa lo que falta", () => {
    const p = buildProfilePreview(
      profile("otro"),
      ctx({ currentProfile: "otro", currentVertical: "otro", categories: ["General"] }),
    );
    expect(p.sameProfile).toBe(true);
    expect(p.changeCount).toBe(0);
  });
});
