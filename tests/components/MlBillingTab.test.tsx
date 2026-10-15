// ADR-141: bandeja de facturación de Mercado Libre (filtros, lote, detalle con
// la elección del receptor y la letra dentro de la matriz de ARCA, percepción)
// y la configuración en Configuración › Facturación (MlBillingExtension; sin la
// feature: sólo cuándo facturar).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_PLAN_SETTINGS, buildInvoicePlan } from "@/supabase/functions/_shared/mercadolibre/invoicePlan";
import type { InboxRow } from "@/lib/mercadolibre/billing";
import type { MlAccount } from "@/modules/mercadolibre/hooks";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/saas/UpgradeModal", () => ({ UpgradeModal: () => null }));

const RI = "30712345671";
const planOf = (perc: boolean, mismatch = false) =>
  buildInvoicePlan({
    orders: [{
      ml_order_id: "1", status: "paid", total_amount: 12100,
      lines: [{ ml_order_id: "1", ml_item_id: "MLA100001", ml_variation_id: null, title: "Remera negra", seller_sku: null, quantity: 1, unit_price: 12100, iva_rate: 21 }],
      payments: [{ id: "1", status: "approved", transaction_amount: mismatch ? 10000 : 12100, coupon_amount: 0, shipping_cost: 0 }],
    }],
    shipment: { mode: "me2", logistic_type: "drop_off", cost: 0, state: "Buenos Aires" },
    billing: { docType: "cuit", docNumber: RI, name: "EMPRESA SA", ivaCondition: "responsable_inscripto", address: "Av. 1", state: "Buenos Aires" },
    padron: null,
    iibb: [{ jurisdiction: "902", rate: 3, valid_from: "2026-10-01", valid_to: "2026-10-31" }],
    iibb_loaded: [],
    emitter: { iva_condition: "responsable_inscripto", issues_m: false, cf_id_threshold: null, can_perceive: true },
    settings: {
      ...DEFAULT_PLAN_SETTINGS,
      perc_enabled: perc,
      perc_rules: [{ jurisdiction: "902", enabled: true, rate_source: "padron", rate: null, base_pct: 100, min_base: 0, min_amount: 0, conditions: ["responsable_inscripto"], base: "neto", base_exempt: "total", without_padron: false }],
    },
    today: "2026-10-15",
  });

const row = (id: string, over: Partial<InboxRow> = {}): InboxRow => {
  const plan = planOf(false);
  return {
    id, pack_key: `20000000000${id}`, sale_id: `s${id}`, sale_number: Number(id) + 100, status: plan.status, warnings: plan.warnings,
    choice: plan.choice, letter: null, pto_vta: null, concepto: null, pdf_format: null, perception_mode: "charge", last_error: null,
    skip_reason: null, created_at: "2026-10-15T12:00:00Z", emitted_at: null, plan,
    orders: [{ ml_order_id: 1, status: "paid", buyer_nickname: `COMPRADOR${id}`, date_created: "2026-10-15T12:00:00Z", total_amount: 12100, fraud_risk: false, needs_review: null }],
    document: null, documents: [], charge: null, ...over,
  };
};

const percPlan = planOf(true);
const mismatchPlan = planOf(false, true);
let rows: InboxRow[] = [];
let pro = true;
const emit = vi.fn();
const skip = vi.fn();
const choose = vi.fn();
const perceptionLink = vi.fn();
const saveSettings = vi.fn();
const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutate: fn, isPending: false, variables: undefined });

vi.mock("@/modules/mercadolibre/billingHooks", () => ({
  useMlBillingSettings: () => ({
    isLoading: false,
    data: {
      account_id: "acc", invoice_mode: "on_paid", upload_invoice: true, pto_vta: null, concepto: null, pdf_format: "a4",
      upload_credit_notes: false, nc_on_refund: "review", rules: {}, perc_link_days: 3, perc_on_expire: "invoice_b", perc_message: null,
      saved: false, features: { billing: pro, perceptions: true, arca: true, mercado_pago: true },
      emitter: { iva_condition: "responsable_inscripto", issues_m: false }, store_pto_vta: 3,
    },
  }),
  useMlInvoiceInbox: () => ({
    isLoading: false,
    data: { counts: { por_facturar: 2, percepcion: 1, revisar: 1, error: 0, facturadas: 0, omitidas: 0 }, rows },
  }),
  useMlBillingMutations: () => ({
    saveSettings: mut(saveSettings), choose: mut(choose), emit: mut(emit), skip: mut(skip), upload: mut(vi.fn()),
    creditNote: mut(vi.fn()), replan: mut(vi.fn()), perceptionLink: mut(perceptionLink), perceptionMessage: mut(vi.fn()),
    perceptionPaid: mut(vi.fn()), perceptionCancel: mut(vi.fn()),
  }),
}));

import { MlBillingTab } from "@/components/mercadolibre/billing/MlBillingTab";
import { MlBillingExtension } from "@/components/mercadolibre/gestor/config/MlBillingExtension";

const account = { id: "acc", invoice_mode: "on_paid", upload_invoice: true } as unknown as MlAccount;

