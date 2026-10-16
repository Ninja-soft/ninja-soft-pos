// ADR-161 · F22 · H145 (L2): firma en pantalla, "no se pudo entregar" con
// motivo configurable, "entregado" con lo que exige la configuración y el
// remito con copias en ticket de 80 mm.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SignaturePad } from "@/components/logistics/SignaturePad";
import { FailSheet } from "@/components/reparto/FailSheet";
import { DeliverSheet } from "@/components/reparto/DeliverSheet";
import { RemitoPrintSet } from "@/components/remitos/RemitoPrintSet";
import { DEFAULT_LOGISTICS_SETTINGS } from "@/lib/logistics/logic";
import type { Remito } from "@/lib/remitos/logic";
import type { ResolvedInvoiceStyle } from "@/lib/invoices/style";

// jsdom no dibuja: sin contexto 2D la firma igual registra los trazos.
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;

function draw(canvas: HTMLElement) {
  fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
}

describe("SignaturePad", () => {
  it("avisa cuando se firma y cuando se borra", () => {
    const onChange = vi.fn();
    render(<SignaturePad onChange={onChange} />);
    const canvas = screen.getByTestId("signature-canvas");
    expect(canvas).toHaveAttribute("aria-label", "Firma de quien recibe: vacía");
    draw(canvas);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(canvas).toHaveAttribute("aria-label", "Firma de quien recibe: firmada");
    fireEvent.click(screen.getByRole("button", { name: /Borrar/ }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});

describe("FailSheet", () => {
  it("pide el motivo y, si el motivo la pide, la nota", async () => {
    const onConfirm = vi.fn();
    render(<FailSheet open title="Ana · Belgrano 50" settings={DEFAULT_LOGISTICS_SETTINGS} stopPoint={null} onClose={() => undefined} onConfirm={onConfirm} />);
    const save = screen.getByRole("button", { name: "Guardar y seguir" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /^Otro/ }));
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Nota"), { target: { value: "Se mudó" } });
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /No estaba en el domicilio/ }));
    await act(async () => {
      fireEvent.click(save);
    });
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.objectContaining({ key: "no_estaba" }), note: "Se mudó" }));
  });
});

describe("DeliverSheet", () => {
  const origGeo = navigator.geolocation;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  beforeEach(() => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: -34.4201, longitude: -58.5801, accuracy: 8 } } as GeolocationPosition),
      },
    });
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob(["firma"], { type: "image/png" }));
    };
  });
  afterEach(() => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: origGeo });
    HTMLCanvasElement.prototype.toBlob = origToBlob;
  });

  it("con la configuración por defecto exige firma y nombre; toma la ubicación y la distancia", async () => {
    const onConfirm = vi.fn();
    render(
      <DeliverSheet
        open
        title="Ana · Belgrano 50"
        defaultName=""
        stopPoint={{ lat: -34.42, lng: -58.58 }}
        settings={DEFAULT_LOGISTICS_SETTINGS}
        hasRemito={false}
        onClose={() => undefined}
        onConfirm={onConfirm}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Estás a \d+ m de la dirección/)).toBeInTheDocument());
    const ok = screen.getByRole("button", { name: "Confirmar entrega" });
    expect(ok).toBeDisabled();
    expect(screen.getByText("Falta la firma y quién recibe.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Recibió"), { target: { value: "Ana" } });
    draw(screen.getByTestId("signature-canvas"));
    expect(ok).toBeEnabled();
    await act(async () => {
      fireEvent.click(ok);
    });
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ receivedByName: "Ana", farConfirmed: false, position: expect.objectContaining({ lat: -34.4201 }) }),
    );
    expect((onConfirm.mock.calls[0]![0] as { signature: Blob }).signature).toBeInstanceOf(Blob);
  });

  it("lejos de la dirección pide confirmarlo", async () => {
    render(
      <DeliverSheet
        open
        title="Ana"
        defaultName="Ana"
        stopPoint={{ lat: -34.5, lng: -58.58 }}
        settings={{ ...DEFAULT_LOGISTICS_SETTINGS, require_signature: false }}
        hasRemito
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    const confirmFar = await screen.findByRole("checkbox", { name: /Confirmo que la entrega se hizo acá/ });
    const ok = screen.getByRole("button", { name: "Confirmar entrega" });
    expect(ok).toBeDisabled();
    fireEvent.click(confirmFar);
    expect(ok).toBeEnabled();
    expect(screen.getByText("Foto del remito firmado")).toBeInTheDocument();
  });
});

describe("Remito con copias (ticket de 80 mm)", () => {
  const remito: Remito = {
    id: "r1",
    store_id: "s1",
    pto_vta: 1,
    number: 12,
    kind: "envio",
    status: "emitido",
    dispatch_id: "d1",
    sale_id: "v1",
    issued_at: "2026-10-15T12:00:00Z",
    issuer: { trade_name: "Muebles Ana", cuit: "30712345678", store_name: "Centro" },
    receiver_name: "Beto",
    receiver_doc: null,
    receiver_iva: null,
    receiver_address: null,
    delivery_address: "Mitre 10, Tigre",
    packages: 2,
    weight_kg: null,
    declared_value: 3000,
    show_prices: false,
    carrier_name: null,
    carrier_cuit: null,
    vehicle_plate: "AB 123 CD",
    driver_name: "Rolo",
    cot_number: null,
    cot_jurisdiction: null,
    cot_valid_until: null,
    cot_source: null,
    notes: null,
    legend: null,
    received_name: null,
    received_doc: null,
    received_at: null,
    emailed_to: null,
    emailed_at: null,
    void_reason: null,
    voided_at: null,
    items: [{ id: "i1", product_id: null, variant_id: null, description: "Mesa", sku: null, unit: "un", qty: 2, unit_price: 1500, sort: 1 }],
  };

  it("sale una copia por leyenda con la patente y el chofer de la hoja", () => {
    render(
      <RemitoPrintSet
        remito={remito}
        style={{} as ResolvedInvoiceStyle}
        options={{ copies: 2, labels: ["Original: cliente", "Duplicado: vuelve firmado", "Triplicado"], model: "ticket80" }}
      />,
    );
    expect(screen.getByText("Original: cliente")).toBeInTheDocument();
    expect(screen.getByText("Duplicado: vuelve firmado")).toBeInTheDocument();
    expect(screen.queryByText("Triplicado")).toBeNull();
    expect(screen.getAllByText(/Patente AB 123 CD · Chofer Rolo/)).toHaveLength(2);
    expect(screen.getAllByText("N° 0001-00000012")).toHaveLength(2);
  });
});
