// ADR-109: referencia de mercado en la ficha del producto. Respeta el switch
// del dueño (pos_settings.show_catalog_price_hints): apagado no se muestra y
// la RPC de comparación NO se llama. Encendido: rango, posición del precio y
// lista ordenada con tienda, vendedor y disponible.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rpc = vi.fn();
const state = { hasCatalog: 1, setting: true as boolean | null };

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc,
    from: (table: string) => ({
      select: () =>
        table === "tenant_catalog_purchases"
          ? Promise.resolve({ count: state.hasCatalog, error: null })
          : {
              maybeSingle: () =>
                Promise.resolve({
                  data: state.setting === null ? null : { show_catalog_price_hints: state.setting },
                  error: null,
                }),
            },
    }),
  }),
}));

import { MarketReferencePanel } from "@/components/catalog/MarketReferencePanel";

const OFFERS = [
  { store_key: "BNA", store_name: "Tienda BNA", vendedor: "Electro Sur", principal: false, precio: 1500, disponible: true, last_seen_at: "2026-10-11T12:00:00Z" },
  { store_key: "JUMBO", store_name: "Jumbo", vendedor: "Jumbo", principal: true, precio: 1800, precio_lista: 1900, disponible: true, url: "https://j/1" },
  { store_key: "COTO", store_name: "Coto", vendedor: "Coto", principal: true, precio: 2000, disponible: false },
];

function renderPanel(myPrice: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MarketReferencePanel ean="7790070012050" myPrice={myPrice} />
    </QueryClientProvider>,
  );
}

describe("MarketReferencePanel", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: OFFERS, error: null });
    state.hasCatalog = 1;
    state.setting = true;
  });

  it("con el switch prendido muestra rango, posición y lista por precio", async () => {
    renderPanel(1700);
    expect(await screen.findByText("Referencia de mercado")).toBeTruthy();
    await screen.findByText("En rango con el mercado");
    expect(rpc).toHaveBeenCalledWith("catalog_price_compare", { p_ean: "7790070012050" });
    expect(screen.getAllByText(/Electro Sur/).length).toBeGreaterThan(0);
    expect(screen.getByText("Sin stock")).toBeTruthy();
    expect(screen.getByText("Ocultar").closest("a")?.getAttribute("href")).toContain("grupo=productos");
    const names = screen.getAllByText(/^(Tienda BNA|Jumbo|Coto)$/).map((n) => n.textContent);
    expect(names.slice(-3)).toEqual(["Tienda BNA", "Jumbo", "Coto"]);
  });

  it("precio por debajo / por encima del mercado", async () => {
    renderPanel(1000);
    expect(await screen.findByText("Por debajo del mercado")).toBeTruthy();
  });

  it("con el switch apagado no se muestra ni llama a la RPC", async () => {
    state.setting = false;
    const { container } = renderPanel(1700);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    await new Promise((r) => setTimeout(r, 30));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sin catálogo tampoco", async () => {
    state.hasCatalog = 0;
    const { container } = renderPanel(1700);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.innerHTML).toBe("");
    expect(rpc).not.toHaveBeenCalled();
  });
});
