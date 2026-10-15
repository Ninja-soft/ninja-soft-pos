import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR-140: asistente "Actualizar precios" por dólar, con vista previa y alertas.
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

let features: Record<string, boolean> = {};
vi.mock("@/modules/saas/gating", () => ({ useFeature: (k: string) => features[k] ?? false }));

vi.mock("@/modules/products/hooks", () => ({
  useCategories: () => ({
    data: [
      { id: "c1", name: "Electrónica", parent_id: null },
      { id: "c2", name: "Routers", parent_id: "c1" },
    ],
  }),
  useBrands: () => ({ data: [{ id: "b1", name: "TP-Link" }] }),
}));
vi.mock("@/modules/purchases/hooks", () => ({ useSuppliers: () => ({ data: [] }) }));

const preview = vi.fn();
vi.mock("@/modules/prices/proApi", async (orig) => {
  const real = await orig<typeof import("@/modules/prices/proApi")>();
  return { ...real, priceProApi: { ...real.priceProApi, bulkV2Preview: (p: unknown) => preview(p), bulkPreview: vi.fn() } };
});

const v2Create = vi.fn();
vi.mock("@/modules/prices/proHooks", () => ({
  useFxQuote: () => ({ data: { rate: 1200, rate_date: "2026-10-15", origin: "plataforma", source: "oficial" }, isLoading: false }),
  usePriceProMutations: () => ({
    bulkCreate: { mutate: vi.fn(), isPending: false },
    bulkV2Create: { mutate: v2Create, isPending: false },
  }),
}));

import { BulkUpdateWizard } from "@/components/prices/BulkUpdateWizard";

const LISTS = [
  { id: "L1", name: "Mayorista", channel: "mayorista", kind: "fixed", adjustment_pct: null },
  { id: "L2", name: "Web", channel: "catalogo", kind: "cost", adjustment_pct: null },
] as never[];

beforeEach(() => {
  toast.mockReset();
  preview.mockReset();
  v2Create.mockReset();
  features = { listas_precios: true, precios_usd: true, compras: false };
});

function renderWizard() {
  return render(
    <BulkUpdateWizard open onOpenChange={() => {}} lists={LISTS} pro={false} requireApproval={false} initialMode="fx" />,
  );
}

describe("BulkUpdateWizard (ADR-140)", () => {
  it("por dólar: muestra la cotización, arma el pedido y revisa con alertas", async () => {
    preview.mockResolvedValue({
      count: 2,
      products: 3,
      usd_products: 2,
      fx: { rate: 1200, rate_date: "2026-10-15", origin: "plataforma", source: "oficial" },
      before: 16800,
      after: 20160,
      price_changes: 2,
      cost_changes: 1,
      below_cost: 1,
      below_floor: 0,
      low_margin: 0,
      skipped: 0,
      rows: [
        {
          product_id: "p1", variant_id: null, list_id: null, name: "Router", sku: "R1", image_url: "https://x/img.png",
          old_price: 15000, new_price: 18000, old_cost: 10000, new_cost: 12000, final_cost: 13200, margin_pct: 11.27, flags: [],
        },
        {
          product_id: "p1", variant_id: null, list_id: "L1", name: "Router", sku: "R1", image_url: null,
          old_price: 1800, new_price: 2160, old_cost: null, new_cost: null, final_cost: 13200, margin_pct: -500, flags: ["below_cost"],
        },
      ],
    });
    renderWizard();

    // Qué: el árbol de categorías y las listas (la sobre costo dice "Sólo precios fijos").
    expect(screen.getByText("Routers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Electrónica" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lista Mayorista" }));
    expect(screen.getByText("Sólo precios fijos")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));

    // Cómo: cotización oficial de la plataforma.
    expect(screen.getByText("Mantener la ganancia")).toBeInTheDocument();
    expect(screen.getByText(/oficial de NinjaSoft/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ver cambios" }));

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    const req = preview.mock.calls[0]![0];
    expect(req).toMatchObject({
      mode: "fx",
      reprice: "keep_markup",
      targets: { base: true, list_ids: ["L1"] },
      scope: { category_ids: ["c1"], usd_only: true },
      fx: { source: "oficial", rate: null },
      effective_at: null,
    });

    // Revisar: miniatura, cambio de costo, alerta y filtro.
    await screen.findByText("Debajo del costo");
    expect(screen.getByText(/1 debajo del costo/)).toBeInTheDocument();
    expect(screen.getByText(/costo \$\s?10\.000,00 a \$\s?12\.000,00/)).toBeInTheDocument();
    expect(document.querySelector('img[src="https://x/img.png"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(v2Create).toHaveBeenCalledTimes(1);
    expect(v2Create.mock.calls[0]![0]).toMatchObject({ mode: "fx", targets: { base: true, list_ids: ["L1"] } });
  });

  it("sin precios_usd no ofrece el modo dólar y arranca en %", () => {
    features = { listas_precios: true, precios_usd: false };
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /Siguiente/ }));
    expect(screen.queryByRole("radio", { name: "Dólar" })).toBeNull();
    expect(screen.getByText(/Sube o baja un porcentaje/)).toBeInTheDocument();
  });
});
