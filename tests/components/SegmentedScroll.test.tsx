// Segmented con `scroll` (ADR-145): en cualquier ancho una sola fila con
// scroll lateral; sin la opción, igual que siempre (puede pasar a otra línea).
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "@/components/ui/Segmented";

const options = ["Publicaciones", "Ventas", "Facturación", "Preguntas", "Envíos", "Full", "Posventa", "Embudos", "Métricas", "Configuración"].map(
  (l) => ({ value: l.toLowerCase(), label: l }),
);

describe("Segmented scroll", () => {
  it("una sola fila con scroll lateral en todos los anchos", () => {
    const onChange = vi.fn();
    const { container } = render(<Segmented value="ventas" onChange={onChange} options={options} aria-label="Secciones" scroll />);
    const group = screen.getByRole("radiogroup", { name: "Secciones" });
    expect(group.className).toContain("flex-nowrap");
    expect(group.className).not.toMatch(/(^| )flex-wrap( |$)/);
    const scroller = container.querySelector("[data-segmented-scroll]")!;
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).not.toContain("sm:overflow-visible");
    fireEvent.click(screen.getByRole("radio", { name: "Configuración" }));
    expect(onChange).toHaveBeenCalledWith("configuración");
  });

  it("sin la opción sigue pudiendo pasar a otra línea; scrollOnMobile sólo en mobile", () => {
    const { container, rerender } = render(<Segmented value="ventas" onChange={() => {}} options={options} aria-label="Secciones" />);
    expect(screen.getByRole("radiogroup").className).toContain("flex-wrap");
    expect(container.querySelector("[data-segmented-scroll]")).toBeNull();
    rerender(<Segmented value="ventas" onChange={() => {}} options={options} aria-label="Secciones" scrollOnMobile />);
    expect(screen.getByRole("radiogroup").className).toContain("max-sm:flex-nowrap");
    expect(container.firstElementChild!.className).toContain("sm:overflow-visible");
  });
});
