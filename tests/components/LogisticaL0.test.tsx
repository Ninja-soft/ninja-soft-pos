// ADR-149 · L0: barra de Logística (Expedición, Remitos, Envíos con candado si
// el plan no la incluye) y la entrega en el detalle de la venta (R18).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SaleDelivery } from "@/modules/orders/api";

vi.mock("next/navigation", () => ({ usePathname: () => "/remitos" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/modules/saas/gating", () => ({ useFeature: (k: string) => k !== "envios" }));
vi.mock("@/modules/orders/hooks", () => ({ useSaleDeliveries: () => ({ data: [] }) }));

import { LogisticsNav } from "@/components/logistics/LogisticsNav";
import { SaleDeliveriesView } from "@/components/sales/SaleDeliveries";

describe("LogisticsNav", () => {
  it("una barra con las sub-páginas (también Reparto y Flota, ADR-161), la actual marcada y candado en lo que no está en el plan", () => {
    render(<LogisticsNav />);
    const nav = screen.getByRole("navigation", { name: "Logística" });
    const links = nav.querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual(["/expedicion", "/logistica/reparto", "/logistica/flota", "/remitos", "/envios"]);
    expect(screen.getByRole("link", { name: /Remitos/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Expedición/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: /Envíos/ }).querySelector('[aria-label="No incluido en tu plan"]')).toBeTruthy();
  });
});

const del = (over: Partial<SaleDelivery>): SaleDelivery => ({
  id: "d1",
  number: 10,
  part: 1,
  parts_total: 2,
  delivery_type: "inmediato",
  status: "entregado",
  ship_address: null,
  pickup_name: null,
  tracking: null,
  delivered_at: null,
  created_at: "2026-10-15T15:00:00Z",
  remito: null,
  ...over,
});

describe("SaleDeliveriesView (detalle de la venta)", () => {
  it("muestra el modo, cada entrega con su estado y su remito", () => {
    render(
      <SaleDeliveriesView
        mode="envio"
        deliveries={[
          del({}),
          del({ id: "d2", number: 11, part: 2, delivery_type: "envio", status: "despachado", ship_address: "Calle 9 100, Tigre", remito: { id: "r1", label: "0001-00000007" } }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: /Entrega · Envío a domicilio/ })).toBeTruthy();
    expect(screen.getByText("Entrega N° 11")).toBeTruthy();
    expect(screen.getByText("Despachado")).toBeTruthy();
    expect(screen.getByText(/A Calle 9 100, Tigre · Remito 0001-00000007/)).toBeTruthy();
    expect(screen.getByText("Se lo lleva ahora")).toBeTruthy();
  });

  it("una venta que sólo se llevó en el momento no muestra nada", () => {
    const { container } = render(<SaleDeliveriesView mode="en_mostrador" deliveries={[del({ parts_total: 1 })]} />);
    expect(container.textContent).toBe("");
  });
});
