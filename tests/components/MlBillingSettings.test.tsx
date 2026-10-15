// ADR-145: configuración de la facturación de Mercado Libre por pasos, con
// modo simple y avanzado, vista previa de una venta de ejemplo que se
// recalcula, sucursal y depósito por tipo de envío y plantillas de mensajes
// precargadas (con "Restaurar ejemplo").
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MlAccount } from "@/modules/mercadolibre/hooks";
import type { MlBillingSettings } from "@/modules/mercadolibre/billingHooks";
import {
  DEFAULT_INVOICE_MESSAGE,
  DEFAULT_PERCEPTION_MESSAGE,
} from "@/supabase/functions/_shared/mercadolibre/billingConfig";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const saveSettings = vi.fn();
vi.mock("@/modules/mercadolibre/billingHooks", () => ({
  useMlBillingMutations: () => ({ saveSettings: { mutate: saveSettings, isPending: false } }),
}));

import { MlBillingSettingsForm } from "@/components/mercadolibre/billing/MlBillingSettings";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const W2 = "33333333-3333-4333-8333-333333333333";
const account = { id: "acc" } as unknown as MlAccount;
const settings = (over: Partial<MlBillingSettings> = {}): MlBillingSettings => ({
  account_id: "acc", invoice_mode: "on_paid", upload_invoice: true, pto_vta: null, concepto: null, pdf_format: "a4",
  upload_credit_notes: false, nc_on_refund: "review", rules: {}, perc_link_days: 3, perc_on_expire: "invoice_b", perc_message: null,
  invoice_message_enabled: true, invoice_message: null, invoice_notes_enabled: true, invoice_notes: null, logistic_stores: {},
  account_store: { store_id: S1, warehouse_id: null },
  stores: [
    { id: S1, name: "Central", pto_vta: 1, is_default: true, warehouses: [] },
    { id: S2, name: "Norte", pto_vta: 7, is_default: false, warehouses: [{ id: W2, name: "Galpón", kind: "reserva" }] },
  ],
  saved: true, features: { billing: true, perceptions: true, arca: true, mercado_pago: true },
  emitter: { iva_condition: "responsable_inscripto", issues_m: false }, store_pto_vta: 1,
  ...over,
});

