// F20-9 (ADR-128): pantallas de mora. El panel del dueño muestra la deuda, el
// próximo paso y "Voy a pagar el día…"; la ficha interna, las acciones de
// condonar y promesa con vista previa; la configuración, políticas, escalera y
// feriados; la restricción blanda tapa reportes pero nunca el POS.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MoraConfig, MyMora, TenantMora } from "@/modules/billing/mora";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
let pathname = "/reportes";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

const mutation = () => ({ mutateAsync: vi.fn(async () => ({ status: "applied", credit_note_cents: 0 })), isPending: false });
const state: { my?: MyMora; tenant?: TenantMora; config?: MoraConfig; restriction?: unknown } = {};
vi.mock("@/modules/billing/mora", () => ({
  moraErrorMessage: (e: unknown) => String(e),
  useMyMora: () => ({ data: state.my, error: null }),
  useOwnerPromise: () => mutation(),
  useTenantMora: () => ({ data: state.tenant, isLoading: false, error: null }),
  useTenantMoraMutations: () => ({ waive: mutation(), createPromise: mutation(), updatePromise: mutation(), setTerms: mutation(), pause: mutation() }),
  useMoraConfig: () => ({ data: state.config, isLoading: false, error: null }),
  useMoraConfigMutations: () => ({
    setSettings: mutation(), savePolicy: mutation(), archivePolicy: mutation(), assignPlan: mutation(),
    saveLadder: mutation(), archiveLadder: mutation(), saveHoliday: mutation(), deleteHoliday: mutation(), decideWaiver: mutation(),
  }),
  useMyRestriction: () => ({ data: state.restriction }),
}));

import { MoraCard } from "@/components/dashboard-team/MoraCard";
import { TenantMoraPanel } from "@/components/internal/billing/TenantMoraPanel";
import { MoraConfigView } from "@/components/internal/billing/MoraConfig";
import { SoftRestrictionGate } from "@/components/saas/SoftRestrictionGate";

const STEPS = [
  { id: "s1", position: 1, offset_days: 1, action: "past_due" as const, channels: ["email" as const], requires_no_promise: false, min_debt_cents: 0, title: "Pago pendiente", body: "Debés {monto}", is_active: true },
  { id: "s5", position: 2, offset_days: 10, action: "suspend" as const, channels: ["email" as const], requires_no_promise: true, min_debt_cents: 0, title: "Suspendimos", body: "Sólo lectura", is_active: true },
];
const POLICY = { id: "p1", name: "Estándar", monthly_rate_bp: 500, grace_days: 0, method: "daily_prorata" as const, cap_bp: 5000, min_amount_cents: 0, bill_mode: "on_collection" as const };

beforeEach(() => {
  state.my = {
    as_of: "2026-10-14",
    is_owner: true,
    state: "vencida",
    days_overdue: 8,
    oldest_due: "2026-10-06",
    effective_due: "2026-10-06",
    overdue_cents: 5000000,
    balance_cents: 5040000,
    interest_open_cents: 40000,
    interest_pending_cents: 0,
    interest_enabled: true,
    soft_restricted: false,
    restrict_areas: ["reportes", "configuracion"],
    subscription_status: "past_due",
    next_step: { step_id: "s5", action: "suspend", title: "Suspendimos", offset_days: 10, date: "2026-10-16" },
    promise: null,
    promise_rules: { can_create: true, reason: null, max_days: 15, min_date: "2026-10-15", max_date: "2026-10-29" },
    promises: [],
  };
  state.tenant = {
    as_of: "2026-10-14",
    exclusion: null,
    billing_mode: "account",
    debt: { debt_movement_id: "m1", oldest_due: "2026-08-30", effective_due: "2026-08-31", days_overdue: 45, due_cents: 5375000, overdue_cents: 5375000, open_cents: 5375000 },
    status: { state: "vencida", soft_restricted: true, status_by_ladder: "past_due", suspend_on: "2026-10-16", evaluated_at: "2026-10-14T12:00:00Z" },
    subscription_status: "past_due",
    terms: { interest_policy_id: null, interest_enabled: true, dunning_ladder_id: null, self_promise_enabled: null },
    settings: { interest_enabled: true, interest_on_mp: false, dunning_enabled: true, promise_staff_max_days: 30, promise_max_days: 15 },
    policy: POLICY,
    policy_source: "default",
    ladder: { id: "l1", name: "Estándar", steps: STEPS },
    next_step: { step_id: "s5", action: "suspend", title: "Suspendimos", offset_days: 10, date: "2026-10-16" },
    executed_step_ids: ["s1"],
    accruals: [],
    interest_open: [],
    interest_open_cents: 375000,
    promise: null,
    promises: [],
    events: [],
    waivers: [],
    fiscal_pending: [],
    pauses: [],
    holidays: [],
  };
  state.config = {
    as_of: "2026-10-14",
    can_configure: true,
    settings: {
      interest_enabled: false, interest_since: null, interest_on_mp: false, default_interest_policy_id: "p1", dunning_enabled: true,
      default_dunning_ladder_id: "l1", dunning_min_debt_cents: 100, promise_self_enabled: true, promise_max_days: 15,
      promise_staff_max_days: 30, promise_max_broken: 2, soft_restrict_areas: ["reportes", "configuracion"],
    },
    policies: [{ ...POLICY, is_active: true, archived_at: null, tenants: 0 }],
    plans: [{ plan_id: "pl1", key: "pro", name: "Pro", policy_id: null }],
    ladders: [{ id: "l1", name: "Escalera estándar", is_active: true, archived_at: null, updated_at: "2026-10-14", tenants: 0, steps: STEPS }],
    holidays: [{ day: "2026-11-23", name: "Día de la Soberanía Nacional", source: "seed" }],
  };
  state.restriction = { soft_restricted: true, areas: ["reportes"], suspend_on: "2026-10-16", state: "vencida", is_manager: true };
});

