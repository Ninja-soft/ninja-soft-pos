import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Package, Receipt, ShoppingCart, Tag, Wallet } from "lucide-react";
import { MenuCustomizer, type CustomizerItem } from "@/components/layout/MenuCustomizer";
import { TOP_GROUP, mergeLayout, type MenuDefaults, type MenuLayout } from "@/lib/nav/menuLayout";

const DEFAULTS: MenuDefaults = {
  groups: [
    { id: TOP_GROUP, items: [] },
    { id: "op", items: ["/pos", "/caja", "/ventas"] },
    { id: "cat", items: ["/productos", "/etiquetas"] },
  ],
};
const ITEMS: Record<string, CustomizerItem> = {
  "/pos": { id: "/pos", label: "Punto de venta", icon: ShoppingCart },
  "/caja": { id: "/caja", label: "Caja", icon: Wallet },
  "/ventas": { id: "/ventas", label: "Ventas", icon: Receipt },
  "/productos": { id: "/productos", label: "Productos", icon: Package },
  "/etiquetas": { id: "/etiquetas", label: "Etiquetas", icon: Tag, locked: true },
};

function setup() {
  const onChange = vi.fn<(l: MenuLayout) => void>();
  const onDone = vi.fn();
  render(
    <MenuCustomizer
      layout={mergeLayout(DEFAULTS, null)}
      defaults={DEFAULTS}
      items={ITEMS}
      groupLabels={{ op: "Operación", cat: "Catálogo" }}
      onChange={onChange}
      onDone={onDone}
      onReset={vi.fn()}
      canReset={false}
    />,
  );
  return { onChange, onDone };
}

const status = () => screen.getByTestId("menu-live");

describe("MenuCustomizer con teclado", () => {
  it("Espacio toma, flechas mueven y Espacio suelta (con anuncios)", () => {
    const { onChange } = setup();
    const handle = screen.getByRole("button", { name: "Mover Caja" });
    handle.focus();
    fireEvent.keyDown(handle, { key: " " });
    expect(status()).toHaveTextContent("Tomaste Caja");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(status()).toHaveTextContent("Caja: Operación, posición 1 de 3");
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover Caja" }), { key: " " });
    expect(status()).toHaveTextContent("Soltaste Caja en Operación, posición 1 de 3");
    expect(onChange).toHaveBeenCalledTimes(1);
    const l = onChange.mock.calls[0]![0];
    expect(l.groups.find((g) => g.id === "op")!.items).toEqual(["/caja", "/pos", "/ventas"]);
  });

  it("cruza de grupo y entra a Ocultos con las flechas", () => {
    const { onChange } = setup();
    const handle = screen.getByRole("button", { name: "Mover Ventas" });
    fireEvent.keyDown(handle, { key: "Enter" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(status()).toHaveTextContent("Ventas: Catálogo, posición 1 de 3");
    const h2 = screen.getByRole("button", { name: "Mover Ventas" });
    fireEvent.keyDown(h2, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover Ventas" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover Ventas" }), { key: "ArrowDown" });
    expect(status()).toHaveTextContent("Ventas: Ocultos, posición 1 de 1");
    // El foco sigue en el ítem que se mueve aunque cambie de grupo.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mover Ventas" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover Ventas" }), { key: " " });
    expect(onChange.mock.calls[0]![0].hidden).toEqual(["/ventas"]);
  });

  it("Escape cancela y deja todo como estaba", () => {
    const { onChange } = setup();
    const handle = screen.getByRole("button", { name: "Mover Punto de venta" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover Punto de venta" }), { key: "Escape" });
    expect(status()).toHaveTextContent("Cancelado. Punto de venta volvió a su lugar");
    expect(onChange).not.toHaveBeenCalled();
    const op = document.querySelector('[data-container="op"]')!;
    const order = Array.from(op.querySelectorAll("[data-nav-item]")).map((n) => n.getAttribute("data-nav-item"));
    expect(order).toEqual(["/pos", "/caja", "/ventas"]);
  });

  it("los grupos se mueven con el teclado", () => {
    const { onChange } = setup();
    const handle = screen.getByRole("button", { name: "Mover grupo Catálogo" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(status()).toHaveTextContent("Grupo Catálogo: posición 1 de 2");
    fireEvent.keyDown(screen.getByRole("button", { name: "Mover grupo Catálogo" }), { key: " " });
    expect(onChange.mock.calls[0]![0].groups.map((g) => g.id)).toEqual([TOP_GROUP, "cat", "op"]);
  });

  it("el ojo pasa un ítem a Ocultos y Listo cierra el modo", () => {
    const { onChange, onDone } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Ocultar Productos" }));
    expect(onChange.mock.calls[0]![0].hidden).toEqual(["/productos"]);
    expect(screen.getByRole("button", { name: "Mostrar Productos" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Listo" }));
    expect(onDone).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Restablecer/ })).toBeDisabled();
  });
});