describe("MlBillingTab", () => {
  beforeEach(() => {
    pro = true;
    emit.mockReset();
    choose.mockReset();
    perceptionLink.mockReset();
    rows = [
      row("1"),
      row("2"),
      row("3", { plan: percPlan, status: "hold_perception", warnings: [] }),
      row("4", { plan: mismatchPlan, status: "needs_review", warnings: mismatchPlan.warnings }),
    ];
  });

  it("filtros con conteos y cada venta con su factura, receptor y avisos", () => {
    render(<MlBillingTab account={account} canManage />);
    const tabs = screen.getByRole("tablist", { name: "Filtrar la bandeja" });
    expect(within(tabs).getByRole("tab", { name: /Por facturar/ }).getAttribute("aria-selected")).toBe("true");
    const list = screen.getByRole("list", { name: "Ventas para facturar" });
    expect(within(list).getAllByText(/Factura A/).length).toBeGreaterThan(0);
    expect(within(list).getAllByText(/EMPRESA SA · CUIT 30712345671/).length).toBe(4);
    expect(within(list).getByText(/Percepción/)).toBeTruthy();
    expect(within(list).getByText("Lo cobrado no cierra con la factura")).toBeTruthy();
  });

  it("factura en lote lo elegido (forzando si hay alguna para revisar)", () => {
    render(<MlBillingTab account={account} canManage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Elegir la venta 200000000001" }));
    fireEvent.click(screen.getByRole("button", { name: /Facturar 1/ }));
    expect(emit).toHaveBeenCalledWith({ planIds: ["1"], force: false }, expect.anything());
    fireEvent.click(screen.getByRole("checkbox", { name: "Elegir la venta 200000000004" }));
    fireEvent.click(screen.getByRole("button", { name: /Facturar 2/ }));
    expect(emit).toHaveBeenLastCalledWith({ planIds: ["1", "4"], force: true }, expect.anything());
  });

  it("detalle: receptor, letra con la matriz de ARCA y guardar la elección", () => {
    render(<MlBillingTab account={account} canManage />);
    fireEvent.click(screen.getByText("Venta #101"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("region", { name: "Qué se factura" })).toBeTruthy();
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("radio", { name: /A consumidor final/ }));
    const sel = within(dialog).getByLabelText("Tipo de factura") as HTMLSelectElement;
    const optA = Array.from(sel.options).find((o) => o.value === "A")!;
    expect(optA.disabled).toBe(true);
    expect(optA.textContent).toMatch(/ARCA no la acepta/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Guardar elección" }));
    expect(choose).toHaveBeenCalledWith(
      { planId: "1", p: { choice: "consumidor_final", letter: null, pto_vta: null, concepto: null, pdf_format: null } },
      expect.anything(),
    );
  });

  it("percepción: detalle por jurisdicción y link de pago con mensaje", () => {
    render(<MlBillingTab account={account} canManage />);
    fireEvent.click(screen.getByText("Venta #103"));
    const dialog = screen.getByRole("dialog");
    const sec = within(dialog).getByRole("region", { name: "Percepción de Ingresos Brutos" });
    expect(within(sec).getByText(/Buenos Aires · 3 %/)).toBeTruthy();
    fireEvent.click(within(sec).getByRole("button", { name: /Crear link de pago/ }));
    expect(perceptionLink).toHaveBeenCalledWith({ planId: "3", sendMessage: true }, expect.anything());
    expect(within(dialog).queryByRole("button", { name: /^Facturar A$/ })).toBeNull();
  });

  it("la bandeja no repite la configuración: lleva a Configuración › Facturación", () => {
    const onConfigure = vi.fn();
    render(<MlBillingTab account={account} canManage onConfigure={onConfigure} />);
    expect(screen.queryByLabelText("Cuándo facturar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Configurar facturación/ }));
    expect(onConfigure).toHaveBeenCalled();
  });

  it("sin la feature, la bandeja invita a mejorar el plan y lleva a la configuración", () => {
    pro = false;
    const onConfigure = vi.fn();
    render(<MlBillingTab account={account} canManage onConfigure={onConfigure} />);
    expect(screen.getByText("Facturación de Mercado Libre con reglas")).toBeTruthy();
    expect(screen.queryByLabelText("Cuándo facturar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Configurar facturación/ }));
    expect(onConfigure).toHaveBeenCalled();
  });

  it("Configuración › Facturación sin la feature: invita a mejorar el plan y deja elegir sólo cuándo facturar", () => {
    pro = false;
    render(<MlBillingExtension account={account} canManage />);
    expect(screen.getByText("Facturación de Mercado Libre con reglas")).toBeTruthy();
    const mode = screen.getByRole("radiogroup", { name: "Cuándo facturar" });
    expect((within(mode).getByRole("radio", { name: /Al entregarse/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("2. Qué factura sale")).toBeNull();
    expect(screen.queryByLabelText("Vista previa de la factura")).toBeNull();
    fireEvent.click(within(mode).getByRole("radio", { name: /A mano, por lote/ }));
    fireEvent.click(screen.getByRole("button", { name: /Guardar facturación/ }));
    expect(saveSettings).toHaveBeenCalledWith({ accountId: "acc", p: { invoice_mode: "manual", upload_invoice: true } }, expect.anything());
  });
});