describe("MoraCard (panel del dueño)", () => {
  it("muestra la deuda, cuándo se suspende y la promesa", () => {
    render(<MoraCard />);
    expect(screen.getByText("Pagos atrasados")).toBeTruthy();
    expect(screen.getByText(/16\/10\/2026 tu cuenta pasa a sólo lectura/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Voy a pagar el día/ }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeTruthy();
  });
  it("sin deuda ni promesa no muestra nada", () => {
    state.my = { ...state.my!, overdue_cents: 0, days_overdue: 0, next_step: null };
    const { container } = render(<MoraCard />);
    expect(container.textContent).toBe("");
  });
});

describe("TenantMoraPanel (ficha interna)", () => {
  it("condonar la mitad muestra el efecto antes de confirmar", () => {
    render(
      <TenantMoraPanel
        tenantId="t1"
        balanceCents={5375000}
        access={{ role: "cobranzas", can_operate: true, can_set_terms: false, can_configure: false, caps: [] }}
      />,
    );
    expect(screen.getByText("Con restricción parcial")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Condonar punitorios/ }));
    expect(screen.getByText(/pasan a/)).toBeTruthy();
    expect(screen.getByText(/La mitad:/).textContent).toContain("1.875,00");
  });
  it("soporte sin Cobranzas no ve las acciones", () => {
    render(
      <TenantMoraPanel tenantId="t1" balanceCents={1} access={{ role: "viewer", can_operate: false, can_set_terms: false, can_configure: false, caps: [] }} />,
    );
    expect(screen.queryByRole("button", { name: /Condonar punitorios/ })).toBeNull();
  });
});

describe("MoraConfigView", () => {
  it("políticas, escalera con su línea de tiempo y feriados", () => {
    render(<MoraConfigView />);
    expect(screen.getAllByText(/Estándar/).length).toBeGreaterThan(0);
    expect(screen.getByText("Día 10")).toBeTruthy();
    expect(screen.getByText("Día de la Soberanía Nacional")).toBeTruthy();
    // Simulador con el ejemplo de la spec: $ 50.000 a 45 días al 5 %.
    expect(screen.getAllByText(/3\.750,00/).length).toBeGreaterThan(0);
  });
});

describe("SoftRestrictionGate", () => {
  it("tapa reportes con el aviso para regularizar", () => {
    pathname = "/reportes";
    render(<SoftRestrictionGate><p>contenido</p></SoftRestrictionGate>);
    expect(screen.queryByText("contenido")).toBeNull();
    expect(screen.getByText(/limitado por un pago pendiente/)).toBeTruthy();
  });
  it("nunca toca el POS", () => {
    pathname = "/pos";
    render(<SoftRestrictionGate><p>contenido</p></SoftRestrictionGate>);
    expect(screen.getByText("contenido")).toBeTruthy();
  });
});
