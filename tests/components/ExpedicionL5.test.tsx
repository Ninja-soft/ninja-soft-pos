// ADR-165 · F22 · H148 (L5): control por escaneo con lector (Enter) y aviso
// de cruce, resultado por producto con roto y rechazado, y la hoja por
// producto del repartidor (escaneo sin señal, lectura ajena registrada,
// escaneo obligatorio).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const scan = vi.fn();
vi.mock("@/modules/logistics/expedition", async (orig) => {
  const real = await orig<typeof import("@/modules/logistics/expedition")>();
  return { ...real, expeditionApi: { ...real.expeditionApi, scan: (...a: unknown[]) => scan(...a), justify: vi.fn(), reset: vi.fn() } };
});

import { ScanPanel } from "@/components/logistics/expedition/ScanPanel";
import { OutcomeForm } from "@/components/logistics/expedition/OutcomeForm";
import { ItemsSheet } from "@/components/reparto/ItemsSheet";
import { DEFAULT_EXPEDITION_SETTINGS, outcomeLines, type OutcomeLine } from "@/lib/logistics/expedition";
import { DEFAULT_LOGISTICS_SETTINGS } from "@/lib/logistics/logic";
import type { RouteItems } from "@/modules/logistics/expedition";

const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe("ScanPanel", () => {
  beforeEach(() => scan.mockReset());

  it("manda el código del lector al apretar Enter y avisa el cruce", async () => {
    scan.mockResolvedValueOnce({ ok: false, duplicate: false, result: "cruce", item_id: null, other_dispatch_number: 7 });
    const onChanged = vi.fn();
    render(
      <ScanPanel
        stage="armado"
        scope={{ dispatchId: "d1" }}
        mode="obligatorio"
        items={[{ id: "a", name: "Mesa", qty: 2, hasCode: true }]}
        checks={{}}
        onChanged={onChanged}
      />,
    );
    const input = screen.getByLabelText("Código");
    fireEvent.change(input, { target: { value: " 7790004\n" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    await waitFor(() => expect(screen.getByText("No es de esta entrega")).toBeInTheDocument());
    expect(scan).toHaveBeenCalledWith({ dispatchId: "d1" }, "armado", expect.objectContaining({ code: "7790004" }));
    expect(screen.getByText(/entrega N° 7/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText("Obligatorio")).toBeInTheDocument();
  });

  it("muestra el avance, ofrece confirmar a mano un producto sin código y justificar", async () => {
    scan.mockResolvedValueOnce({ ok: true, duplicate: false, result: "manual", item_id: "b", product_name: "Vela", scanned: 1, expected: 1 });
    render(
      <ScanPanel
        stage="armado"
        scope={{ dispatchId: "d1" }}
        mode="opcional"
        items={[
          { id: "a", name: "Mesa", qty: 2, hasCode: true },
          { id: "b", name: "Vela", qty: 1, hasCode: false },
        ]}
        checks={{ a: { scanned: 2 } }}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByText(/1 de 2/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Confirmar a mano/ }));
    });
    expect(scan).toHaveBeenCalledWith({ dispatchId: "d1" }, "armado", expect.objectContaining({ itemId: "b", code: null }));
    fireEvent.click(screen.getByRole("button", { name: "No se puede escanear" }));
    expect(screen.getByLabelText("Motivo")).toBeInTheDocument();
  });
});

describe("OutcomeForm", () => {
  it("marca roto y rechazado sin pasarse de lo que lleva", () => {
    let lines: OutcomeLine[] = outcomeLines([{ id: "s", name: "Silla", qty: 2 }]);
    const onChange = vi.fn((v: OutcomeLine[]) => {
      lines = v;
    });
    const { rerender } = render(<OutcomeForm lines={lines} onChange={onChange} />);
    // Con todo entregado no se puede sumar roto: primero se baja lo entregado.
    expect(screen.getByRole("button", { name: "Roto: uno más" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Entregado: uno menos" }));
    rerender(<OutcomeForm lines={lines} onChange={onChange} />);
    expect(screen.getByText("Sin entregar: 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Roto: uno más" }));
    rerender(<OutcomeForm lines={lines} onChange={onChange} />);
    expect(lines[0]).toMatchObject({ delivered: 1, damaged: 1, rejected: 0 });
    expect(screen.getByRole("button", { name: "Rechazado: uno más" })).toBeDisabled();
  });
});

describe("ItemsSheet (app del repartidor)", () => {
  const origGeo = navigator.geolocation;
  beforeEach(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: -34.42, longitude: -58.58, accuracy: 5 } } as GeolocationPosition) },
    });
  });
  afterEach(() => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: origGeo });
  });

  const items: RouteItems = {
    route_id: "r",
    settings: DEFAULT_EXPEDITION_SETTINGS,
    load_checked_at: null,
    dispatches: [
      {
        dispatch_id: "d1",
        number: 5,
        stop_id: "s1",
        outcome: "pendiente",
        items: [
          { id: "m", product_id: "pm", variant_id: null, name: "Mesa", qty: 1, unit: "un", codes: ["7790001"], load: null, delivery: null },
          { id: "l", product_id: "pl", variant_id: null, name: "Lámpara", qty: 1, unit: "un", codes: ["LAMP"], load: null, delivery: null },
        ],
      },
    ],
  };

  it("con escaneo obligatorio no deja seguir hasta escanear; la lectura ajena queda registrada", async () => {
    const onConfirm = vi.fn();
    render(
      wrap(
        <ItemsSheet
          open
          mode="full"
          title="Ana · Belgrano 50"
          stopId="s1"
          routeItems={items}
          settings={{ ...DEFAULT_EXPEDITION_SETTINGS, scan_on_deliver: "obligatorio" }}
          logistics={DEFAULT_LOGISTICS_SETTINGS}
          stopPoint={{ lat: -34.42, lng: -58.58 }}
          onClose={() => undefined}
          onConfirm={onConfirm}
        />,
      ),
    );
    const next = screen.getByRole("button", { name: "Seguir: quién recibe" });
    expect(next).toBeDisabled();
    expect(screen.getByText(/Falta escanear: Mesa, Lámpara/)).toBeInTheDocument();
    const input = screen.getByLabelText("Código");
    for (const c of ["7790001", "7790009", "lamp"]) {
      fireEvent.change(input, { target: { value: c } });
      fireEvent.submit(input.closest("form")!);
    }
    await waitFor(() => expect(next).toBeEnabled());
    expect(screen.getByText(/1 lectura de productos que no son de esta entrega/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(next);
    });
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        anyDelivered: true,
        complete: true,
        scans: { m: 1, l: 1 },
        foreignCodes: ["7790009"],
        dispatches: [{ dispatch_id: "d1", items: [{ item_id: "m", delivered: 1, damaged: 0, rejected: 0 }, { item_id: "l", delivered: 1, damaged: 0, rejected: 0 }] }],
      }),
    );
  });

  it("todo rechazado: no pide firma y vuelve a Expedición", async () => {
    const onConfirm = vi.fn();
    render(
      wrap(
        <ItemsSheet
          open
          mode="partial"
          title="Ana"
          stopId="s1"
          routeItems={items}
          settings={DEFAULT_EXPEDITION_SETTINGS}
          logistics={DEFAULT_LOGISTICS_SETTINGS}
          stopPoint={null}
          onClose={() => undefined}
          onConfirm={onConfirm}
        />,
      ),
    );
    for (const b of screen.getAllByRole("button", { name: "Entregado: uno menos" })) fireEvent.click(b);
    for (const b of screen.getAllByRole("button", { name: "Rechazado: uno más" })) fireEvent.click(b);
    const save = screen.getByRole("button", { name: "Guardar: vuelve a Expedición" });
    await waitFor(() => expect(save).toBeEnabled());
    await act(async () => {
      fireEvent.click(save);
    });
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ anyDelivered: false, summary: "2 rechazados" }));
  });
});
