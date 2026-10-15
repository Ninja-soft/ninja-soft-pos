// ADR-143: devolución de un cobro de Ualá Bis desde la conciliación de cobros
// QR. Sólo cobros aprobados sin venta vigente; confirma antes de pedirla y
// muestra el estado de la devolución. Sin red: onRefund es un mock.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

import { UalaBisRefundAction } from "@/components/sales/UalaBisRefundAction";

const BASE = {
  id: "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
  provider_key: "ualabis",
  status: "approved",
  amount: 1250.5,
  saleNumber: null as number | null,
  saleStatus: null as string | null,
};

beforeEach(() => toast.mockReset());

describe("UalaBisRefundAction", () => {
  it("cobro aprobado sin venta: confirma y pide la devolución", async () => {
    const onRefund = vi.fn(async () => ({ status: "initiated" }));
    const onDone = vi.fn();
    render(<UalaBisRefundAction intent={BASE} refund={null} onRefund={onRefund} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: /Devolver/ }));
    expect(screen.getAllByText("Devolver el pago de Ualá Bis").length).toBeGreaterThan(0);
    expect(onRefund).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: "Devolver" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(onRefund).toHaveBeenCalledWith(BASE.id));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Devolución pedida a Ualá Bis", variant: "success" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("con venta vigente no ofrece devolver", () => {
    const { container } = render(
      <UalaBisRefundAction intent={{ ...BASE, saleNumber: 12, saleStatus: "completed" }} refund={null} onRefund={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  it("con la venta anulada sí se puede devolver", () => {
    render(
      <UalaBisRefundAction intent={{ ...BASE, saleNumber: 12, saleStatus: "voided" }} refund={null} onRefund={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Devolver/ })).toBeTruthy();
  });

  it("muestra el estado y no repite una devolución viva", () => {
    render(<UalaBisRefundAction intent={BASE} refund={{ status: "initiated" }} onRefund={vi.fn()} />);
    expect(screen.getByText("Devolución en curso")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Devolver/ })).toBeNull();
  });

  it("después de un rechazo deja reintentar y explica el error", async () => {
    const onRefund = vi.fn(async () => ({ error: "sale_active" }));
    render(<UalaBisRefundAction intent={BASE} refund={{ status: "failed" }} onRefund={onRefund} />);
    expect(screen.getByText("No se pudo devolver")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Devolver/ }));
    const buttons = screen.getAllByRole("button", { name: "Devolver" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Este cobro tiene una venta vigente. Anulá la venta primero y después devolvé el pago.",
        variant: "error",
      }),
    );
  });

  it("otros medios no muestran nada", () => {
    const { container } = render(
      <UalaBisRefundAction intent={{ ...BASE, provider_key: "mercadopago" }} refund={null} onRefund={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });
});
