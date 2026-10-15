import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPendingSignupComplete,
  readPendingSignup,
  toPendingSignupMeta,
} from "@/modules/auth/pendingSignup";
import { aiAddonCopy, AI_ADDON_BENEFITS } from "@/lib/saas/aiAddonCopy";
import { inviteCodeSummary } from "@/lib/saas/inviteCodeSummary";
import { redeemMessage } from "@/modules/auth/invite";
import { activeTenantIdOf, fetchMyMembership } from "@/lib/tenant/myMembership";
import { homePath } from "@/lib/auth/redirect";
import {
  buildActivationChecklist,
  checklistStatusFromSignals,
  newlyCompletedSteps,
  nextPendingStep,
} from "@/lib/onboarding/activationChecklist";
import { getProfile } from "@/lib/profiles/businessProfiles";

// ADR-150: registro que no pierde datos, IA en el paso del plan, códigos que
// respetan todo, membresía del negocio activo y puesta en marcha reordenada.

describe("alta pendiente (confirmación de email)", () => {
  const pending = {
    businessName: "  Asesoría Bromatológica Rosario ",
    industry: "servicios" as const,
    planKey: "pro",
    addonAi: true,
    inviteCode: " ninja2026 ",
    cuit: "20-12345678-6",
    legalName: "Asesoría SRL",
    ivaCondition: "responsable_inscripto" as const,
  };

  it("guarda todo lo cargado y lo vuelve a leer igual", () => {
    const meta = toPendingSignupMeta(pending);
    expect(meta).toMatchObject({
      business_name: "Asesoría Bromatológica Rosario",
      industry: "servicios",
      plan_key: "pro",
      addon_ai: true,
      invite_code: "NINJA2026",
      cuit: "20123456786",
      iva_condition: "responsable_inscripto",
    });
    const back = readPendingSignup(meta);
    expect(back).toMatchObject({
      businessName: "Asesoría Bromatológica Rosario",
      industry: "servicios",
      planKey: "pro",
      addonAi: true,
      inviteCode: "NINJA2026",
      cuit: "20123456786",
    });
    expect(isPendingSignupComplete(back)).toBe(true);
  });

  it("descarta basura y no inventa el rubro", () => {
    expect(readPendingSignup(null)).toBeNull();
    expect(readPendingSignup({ business_name: "x" })).toBeNull();
    const p = readPendingSignup({
      business_name: "Kiosco Juan",
      industry: "inventado",
      iva_condition: "otra",
      cuit: "123",
    });
    expect(p).toMatchObject({
      industry: null,
      ivaCondition: null,
      cuit: null,
      addonAi: false,
    });
    expect(isPendingSignupComplete(p)).toBe(false);
  });

  it("un usuario sin negocio vuelve al registro, no a la pantalla vieja", () => {
    expect(homePath({ isInternal: false, hasTenant: false })).toBe("/signup");
  });
});

describe("Asistente IA en el paso del plan", () => {
  it("con prueba: no se paga ahora ni se carga tarjeta, y se cobra al terminar", () => {
    const c = aiAddonCopy({ planTrialDays: 14 });
    expect(c.billing).toContain("No pagás nada ahora");
    expect(c.billing).toContain("no hace falta cargar tarjeta");
    expect(c.billing).toContain("14 días");
    expect(c.later).toContain("cuando quieras");
  });

  it("sin prueba: se suma al pago del plan", () => {
    expect(aiAddonCopy({ planTrialDays: 0 }).billing).toContain("pago mensual");
  });

  it("copy sin raya larga", () => {
    const all = [
      ...AI_ADDON_BENEFITS,
      ...Object.values(aiAddonCopy({ planTrialDays: 14 })),
    ].join(" ");
    expect(all).not.toContain("—");
  });
});

describe("códigos de invitación (ADR-150)", () => {
  const base = {
    kind: "trial_days" as const,
    trial_days: 60,
    due_days: null,
    discount_percent: null,
    discount_months: null,
    billing_cycle: null,
  };

  it("resume prueba extendida, descuento e IA bonificada", () => {
    expect(
      inviteCodeSummary({
        ...base,
        discount_percent: 20,
        discount_months: 3,
        ai_included: true,
        ai_months: 6,
      }),
    ).toBe(
      "Prueba de 60 días · 20 % de descuento por 3 meses después de la prueba · Asistente IA bonificado por 6 meses",
    );
    expect(
      inviteCodeSummary({ ...base, ai_included: true, ai_months: null }),
    ).toContain("para siempre");
    expect(
      inviteCodeSummary({ ...base, kind: "lifetime", discount_percent: 50 }),
    ).toBe("Vitalicio");
  });

  it("el aviso del canje cuenta todo lo que se aplicó", () => {
    expect(
      redeemMessage({
        kind: "trial_days",
        trial_days: 60,
        ai_included: true,
        ai_months: 1,
      }),
    ).toBe(
      "Código aplicado: tenés 60 días de prueba, Asistente IA bonificado por 1 mes",
    );
    expect(
      redeemMessage({ kind: "account", due_days: 10, discount_percent: 15 }),
    ).toBe(
      "Código aplicado: pagás por cuenta corriente, con 10 días para pagar cada cuota, 15 % de descuento",
    );
  });
});

