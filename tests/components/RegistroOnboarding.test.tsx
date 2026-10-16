import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OnboardingChecklistCard } from "@/components/dashboard/OnboardingChecklist";
import { buildActivationChecklist } from "@/lib/onboarding/activationChecklist";
import { getProfile } from "@/lib/profiles/businessProfiles";

vi.mock("@/modules/saas/signupPlans", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/saas/signupPlans")>();
  return {
    ...actual,
    useSignupPlans: () => ({
      isLoading: false,
      isError: false,
      data: [
        {
          key: "pro",
          name: "Pro",
          secondaryName: null,
          imageUrl: null,
          icon: null,
          monthlyPriceArs: 90000,
          trialDays: 14,
          isRecommended: true,
          sort: 1,
          limits: { modules: {}, limits: {} },
        },
      ],
    }),
  };
});

// Las tarjetas de planes tienen sus propios tests; acá interesa el bloque de IA.
vi.mock("@/components/saas/PlanCards", () => ({ PlanCards: () => null }));

vi.mock("@/modules/saas/aiPublicConfig", () => ({
  useAiPublicConfig: () => ({
    data: {
      image_url: "",
      commercial_text: "",
      addon_price_ars: "15000",
      addon_trial_days: "",
    },
  }),
}));

describe("paso del plan: Asistente IA (ADR-154)", () => {
  it("muestra precio, ventajas, que no se paga ahora y el contacto por cuenta corriente", async () => {
    const { SignupStepPlan } = await import("@/components/auth/SignupStepPlan");
    render(
      <SignupStepPlan
        value="pro"
        onChange={() => {}}
        addonAi={false}
        onAddonAiChange={() => {}}
      />,
    );
    expect(screen.getByText(/\+\$\s?15\.000\/mes/)).toBeTruthy();
    expect(
      screen.getByText(
        /se cobra recién cuando termina tu prueba gratis de 14 días/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/lo activás cuando quieras/i)).toBeTruthy();
    expect(
      screen.getAllByText(/no hace falta cargar tarjeta|sin cargar tarjeta/i)
        .length,
    ).toBeGreaterThan(0);
    const link = screen.getByRole("link", { name: "Escribinos" });
    expect(link.getAttribute("href")).toContain("cuenta%20corriente");
    expect(
      screen.getByRole("switch", { name: "Sumar Asistente IA" }),
    ).toBeTruthy();
  });
});

describe("Puesta en marcha (ADR-154)", () => {
  const steps = buildActivationChecklist({
    profile: getProfile("kiosco"),
    features: {},
  });

  it("arranca por Marca y destaca Medios de pago aunque no sea el siguiente", () => {
    render(
      <OnboardingChecklistCard
        steps={steps}
        status={{}}
        onPostpone={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: /Tu marca/ })).toBeTruthy();
    expect(screen.getByText("El más importante")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Configurar cobros: Medios de pago/ }),
    ).toBeTruthy();
  });

  it("con Marca, Ticket y Email listos, Medios de pago pasa a ser el siguiente", () => {
    render(
      <OnboardingChecklistCard
        steps={steps}
        status={{ marca: true, ticket: true, email: true }}
        onPostpone={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/Siguiente paso · 4 de/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /Medios de pago/ }),
    ).toBeTruthy();
  });
});
