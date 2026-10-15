// F20-10 (H136 · ADR-131): el simulador de cambio de plan muestra la cotización
// de la base tal cual: upgrade con la diferencia que vence con el próximo cobro,
// downgrade programado al fin del período y pase a anual con crédito y saldo a
// favor. La bandeja de conciliación muestra la acción de cada diferencia.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ProrationQuote } from "@/modules/billing/planChange";
import type { ReconOverview } from "@/modules/billing/reconcile";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

const recon: { data?: ReconOverview } = {};
const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
vi.mock("@/modules/billing/reconcile", () => ({
  reconErrorMessage: (e: unknown) => String(e),
  useReconOverview: () => ({ data: recon.data, isLoading: false, error: null }),
  useReconResolve: () => mutation(),
  useReconSettings: () => mutation(),
  useRunReconcile: () => mutation(),
}));

import { QuoteSummary } from "@/components/internal/billing/PlanChangeDialog";
import { ReconInbox } from "@/components/internal/billing/ReconInbox";

const base: ProrationQuote = {
  kind: "upgrade",
  timing: "immediate",
  effect: "charge",
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  today: "2026-10-11",
  days: 30,
  days_left: 20,
  percent_bp: 0,
  from: { plan_id: "p1", plan_name: "Start", cycle: "monthly", cycle_cents: 6000000 },
  to: { plan_id: "p2", plan_name: "Pro", cycle: "monthly", cycle_cents: 9000000 },
  debit_cents: 6000000,
  credit_cents: 4000000,
  charge: {
    kind: "proration",
    description: "Diferencia por pasar a Plan Pro (20 de 30 días)",
    period_start: "2026-10-11",
    period_end: "2026-10-31",
    due_date: "2026-10-31",
    lines: [
      { source: "proration_debit", description: "Plan Pro · 20 días", amount_cents: 6000000 },
      { source: "proration_credit", description: "Crédito Plan Start · 20 días", amount_cents: -4000000 },
    ],
    total_cents: 2000000,
  },
  charge_cents: 2000000,
  bonus_cents: 0,
  new_period: null,
  effective_on: "2026-10-11",
  charged: true,
  notes: ["La diferencia se suma al próximo cobro: vence el 31/10/2026."],
  warnings: [],
};

describe("QuoteSummary", () => {
  it("upgrade: líneas de débito y crédito, se carga la diferencia con su vencimiento", () => {
    render(<QuoteSummary quote={base} />);
    expect(screen.getByText("Upgrade")).toBeTruthy();
    expect(screen.getByText("Plan Pro · 20 días")).toBeTruthy();
    expect(screen.getByText("Crédito Plan Start · 20 días")).toBeTruthy();
    expect(screen.getByText("20 de 30")).toBeTruthy();
    expect(screen.getByTestId("quote-charge").textContent).toMatch(/20\.000/);
    expect(screen.getByText(/Vence el/)).toBeTruthy();
  });

  it("downgrade programado: sin líneas, sin cargo ni crédito y con la fecha", () => {
    render(
      <QuoteSummary
        quote={{
          ...base,
          kind: "downgrade",
          timing: "period_end",
          effect: "scheduled",
          from: base.to,
          to: base.from,
          charge: null,
          charge_cents: 0,
          debit_cents: 0,
          credit_cents: 0,
          effective_on: "2026-10-31",
          notes: ["El cambio rige al fin del período, el 31/10/2026, sin crédito ni débito."],
        }}
      />,
    );
    expect(screen.getByText("Downgrade")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/Queda programado para el/)).toBeTruthy();
    expect(screen.getByTestId("quote-charge").textContent).toMatch(/0/);
  });

  it("pase a anual: período nuevo, crédito aplicado y saldo a favor", () => {
    render(
      <QuoteSummary
        quote={{
          ...base,
          kind: "cycle_up",
          effect: "charge_and_credit",
          to: { plan_id: "p1", plan_name: "Start", cycle: "yearly", cycle_cents: 60000000 },
          percent_bp: 1000,
          charge: {
            kind: "subscription_period",
            description: "Suscripción Plan Start anual",
            period_start: "2026-10-11",
            period_end: "2027-10-11",
            due_date: "2026-10-11",
            lines: [
              { source: "plan", description: "Plan Start · anual", amount_cents: 60000000 },
              { source: "proration_credit", description: "Crédito Plan Start mensual · 20 días sin usar", amount_cents: -3600000 },
            ],
            total_cents: 56400000,
          },
          charge_cents: 56400000,
          bonus_cents: 150000,
          new_period: { start: "2026-10-11", end: "2027-10-11" },
          warnings: ["Con débito automático, cambiar el ciclo necesita un débito nuevo."],
        }}
      />,
    );
    expect(screen.getByText("Pasa a anual")).toBeTruthy();
    expect(screen.getByText(/Período nuevo/)).toBeTruthy();
    expect(screen.getByText(/10 %/)).toBeTruthy();
    expect(screen.getByTestId("quote-bonus").textContent).toMatch(/1\.500/);
    expect(screen.getByText(/débito nuevo/)).toBeTruthy();
  });
});

describe("ReconInbox", () => {
  it("sin credenciales avisa y muestra las acciones de cada diferencia", () => {
    recon.data = {
      credentials: false,
      settings: { window_hours: 72, tolerance_cents: 100 },
      can_manage: true,
      can_configure: false,
      runs: [
        {
          id: "r1", source: "cron", status: "degraded", window_from: "2026-10-11T00:00:00Z", window_to: "2026-10-14T00:00:00Z",
          mp_count: 0, local_count: 3, matched: 0, diffs_new: 1, diffs_closed: 0, fees_updated: 0,
          message: "Sin credenciales de Mercado Pago", started_at: "2026-10-14T07:00:00Z", finished_at: "2026-10-14T07:00:05Z", started_by_name: null,
        },
      ],
      counts: { duplicate: 1 },
      diffs: [
        {
          id: "d1", kind: "duplicate", severity: "medium", status: "open", diff_key: "duplicate:x", tenant_id: "t1", tenant_name: "Kiosco A",
          payment_id: "p1", mp_payment_id: null, expected_cents: 5000000, actual_cents: 5000000, detail: {}, excluded: null,
          resolution: null, resolve_reason: null, resolved_at: null, resolved_by_name: null,
          created_at: "2026-10-14T07:00:05Z", updated_at: "2026-10-14T07:00:05Z",
          payment: { status: "approved", amount_cents: 5000000, paid_at: "2026-10-13T12:00:00Z", method: "transfer", external_id: null },
          mp: null,
        },
      ],
      tenants: [{ id: "t1", name: "Kiosco A" }],
    };
    render(<ReconInbox access={null} />);
    expect(screen.getByText(/No hay credenciales de Mercado Pago/)).toBeTruthy();
    expect(screen.getAllByText("Degradada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Kiosco A").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Dejar a cuenta" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Registrar reintegro" }).length).toBeGreaterThan(0);
  });
});
