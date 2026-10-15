// ADR-151: sección Precio de la ficha. Precio de venta destacado con foco al
// entrar, margen de verdad (sobre el precio sin IVA), resumen en vivo y modo
// "a definir al cobrar" con mínimo y máximo.
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useForm } from "react-hook-form";

vi.mock("@/modules/saas/gating", () => ({ useFeature: () => true }));
vi.mock("@/components/saas/FeatureGate", () => ({ FeatureGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const LISTS = [
  { id: "m", name: "Mayorista", channel: "mayorista", kind: "fixed", adjustment_pct: -10, is_active: true, created_at: "2026-01-01" },
  { id: "d", name: "Web", channel: "catalogo", kind: "derived", base_list_id: "m", adjustment_pct: null, adjustment_amount: 50, is_active: true, created_at: "2026-01-02" },
  { id: "f", name: "Amigos", channel: "custom", kind: "fixed", adjustment_pct: -20, is_active: true, created_at: "2026-01-03" },
];
vi.mock("@/modules/prices/proApi", () => ({
  priceProApi: {
    snapshot: async () => ({
      pro: true, at: "2026-10-15T12:00:00Z", lists: LISTS, items: [], schedules: [], breaks: [], terms: [], fx: [],
      costs: {}, assigned: [], customerTermId: null,
    }),
  },
}));
vi.mock("@/modules/prices/proHooks", () => ({
  useProductPricesOverview: () => ({ data: { base: 1000, lists: [{ list_id: "f", item_price: 777 }], upcoming: [] } }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProductListPrices, ProductPriceSection } from "@/components/products/ProductPriceSection";
import type { PriceMode } from "@/lib/prices/openPrice";

function Harness({ isService = false, active = true, cost = 100, ivaPct = 21, price = 0 }) {
  const { register, watch, setValue } = useForm<{
    price: number;
    cost: number;
    price_mode?: PriceMode;
    open_price_min: string;
    open_price_max: string;
  }>({ defaultValues: { price, cost, open_price_min: "", open_price_max: "" } });
  const [tab, setTab] = useState(active);
  const p = Number(watch("price")) || 0;
  const c = Number(watch("cost")) || null;
  return (
    <div>
      <button type="button" onClick={() => setTab(true)}>
        Ir a precios
      </button>
      <ProductPriceSection
        active={tab}
        isService={isService}
        ivaPct={ivaPct}
        price={p}
        finalCost={c}
        priceRegister={register("price")}
        costRegister={register("cost")}
        onPriceChange={(v) => setValue("price", v)}
        priceMode={watch("price_mode") === "open" ? "open" : "fixed"}
        onPriceModeChange={(m) => setValue("price_mode", m)}
        openMinRegister={register("open_price_min")}
        openMaxRegister={register("open_price_max")}
        openMin={watch("open_price_min")}
        openMax={watch("open_price_max")}
      />
    </div>
  );
}

describe("ProductPriceSection (ADR-151)", () => {
  it("al entrar a la pestaña el foco queda en el precio de venta", () => {
    render(<Harness active={false} price={150} />);
    const input = screen.getByLabelText("Precio de venta");
    expect(document.activeElement).not.toBe(input);
    fireEvent.click(screen.getByText("Ir a precios"));
    expect(document.activeElement).toBe(input);
  });

  it("en un servicio el precio se llama Honorarios", () => {
    render(<Harness isService />);
    expect(screen.getByLabelText("Honorarios")).toBeInTheDocument();
  });

  it("margen 50 % con costo 100 e IVA 21 % da precio 242", () => {
    render(<Harness price={0} />);
    fireEvent.change(screen.getByLabelText("Margen %"), { target: { value: "50" } });
    expect((screen.getByLabelText("Precio de venta") as HTMLInputElement).value).toBe("242");
    expect(screen.getByTestId("price-summary").textContent).toMatch(/Ganás \$\s?100,00 por unidad · margen 50 % · markup 100 %/);
  });

  it("el resumen se actualiza en vivo y avisa la pérdida", () => {
    render(<Harness price={121} ivaPct={21} />);
    expect(screen.getByTestId("price-summary").textContent).toMatch(/Ganás \$\s?0,00/);
    fireEvent.change(screen.getByLabelText("Precio de venta"), { target: { value: "60.5" } });
    expect(screen.getByTestId("price-summary").textContent).toMatch(/Perdés \$\s?50,00 por unidad/);
  });

  it("a definir al cobrar: muestra mínimo y máximo, el precio pasa a sugerido y valida el rango", () => {
    render(<Harness price={1000} />);
    expect(screen.queryByLabelText("Mínimo")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "A definir al cobrar" }));
    expect(screen.getByLabelText("Precio sugerido")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mínimo"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Máximo"), { target: { value: "100" } });
    expect(screen.getByText("El mínimo no puede ser mayor que el máximo")).toBeInTheDocument();
  });
});

describe("ProductListPrices (ADR-151)", () => {
  it("usa el resolver real: derivada con monto, fija con precio del producto y la regla en palabras", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductListPrices productId="p1" price={1000} lists={LISTS as never} priceMode="fixed" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/950,00/)).toBeInTheDocument(); // Web: Mayorista (900) + $50
    expect(screen.getByText(/900,00/)).toBeInTheDocument();
    expect(screen.getByText(/777,00/)).toBeInTheDocument();
    expect(screen.getByText("Sale de Mayorista + $50")).toBeInTheDocument();
    expect(screen.getByText("Precio fijo para este producto")).toBeInTheDocument();
  });

  it("precio libre: no muestra listas", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProductListPrices productId="p1" price={1000} lists={LISTS as never} priceMode="open" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Precio libre: se define al cobrar/)).toBeInTheDocument();
  });
});
