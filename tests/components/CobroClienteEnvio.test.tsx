// ADR-146: cliente y entrega dentro de la hoja de cobro. Elegir o crear el
// cliente recalcula la letra en vivo; elegir envío o retiro arma el plan de
// pos_sale_create_fulfilled (el mismo del reparto de ADR-136).
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { CheckoutCustomerFiscal } from "@/modules/customers/checkoutFiscal";
import type { FulfillmentLine, FulfillmentSource, PlanPayload } from "@/lib/stock/fulfillment";

const FISCAL: Record<string, CheckoutCustomerFiscal> = {
  cf: { id: "cf", iva_condition: "consumidor_final", document_type: "dni", document_number: "30111222", address: null },
  ri: {
    id: "ri",
    iva_condition: "responsable_inscripto",
    document_type: "cuit",
    document_number: "30712345671",
    address: "Av. Siempreviva 742, Rosario",
    fiscal_verification: "padron",
  },
  riSinCuit: { id: "riSinCuit", iva_condition: "responsable_inscripto", document_type: "dni", document_number: "30111222" },
};

vi.mock("@/modules/customers/checkoutFiscal", () => ({
  useCheckoutCustomerFiscal: (id: string | null) => ({ data: id ? (FISCAL[id] ?? null) : undefined }),
}));
vi.mock("@/modules/saas/gating", () => ({ useFeature: () => true }));
vi.mock("@/modules/tax/hooks", () => ({
  useTaxSettings: () => ({ data: { iva_condition: "responsable_inscripto", issues_cbte_m: false } }),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/modules/padron/api", () => ({
  padronApi: { setLetterOverride: vi.fn(), clearLetterOverride: vi.fn(() => Promise.resolve()) },
}));

import { CheckoutCustomerBlock } from "@/components/pos/checkout/CheckoutCustomerBlock";
import { CheckoutLetter, type CheckoutLetterState } from "@/components/pos/checkout/CheckoutLetter";
import { CheckoutDeliveryBlock, type DeliveryApply } from "@/components/pos/checkout/CheckoutDeliveryBlock";

// La hoja real: el bloque Cliente con la letra (CheckoutLetter) adentro.
function CustomerHarness({ initial, onNew }: { initial: { id: string; name: string } | null; onNew?: () => void }) {
  const [customer, setCustomer] = useState(initial);
  const [letterState, setLetterState] = useState<CheckoutLetterState | null>(null);
  return (
    <>
      <CheckoutCustomerBlock
        open
        customer={customer}
        letterState={letterState}
        onPick={() => setCustomer({ id: "ri", name: "Ferretería Sur SA" })}
        onNew={() => {
          onNew?.();
          // Como el alta rápida: crea y deja el cliente en la venta.
          setCustomer({ id: "ri", name: "Ferretería Sur SA" });
        }}
        onClear={() => setCustomer(null)}
        letter={<CheckoutLetter open customerId={customer?.id ?? null} embedded onState={setLetterState} />}
      />
    </>
  );
}

