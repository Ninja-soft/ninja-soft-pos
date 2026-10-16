// ADR-157 · F22 · H144 (L1): AddressAutocomplete (lista flotante, teclado,
// normalización al elegir) y las pestañas Pago / Cliente / Envío de la hoja
// de cobro (el bloque deja su resumen en Pago y su contenido en la pestaña).
import { useEffect, useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Truck } from "lucide-react";
import type { GeoAddress, GeoSuggestion } from "@/lib/geo/address";

const suggest = vi.fn();
const normalize = vi.fn();
vi.mock("@/modules/geo/api", () => ({
  geoApi: {
    suggest: (...a: unknown[]) => suggest(...a),
    normalize: (...a: unknown[]) => normalize(...a),
    reverse: vi.fn(),
  },
}));
// El mini mapa (Leaflet del CDN) no corre en jsdom.
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="mapa" /> }));

import { AddressAutocomplete } from "@/components/geo/AddressAutocomplete";
import { CheckoutFold } from "@/components/pos/checkout/CheckoutFold";
import { CheckoutTabBar, CheckoutTabsProvider, useCheckoutTabsState } from "@/components/pos/checkout/CheckoutTabs";

const SUG: GeoSuggestion[] = [
  {
    id: "a",
    title: "San Martín 1234",
    detail: "Pilar, Buenos Aires",
    address: { street: "San Martín", number: "1234", locality: "Pilar", province: "Buenos Aires", province_code: "B", lat: -34.45, lng: -58.91, geo_source: "photon", geo_quality: "exacta" },
  },
  {
    id: "b",
    title: "San Martín 1234",
    detail: "Rosario, Santa Fe",
    address: { street: "San Martín", number: "1234", locality: "Rosario", province: "Santa Fe", province_code: "S", lat: -32.95, lng: -60.64, geo_source: "photon", geo_quality: "calle" },
  },
];

function Harness({ onChange }: { onChange: (a: GeoAddress | null) => void }) {
  const [v, setV] = useState<GeoAddress | null>(null);
  return (
    <AddressAutocomplete
      value={v}
      onChange={(a) => {
        setV(a);
        onChange(a);
      }}
    />
  );
}

describe("AddressAutocomplete", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    suggest.mockReset();
    normalize.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("sugiere en una lista flotante, se navega con el teclado y al elegir normaliza con Georef", async () => {
    suggest.mockResolvedValue({ ok: true, suggestions: SUG });
    normalize.mockImplementation(async (a: GeoAddress) => ({
      ok: true,
      normalized: true,
      address: { ...a, partido: "Pilar", geo_source: "georef", geo_quality: "exacta", lat: -34.42, lng: -58.87 },
    }));
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Sa" } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(suggest).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "San Martín 1234" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(suggest).toHaveBeenCalledWith("San Martín 1234", null);
    const list = screen.getByRole("listbox");
    // Flotante: no empuja el resto del formulario.
    expect(list.className).toContain("absolute");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("Rosario, Santa Fe")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(normalize).toHaveBeenCalledWith(SUG[0]!.address);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ locality: "Pilar", geo_source: "georef", lat: -34.42 }));
    // Elegida: tarjeta con la calidad, piso y depto, y el mapa.
    expect(screen.getByText("San Martín 1234, Pilar, Buenos Aires")).toBeTruthy();
    expect(screen.getByText("Ubicación exacta")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Piso"), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ floor: "3", locality: "Pilar" }));
    expect(screen.getByTestId("mapa")).toBeTruthy();
  });

  it("si la búsqueda falla, avisa y deja cargarla a mano", async () => {
    suggest.mockResolvedValue({ ok: false, error: "rate_limited" });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Belgrano 50" } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByRole("status").textContent).toMatch(/Muchas búsquedas/);
    fireEvent.click(screen.getByRole("button", { name: /cargarla a mano/ }));
    expect(onChange).toHaveBeenLastCalledWith({ street: "Belgrano 50", geo_source: "manual", geo_quality: "sin_geo" });
    expect((screen.getByLabelText("Calle") as HTMLInputElement).value).toBe("Belgrano 50");
    expect(screen.getByLabelText("Localidad")).toBeTruthy();
  });
});

// La hoja de cobro, mínima: barra de pestañas, Pago con el renglón del bloque
// y los contenedores fijos de Cliente y Envío.
let keepMounts = 0;
function Keep() {
  useEffect(() => {
    keepMounts += 1;
  }, []);
  return <span>letra</span>;
}

function Sheet() {
  const t = useCheckoutTabsState();
  return (
    <CheckoutTabsProvider value={t.value}>
      {t.tabs.length > 1 && <CheckoutTabBar tabs={t.tabs} tab={t.tab} warnings={t.registered} onTab={t.setTab} />}
      <div data-testid="pago" hidden={t.tab !== "pago"}>
        <CheckoutFold icon={Truck} title="Entrega" summary="Falta completar la entrega" tone="warning" open={false} onToggle={() => {}} tab="envio" keep={<Keep />}>
          <p>Contenido del envío</p>
        </CheckoutFold>
      </div>
      {(["cliente", "envio"] as const).map((k) => (
        <div key={k} data-testid={`panel-${k}`} ref={t.panelRef(k)} hidden={t.tab !== k} />
      ))}
    </CheckoutTabsProvider>
  );
}

describe("Hoja de cobro con pestañas", () => {
  it("el bloque se registra como pestaña, abre su pestaña desde Pago y lo de keep no se desmonta", () => {
    keepMounts = 0;
    render(<Sheet />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((x) => x.textContent)).toEqual(["Pago", "Envío"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    // Aviso pendiente en la pestaña.
    expect(screen.getByRole("img", { name: "Falta completar" })).toBeTruthy();
    expect(screen.queryByText("Contenido del envío")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Entrega/ }));
    expect(screen.getByRole("tab", { name: /Envío/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("panel-envio").textContent).toContain("Contenido del envío");
    expect(screen.getByTestId("pago").hidden).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Pago" }));
    expect(screen.queryByText("Contenido del envío")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Envío/ }));
    expect(screen.getByText("Contenido del envío")).toBeTruthy();
    expect(keepMounts).toBe(1);
  });
});
