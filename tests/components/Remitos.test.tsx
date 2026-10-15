// ADR-136: hoja A4 del remito (número, letra R no fiscal, destinatario,
// transporte, COT, ítems, firma de recepción y hojas) y el formulario de
// emisión (validación y payload).
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { resolveInvoiceStyle } from "@/lib/invoices/style";
import { RemitoDocument } from "@/components/remitos/RemitoDocument";
import type { Remito } from "@/lib/remitos/logic";

const issue = vi.fn(async () => ({ id: "r1", pto_vta: 1, number: 3, cot_required: true }));
const toast = vi.fn();
// ADR-149 (A8 y A9): la configuración y la vista previa se pueden cambiar por test.
const remitoState = vi.hoisted(() => ({
  cfg: { cot_threshold: 1000, cot_jurisdiction: "pba", show_prices: false, legend: null } as Record<string, unknown> | undefined,
  preview: null as Record<string, unknown> | null,
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/modules/remitos/api", () => ({
  useRemitoConfig: () => ({ data: remitoState.cfg }),
  useRemitoPreview: () => ({ data: remitoState.preview }),
  useRemitoMutations: () => ({ issue: { mutateAsync: issue, isPending: false } }),
}));

import { RemitoIssueModal } from "@/components/remitos/RemitoIssueModal";

const STYLE = resolveInvoiceStyle({}, { legal_name: "Electro SRL" }, { pro: true, unbranded: true });

const item = (i: number) => ({
  id: `i${i}`,
  product_id: `p${i}`,
  variant_id: null,
  description: `Campera ${i}`,
  sku: `CAM-${i}`,
  unit: "un",
  qty: 2,
  unit_price: 100,
  sort: i,
});

const REMITO: Remito = {
  id: "r1",
  store_id: "s1",
  pto_vta: 1,
  number: 12,
  kind: "envio",
  status: "emitido",
  dispatch_id: "d1",
  sale_id: "v1",
  issued_at: "2026-10-15T15:00:00Z",
  issuer: { legal_name: "Electro SRL", cuit: "30712345678", iva_condition: "responsable_inscripto", store_name: "Norte", store_address: "Calle 2, Tigre" },
  receiver_name: "Ana Pérez",
  receiver_doc: "DNI 30111222",
  receiver_iva: "consumidor_final",
  receiver_address: "Calle Falsa 123",
  delivery_address: "Calle 9 123, La Plata",
  packages: 2,
  weight_kg: 12.5,
  declared_value: 400,
  show_prices: false,
  carrier_name: "Andreani",
  carrier_cuit: "30500000001",
  vehicle_plate: "AB123CD",
  driver_name: "Juan",
  cot_number: "1234567890123456",
  cot_jurisdiction: "pba",
  cot_valid_until: "2026-10-20",
  cot_source: "manual",
  notes: null,
  legend: null,
  received_name: null,
  received_doc: null,
  received_at: null,
  emailed_to: null,
  emailed_at: null,
  void_reason: null,
  voided_at: null,
  items: [item(1), item(2)],
  sale: { number: 340 },
};

describe("RemitoDocument", () => {
  it("dibuja el remito completo en una hoja A4", () => {
    const { container } = render(<RemitoDocument remito={REMITO} style={STYLE} />);
    expect(container.querySelectorAll("[data-invoice-page]")).toHaveLength(1);
    expect(screen.getByText("N° 0001-00000012")).toBeTruthy();
    expect(screen.getByText("Remito de envío")).toBeTruthy();
    expect(screen.getByText("R")).toBeTruthy();
    expect(screen.getByText("No fiscal")).toBeTruthy();
    expect(screen.getByText("Ana Pérez")).toBeTruthy();
    expect(screen.getByText("Andreani")).toBeTruthy();
    expect(screen.getByText("1234567890123456")).toBeTruthy();
    expect(screen.getByText(/ARBA · válido hasta 20\/10\/2026/)).toBeTruthy();
    expect(screen.getByText("Firma de recepción")).toBeTruthy();
    expect(screen.getByText(/Documento no válido como factura/)).toBeTruthy();
    // Sin precios por defecto.
    expect(screen.queryByText("P. unitario")).toBeNull();
  });

  it("con precios, muchos ítems en varias hojas y la marca de anulado", () => {
    const many = { ...REMITO, show_prices: true, status: "anulado" as const, void_reason: "Mal el domicilio", items: Array.from({ length: 50 }, (_, i) => item(i)) };
    const { container } = render(<RemitoDocument remito={many} style={STYLE} />);
    expect(container.querySelectorAll("[data-invoice-page]").length).toBe(3);
    expect(screen.getAllByText("P. unitario").length).toBe(3);
    expect(screen.getAllByText("ANULADO").length).toBe(3);
    expect(screen.getByText("Hoja 1 de 3")).toBeTruthy();
  });
});