const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("Bloque Cliente", () => {
  it("consumidor final muestra Factura B cerrado y la letra pasa a A al elegir un responsable inscripto", () => {
    render(<CustomerHarness initial={null} />);
    expect(header("Cliente").textContent).toBe("ClienteConsumidor finalFactura B");
    fireEvent.click(header("Cliente"));
    expect(screen.getByText(/factura a nombre de una empresa/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Elegir cliente/ }));
    expect(header("Cliente").textContent).toBe("ClienteFerretería Sur SA · Resp. inscriptoFactura A");
    expect(screen.getByText(/CUIT 30-71234567-1/)).toBeTruthy();
    expect(screen.getByText("Verificado en ARCA")).toBeTruthy();
  });

  it("crear el cliente desde la hoja recalcula la letra y Quitar vuelve a consumidor final", () => {
    const onNew = vi.fn();
    render(<CustomerHarness initial={null} onNew={onNew} />);
    fireEvent.click(header("Cliente"));
    fireEvent.click(screen.getByRole("button", { name: /Nuevo cliente/ }));
    expect(onNew).toHaveBeenCalled();
    expect(header("Cliente").textContent).toContain("Factura A");
    fireEvent.click(screen.getByRole("button", { name: /Quitar/ }));
    expect(header("Cliente").textContent).toBe("ClienteConsumidor finalFactura B");
  });

  it("factura A sin CUIT: avisa, abre el bloque y ofrece cargarlo", () => {
    render(<CustomerHarness initial={{ id: "riSinCuit", name: "Juan Gómez" }} />);
    expect(header("Cliente").textContent).toContain("Juan Gómez · Falta el CUIT");
    expect(screen.getByText("La Factura A necesita el CUIT del cliente.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Cargar el CUIT en la ficha/ }).getAttribute("href")).toBe("/clientes/riSinCuit");
  });
});

describe("Bloque Entrega", () => {
  const lines: FulfillmentLine[] = [
    { key: "p1|", productId: "p1", variantId: null, name: "Campera", quantity: 2, localOnly: false },
    { key: "p2|", productId: "p2", variantId: null, name: "Gorro", quantity: 1, localOnly: false },
  ];
  const sources: FulfillmentSource[] = [
    { product_id: "p1", variant_id: null, store_id: "A", store_name: "Centro", warehouse_id: null, warehouse_name: "Salón de ventas", kind: "principal", own_store: true, sale_priority: 0, available: 5 },
    { product_id: "p2", variant_id: null, store_id: "A", store_name: "Centro", warehouse_id: null, warehouse_name: "Salón de ventas", kind: "principal", own_store: true, sale_priority: 0, available: 5 },
    { product_id: "p1", variant_id: null, store_id: "B", store_name: "Norte", warehouse_id: "wb", warehouse_name: "Salón", kind: "principal", own_store: false, sale_priority: 0, available: 4 },
    { product_id: "p2", variant_id: null, store_id: "B", store_name: "Norte", warehouse_id: "wb", warehouse_name: "Salón", kind: "principal", own_store: false, sale_priority: 0, available: 1 },
    { product_id: "p1", variant_id: null, store_id: "C", store_name: "Oeste", warehouse_id: "wc", warehouse_name: "Salón", kind: "principal", own_store: false, sale_priority: 0, available: 1 },
  ];
  const stores = [
    { id: "A", name: "Centro" },
    { id: "B", name: "Norte" },
    { id: "C", name: "Oeste" },
  ];
  const rules = { storeId: "A", retiroEnabled: true, envioEnabled: true, retiroCrossBranch: false };

  // Controlado como en el POS: lo que devuelve onApply vuelve como choice.
  function DeliveryHarness({ onApply, customerId = "ri", locks = { retiro: null, envio: null } }: {
    onApply: (r: DeliveryApply) => void;
    customerId?: string | null;
    locks?: { retiro: string | null; envio: string | null };
  }) {
    const [last, setLast] = useState<DeliveryApply | null>(null);
    return (
      <CheckoutDeliveryBlock
        open
        lines={lines}
        sources={sources}
        sourcesLoading={false}
        rules={rules}
        stores={stores}
        locks={locks}
        choice={last?.choice ?? null}
        summary={null}
        error={last?.error ?? null}
        customerId={customerId}
        customerName={customerId ? "Ferretería Sur SA" : null}
        onNeedSources={vi.fn()}
        onApply={(r) => {
          setLast(r);
          onApply(r);
        }}
        onSplit={vi.fn()}
      />
    );
  }

  let applied: DeliveryApply[];
  beforeEach(() => {
    applied = [];
  });
  const lastPlan = (): PlanPayload | null => applied.at(-1)?.plan ?? null;

  it("cerrado dice Se lo lleva ahora", () => {
    render(<DeliveryHarness onApply={(r) => applied.push(r)} />);
    expect(header("Entrega").textContent).toContain("Se lo lleva ahora");
    expect(header("Entrega").getAttribute("aria-expanded")).toBe("false");
  });

  it("envío a domicilio: precarga el domicilio del cliente y suma el costo al plan", () => {
    render(<DeliveryHarness onApply={(r) => applied.push(r)} />);
    fireEvent.click(header("Entrega"));
    fireEvent.click(screen.getByRole("radio", { name: /Envío a domicilio/ }));
    expect((screen.getByLabelText("Domicilio de entrega") as HTMLInputElement).value).toBe("Av. Siempreviva 742, Rosario");
    let plan = lastPlan()!;
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0]).toMatchObject({ mode: "envio", ship_address: "Av. Siempreviva 742, Rosario" });
    expect(plan.deliveries[0]!.items.map((i) => [i.product_id, i.qty, i.source_store_id])).toEqual([
      ["p1", 2, "A"],
      ["p2", 1, "A"],
    ]);
    expect(plan.shipping_fee).toBeUndefined();
    fireEvent.change(screen.getByLabelText(/Costo de envío/), { target: { value: "1.500" } });
    plan = lastPlan()!;
    expect(plan.shipping_fee).toBe(1500);
  });

  it("envío sin domicilio no deja cobrar (error en vez de plan)", () => {
    render(<DeliveryHarness onApply={(r) => applied.push(r)} customerId={null} />);
    fireEvent.click(header("Entrega"));
    fireEvent.click(screen.getByRole("radio", { name: /Envío a domicilio/ }));
    expect(applied.at(-1)).toMatchObject({ plan: null, error: "Cargá el domicilio de cada envío." });
    expect(header("Entrega").textContent).toContain("Falta completar la entrega");
    expect(screen.getByRole("status").textContent).toBe("Cargá el domicilio de cada envío.");
  });

  it("retira en otra sucursal: elige la que tiene todo y arma el retiro a nombre del cliente", () => {
    render(<DeliveryHarness onApply={(r) => applied.push(r)} />);
    fireEvent.click(header("Entrega"));
    fireEvent.click(screen.getByRole("radio", { name: /Retira en otra sucursal/ }));
    const select = screen.getByLabelText("Sucursal donde retira") as HTMLSelectElement;
    expect(select.value).toBe("B");
    const oeste = [...select.options].find((o) => o.value === "C")!;
    expect(oeste.disabled).toBe(true);
    expect(oeste.textContent).toContain("falta Campera, Gorro");
    const plan = lastPlan()!;
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0]).toMatchObject({ mode: "retiro", fulfillment_store_id: "B", pickup_name: "Ferretería Sur SA" });
    expect(plan.deliveries[0]!.items.every((i) => i.source_store_id === "B" && i.source_warehouse_id === "wb")).toBe(true);
  });

  it("con el plan sin retiro ni envío muestra el candado y no deja elegirlos", () => {
    render(
      <DeliveryHarness
        onApply={(r) => applied.push(r)}
        locks={{ retiro: "Tu plan no incluye el retiro en sucursal", envio: "Tu plan no incluye el envío a domicilio" }}
      />,
    );
    fireEvent.click(header("Entrega"));
    const envio = screen.getByRole("radio", { name: /Envío a domicilio/ }) as HTMLButtonElement;
    expect(envio.disabled).toBe(true);
    expect(screen.getByText("Tu plan no incluye el envío a domicilio")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Retira en otra sucursal/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /Repartir entrega/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