describe("mi membresía = la del negocio activo", () => {
  function fakeClient(rows: { tenant_id: string; display_name: string }[]) {
    const filters: [string, string][] = [];
    const builder = {
      select: () => builder,
      eq: (col: string, val: string) => {
        filters.push([col, val]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data:
          rows.find((r) =>
            filters.every(([c, v]) => c !== "tenant_id" || r.tenant_id === v),
          ) ?? null,
      }),
    };
    return { client: { from: vi.fn(() => builder) }, filters };
  }

  it("filtra por el negocio del JWT (no devuelve la membresía de otra cuenta)", async () => {
    const { client, filters } = fakeClient([
      { tenant_id: "otro", display_name: "Cuenta vieja" },
      { tenant_id: "activo", display_name: "Pablo Scalise" },
    ]);
    const user = { id: "u1", app_metadata: { current_tenant_id: "activo" } };
    const mem = await fetchMyMembership<{ display_name: string }>(
      client as never,
      user as never,
      "display_name",
    );
    expect(filters).toContainEqual(["tenant_id", "activo"]);
    expect(filters).toContainEqual(["user_id", "u1"]);
    expect(mem?.display_name).toBe("Pablo Scalise");
  });

  it("sin negocio activo no inventa uno", () => {
    expect(activeTenantIdOf({ app_metadata: {} } as never)).toBeNull();
    expect(activeTenantIdOf(null)).toBeNull();
  });

  it("ningún componente lee tenant_users por user_id con limit(1) sin el negocio", () => {
    const files = [
      "components/layout/AppShell.tsx",
      "components/layout/InternalShell.tsx",
      "components/account/MembershipProfileModal.tsx",
      "components/dashboard/OnboardingChecklist.tsx",
      "components/dashboard-team/BrandingCard.tsx",
      "components/dashboard-team/PaymentMethodsCard.tsx",
      "components/dashboard-team/TicketSettingsCard.tsx",
      "modules/saas/accountStatus.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(
        /\.from\("tenant_users"\)\s*\.select\([^)]*\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("status", "active"\)\s*\.limit\(1\)/,
      );
    }
  });
});

describe("puesta en marcha (ADR-150)", () => {
  const steps = buildActivationChecklist({
    profile: getProfile("kiosco"),
    features: { facturacion_afip: true },
  });

  it("Medios de pago es el paso destacado", () => {
    expect(steps.find((s) => s.key === "pagos")?.highlight).toBe(true);
    expect(steps.filter((s) => s.highlight)).toHaveLength(1);
  });

  it("servicios carga servicios y suma la agenda", () => {
    const svc = buildActivationChecklist({
      profile: getProfile("servicios"),
      features: { agenda: true },
    });
    expect(svc.find((s) => s.key === "producto")?.label).toBe(
      "Cargá tus servicios",
    );
    expect(svc.map((s) => s.key)).toContain("agenda");
  });

  it("estado con datos reales y caída sin la migración", () => {
    expect(checklistStatusFromSignals({ mp: true })).toMatchObject({
      pagos: true,
      marca: false,
      email: false,
    });
    expect(
      checklistStatusFromSignals({ mp: true, pagos: false }),
    ).toMatchObject({ pagos: false });
  });

  it("qué sigue y qué se acaba de completar", () => {
    const status = { marca: true, ticket: true };
    expect(nextPendingStep(steps, status)?.key).toBe("email");
    expect(
      newlyCompletedSteps(steps, status, ["marca"]).map((s) => s.key),
    ).toEqual(["ticket"]);
    expect(newlyCompletedSteps(steps, status, ["marca", "ticket"])).toEqual([]);
  });
});

describe("migración 20261218100000_registro_onboarding", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20261218100000_registro_onboarding.sql",
    ),
    "utf8",
  );

  it("el canje aplica la IA bonificada del lado del servidor y lo audita", () => {
    expect(sql).toMatch(/create or replace function redeem_invite_code/);
    expect(sql).toMatch(/v_code\.ai_included/);
    expect(sql).toMatch(/'addon_granted'/);
    expect(sql).toMatch(/granted_until/);
  });

  it("no agrega policies ni usa OR is_internal()", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/or\s+\(?\s*(select\s+)?is_internal\(\)/i);
  });

  it("el vencimiento de bonificaciones no queda expuesto a usuarios", () => {
    expect(sql).toMatch(
      /revoke all on function expire_granted_addons\(\) from public, anon, authenticated/,
    );
  });
});
