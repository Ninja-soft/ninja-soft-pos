// ADR-142: pantallas de Mercado Libre Full. El paso a paso explica cada etapa,
// el stock muestra Full vs propio con la alerta de quiebre y lo sugerido, y la
// recepción calcula el faltante y no deja cerrar sin decidir qué pasó.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
const receiveMutate = vi.fn();
vi.mock("@/modules/mercadolibre/fullHooks", () => ({
  useMlFullMutations: () => ({
    receive: { mutate: receiveMutate, isPending: false, variables: undefined },
    checkReception: { mutate: vi.fn(), isPending: false },
  }),
}));

import { MlFullGuide } from "@/components/mercadolibre/full/MlFullGuide";
import { MlFullStock, stockLines } from "@/components/mercadolibre/full/MlFullStock";
import { MlFullReceiveModal } from "@/components/mercadolibre/full/MlFullReceiveModal";
import { nextStep } from "@/components/mercadolibre/full/MlFullInbounds";
import type { MlFullInbound, MlFullOverview, MlFullRow } from "@/modules/mercadolibre/fullHooks";

const row = (over: Partial<MlFullRow>): MlFullRow => ({
  id: "r1",
  inventory_id: "LCQI05831",
  ml_item_id: "MLA1",
  ml_variation_id: null,
  title: "Remera",
  variation_label: null,
  item_status: "active",
  product_id: "p1",
  variant_id: null,
  product_name: "Remera",
  sku: "REM",
  barcode: null,
  total: 0,
  available: 0,
  pending_sales: 0,
  not_available: 0,
  damaged: 0,
  lost: 0,
  withdrawal: 0,
  internal_process: 0,
  transfer: 0,
  no_fiscal_coverage: 0,
  not_supported: 0,
  other: 0,
  conditions: [],
  in_transit: 0,
  own_qty: 40,
  sold_30d_ops: null,
  sold_30d_orders: null,
  synced_at: null,
  last_error: null,
  ...over,
});

const overview = (rows: MlFullRow[]): MlFullOverview => ({
  settings: {
    lead_days: 7,
    target_days: 30,
    label_format: "thermal_50x25",
    last_sync_at: null,
    sync_error: null,
    sync_note: null,
    costs_synced_at: null,
    own_store_id: "s1",
    account_status: "active",
  },
  rows,
});

describe("MlFullGuide", () => {
  it("explica que Full no se vende en el mostrador y muestra los 8 pasos", () => {
    render(<MlFullGuide done={{ enable: true }} />);
    expect(screen.getByText(/no se vende en el mostrador/)).toBeTruthy();
    expect(screen.getByText("Creá el envío en Mercado Libre")).toBeTruthy();
    expect(screen.getByText("Conciliá lo que recibió Full")).toBeTruthy();
    expect(screen.getAllByText("Hecho")).toHaveLength(1);
  });
});

describe("MlFullStock", () => {
  it("ordena por urgencia, avisa el quiebre y arma el envío con lo sugerido", () => {
    const onSend = vi.fn();
    const ov = overview([
      row({ id: "ok", title: "Taza", inventory_id: "TAZA00001", product_id: "p2", available: 90, sold_30d_ops: 30 }),
      row({ id: "out", title: "Remera", available: 0, sold_30d_ops: 30, not_available: 2, damaged: 2 }),
    ]);
    expect(stockLines(ov).map((l) => l.row.id)).toEqual(["out", "ok"]);
    render(<MlFullStock overview={ov} onSend={onSend} />);
    expect(screen.getByText("1 producto se queda sin stock en Full")).toBeTruthy();
    expect(screen.getByText("Sin stock en Full")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Armar envío con lo sugerido/ }));
    expect(onSend).toHaveBeenCalledWith([{ product_id: "p1", variant_id: null, qty: 37 }]);
    fireEvent.click(screen.getByRole("button", { name: /Ver por qué no está disponible/ }));
    expect(screen.getByText("Dañado")).toBeTruthy();
  });

  it("sin filas explica cómo empezar", () => {
    render(<MlFullStock overview={overview([])} />);
    expect(screen.getByText("Todavía no hay stock en Full")).toBeTruthy();
  });
});

describe("MlFullReceiveModal", () => {
  const inbound: MlFullInbound = {
    id: "ib1",
    account_id: "acc",
    number: 3,
    store_id: "s1",
    warehouse_id: null,
    status: "in_transit",
    ml_inbound_id: "77001",
    boxes: 1,
    scheduled_for: null,
    notes: null,
    cancel_reason: null,
    ml_checked_at: null,
    label_units_printed: 0,
    label_boxes_printed: 0,
    dispatched_at: "2026-10-10T12:00:00Z",
    received_at: null,
    closed_at: null,
    created_at: "2026-10-09T12:00:00Z",
    stores: { name: "Central" },
    items: [
      {
        id: "it1",
        inventory_id: "LCQI05831",
        inventory_row_id: "r1",
        product_id: "p1",
        variant_id: null,
        title: "Remera",
        qty_sent: 10,
        qty_received: 0,
        qty_damaged: 0,
        qty_missing: 0,
        missing_action: null,
        missing_reason: null,
        ml_received: 8,
        ml_damaged: 1,
      },
    ],
  };

  it("usa lo que informó ML, calcula el faltante y pide decidir antes de cerrar", () => {
    render(<MlFullReceiveModal open onOpenChange={() => {}} inbound={inbound} canClose />);
    fireEvent.click(screen.getByRole("button", { name: /Usar lo que informó ML/ }));
    const close = screen.getByRole("button", { name: /Cerrar con diferencias/ });
    expect((close as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Qué pasó con lo que faltó de Remera/), { target: { value: "returned" } });
    fireEvent.change(screen.getByLabelText(/Motivo del faltante de Remera/), { target: { value: "Quedó en el depósito" } });
    expect((close as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(close);
    expect(receiveMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ib1",
        close: true,
        lines: [{ item_id: "it1", received: 8, damaged: 1, missing_action: "returned", missing_reason: "Quedó en el depósito" }],
      }),
      expect.anything(),
    );
  });

  it("sin permiso de cierre sólo guarda lo contado", () => {
    render(<MlFullReceiveModal open onOpenChange={() => {}} inbound={inbound} canClose={false} />);
    expect(screen.queryByRole("button", { name: /Cerrar con diferencias|Cerrar: recibido/ })).toBeNull();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Guardar lo contado/ })).toBeTruthy();
  });
});

describe("Próximo paso de un envío", () => {
  it("guía según el estado", () => {
    expect(nextStep({ status: "draft", ml_inbound_id: null, label_units_printed: 0 })).toMatch(/Creá el envío en Mercado Libre/);
    expect(nextStep({ status: "draft", ml_inbound_id: "1", label_units_printed: 0 })).toMatch(/Imprimí las etiquetas/);
    expect(nextStep({ status: "in_transit", ml_inbound_id: "1", label_units_printed: 5 })).toMatch(/leé la recepción/);
  });
});