describe("MlBillingSettingsForm", () => {
  beforeEach(() => {
    saveSettings.mockReset();
    try {
      window.localStorage.removeItem("ml-billing-advanced");
    } catch {
      /* sin storage en el entorno de tests */
    }
  });

  it("pasos claros y modo simple: lo avanzado aparece con el interruptor", () => {
    render(<MlBillingSettingsForm account={account} settings={settings()} canManage />);
    for (const t of ["1. Cuándo facturar", "2. Qué factura sale", "3. Cupones y envío", "4. Percepciones de Ingresos Brutos", "5. Notas de crédito", "6. Mensajes y leyenda"]) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(screen.queryByLabelText("Concepto")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Configuración avanzada" }));
    expect(screen.getByLabelText("Concepto")).toBeTruthy();
  });

  it("vista previa de la venta de ejemplo que se recalcula con lo elegido", () => {
    render(<MlBillingSettingsForm account={account} settings={settings()} canManage />);
    const preview = screen.getByTestId("invoice-preview");
    expect(within(preview).getByText(/Factura A · PV 00001/)).toBeTruthy();
    expect(within(preview).getByText("Descuento cupón")).toBeTruthy();
    expect(within(preview).getByText("$ 126.875,00")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Cupones" })).getByRole("radio", { name: /Repartido en los precios/ }));
    expect(within(preview).queryByText("Descuento cupón")).toBeNull();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Comprador de la venta de ejemplo" })).getByRole("radio", { name: "Consumidor final" }));
    expect(within(preview).getByText(/Factura B/)).toBeTruthy();
    expect(within(preview).getByText("Venta en Mercado Libre #2000012345678901. Gracias por tu compra.")).toBeTruthy();
  });

  it("sucursal y depósito por tipo de envío: cambia el punto de venta de la vista previa y se guarda", () => {
    render(<MlBillingSettingsForm account={account} settings={settings()} canManage />);
    fireEvent.change(screen.getByLabelText("Sucursal para Mercado Envíos"), { target: { value: S2 } });
    fireEvent.change(screen.getByLabelText("Depósito para Mercado Envíos"), { target: { value: W2 } });
    fireEvent.change(screen.getByLabelText("Sucursal para Full"), { target: { value: S2 } });
    expect(screen.queryByLabelText("Depósito para Full")).toBeNull();
    expect(within(screen.getByTestId("invoice-preview")).getByText(/PV 00007/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Guardar facturación/ }));
    const p = saveSettings.mock.calls[0]![0].p;
    expect(p.logistic_stores).toEqual({ me2: { store_id: S2, warehouse_id: W2 }, full: { store_id: S2, warehouse_id: null } });
  });

  it("plantillas precargadas, activas por defecto, editables y con Restaurar ejemplo", () => {
    render(<MlBillingSettingsForm account={account} settings={settings()} canManage />);
    const perc = screen.getByLabelText("Mensaje de la percepción") as HTMLTextAreaElement;
    expect(perc.value).toBe(DEFAULT_PERCEPTION_MESSAGE);
    expect(screen.getByTestId("preview-perception").textContent).toContain("Hola Martina");
    const msg = screen.getByLabelText("Mensaje al facturar") as HTMLTextAreaElement;
    expect(msg.value).toBe(DEFAULT_INVOICE_MESSAGE);
    expect((screen.getByRole("switch", { name: "Activar: Mensaje al facturar" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("switch", { name: "Activar: Leyenda en la factura" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(msg, { target: { value: "Gracias {comprador}, tu factura {factura} {cualquiera}" } });
    expect(screen.getByTestId("preview-invoice_message").textContent).toBe("Gracias Martina, tu factura A 00004-00000123 {cualquiera}");
    expect(screen.getByText(/No existe \{cualquiera\}/)).toBeTruthy();
    fireEvent.change(perc, { target: { value: "Pagá {monto}" } });
    expect(screen.getByText(/Falta \{link\}/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: "Activar: Leyenda en la factura" }));
    fireEvent.click(screen.getByRole("button", { name: /Guardar facturación/ }));
    let p = saveSettings.mock.calls[0]![0].p;
    expect(p.invoice_message).toBe("Gracias {comprador}, tu factura {factura} {cualquiera}");
    expect(p.invoice_notes_enabled).toBe(false);
    expect(p.invoice_message_enabled).toBe(true);
    expect(p.invoice_notes).toBe("");

    const group = screen.getByRole("group", { name: "Plantilla: Mensaje al facturar" });
    fireEvent.click(within(group).getByRole("button", { name: /Restaurar ejemplo/ }));
    expect((screen.getByLabelText("Mensaje al facturar") as HTMLTextAreaElement).value).toBe(DEFAULT_INVOICE_MESSAGE);
    fireEvent.click(screen.getByRole("button", { name: /Guardar facturación/ }));
    p = saveSettings.mock.calls[1]![0].p;
    // El ejemplo se guarda vacío: sigue al texto de ejemplo vigente.
    expect(p.invoice_message).toBe("");
  });

  it("muestra lo guardado y no nombra a otras empresas", () => {
    const { container } = render(
      <MlBillingSettingsForm
        account={account}
        settings={settings({ invoice_message: "Hola {comprador}", invoice_message_enabled: false, logistic_stores: { me2: { store_id: S2, warehouse_id: W2 } } })}
        canManage
      />,
    );
    expect((screen.getByLabelText("Mensaje al facturar") as HTMLTextAreaElement).value).toBe("Hola {comprador}");
    expect((screen.getByLabelText("Mensaje al facturar") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Sucursal para Mercado Envíos") as HTMLSelectElement).value).toBe(S2);
    expect(container.textContent ?? "").not.toMatch(/andesmar/i);
  });
});