describe("RemitoIssueModal", () => {
  it("valida, avisa el COT por umbral y emite con el payload del formulario", async () => {
    const onIssued = vi.fn();
    render(
      <RemitoIssueModal
        source={{ dispatchId: "d1", saleId: "v1", label: "Entrega N° 4 · Venta #340", kind: "envio", receiverName: "Ana", deliveryAddress: null }}
        onClose={vi.fn()}
        onIssued={onIssued}
      />,
    );
    const emit = screen.getByRole("button", { name: "Emitir" }) as HTMLButtonElement;
    expect(emit.disabled).toBe(true);
    expect(screen.getByText("Cargá el domicilio de entrega.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Domicilio de entrega"), { target: { value: "Calle 9 123" } });
    fireEvent.change(screen.getByLabelText("Valor declarado"), { target: { value: "5000" } });
    expect(screen.getByText(/supera tu monto de aviso/)).toBeTruthy();
    expect(emit.disabled).toBe(false);
    fireEvent.click(emit);
    await vi.waitFor(() => expect(onIssued).toHaveBeenCalledWith("r1"));
    const [{ data }] = issue.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({ dispatch_id: "d1", kind: "envio", receiver_name: "Ana", delivery_address: "Calle 9 123", declared_value: 5000, cot_jurisdiction: "pba" });
  });
});

describe("RemitoIssueModal · ADR-149 (L0)", () => {
  const source = { dispatchId: "d2", saleId: "v2", label: "Entrega N° 5 · Venta #341", kind: "entrega" as const, receiverName: "Ana", deliveryAddress: null };

  it("A9: muestra lo que lleva y avisa el COT con el valor del servidor, antes de emitir", () => {
    remitoState.cfg = { cot_threshold: 1000, cot_jurisdiction: "pba", show_prices: false, legend: null };
    remitoState.preview = {
      items: [{ product_id: "p1", variant_id: null, description: "Mesa", sku: null, unit: "un", qty: 2, unit_price: 2500 }],
      declared_value: 5000,
      already: 0,
      sale_status: "completed",
      cot_jurisdiction: "pba",
      cot_threshold: 1000,
      cot_required: true,
    };
    render(<RemitoIssueModal source={source} onClose={vi.fn()} onIssued={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Qué lleva el remito" }).textContent).toContain("Mesa");
    expect(screen.getByText(/El valor de lo que lleva supera tu monto de aviso/)).toBeTruthy();
    remitoState.preview = null;
  });

  it("A13: si todo ya está en otro remito vigente, lo dice y no deja emitir", () => {
    remitoState.preview = {
      items: [],
      declared_value: 0,
      already: 2,
      sale_status: "completed",
      cot_jurisdiction: "pba",
      cot_threshold: null,
      cot_required: false,
    };
    render(<RemitoIssueModal source={source} onClose={vi.fn()} onIssued={vi.fn()} />);
    expect(screen.getByText(/ya está en otro remito vigente/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Emitir" }) as HTMLButtonElement).disabled).toBe(true);
    remitoState.preview = null;
  });

  it("A8: la configuración que llega después de abrir aplica jurisdicción y precios", () => {
    remitoState.cfg = undefined;
    const { rerender } = render(<RemitoIssueModal source={source} onClose={vi.fn()} onIssued={vi.fn()} />);
    expect((screen.getByLabelText("Jurisdicción del COT") as HTMLSelectElement).value).toBe("pba");
    remitoState.cfg = { cot_threshold: null, cot_jurisdiction: "caba", show_prices: true, legend: null };
    rerender(<RemitoIssueModal source={{ ...source }} onClose={vi.fn()} onIssued={vi.fn()} />);
    expect((screen.getByLabelText("Jurisdicción del COT") as HTMLSelectElement).value).toBe("caba");
    expect(screen.getByRole("switch", { name: "Mostrar precios" }).getAttribute("aria-checked")).toBe("true");
    remitoState.cfg = { cot_threshold: 1000, cot_jurisdiction: "pba", show_prices: false, legend: null };
  });
});
