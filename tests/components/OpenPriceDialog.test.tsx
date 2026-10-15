// ADR-151: diálogo del POS para el precio a definir al cobrar. Foco directo en
// el precio, teclado numérico, sugerido, mínimo y máximo.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OpenPriceDialog } from "@/components/pos/screen/PosDialogs";

const target = { name: "Relevamiento", min: 500, max: 5000, suggested: 1200, isService: true };

describe("OpenPriceDialog", () => {
  it("abre con el foco en el precio y muestra el rango", () => {
    render(<OpenPriceDialog target={target} onClose={() => {}} onConfirm={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Precio" });
    expect(document.activeElement).toBe(input);
    expect(screen.getByText(/Los honorarios se definen al cobrar/)).toBeTruthy();
    expect(screen.getByText(/Entre/)).toBeTruthy();
  });

  it("teclado numérico con coma y Enter confirma", () => {
    const onConfirm = vi.fn();
    render(<OpenPriceDialog target={target} onClose={() => {}} onConfirm={onConfirm} />);
    for (const k of ["1", "8", "0", "0", ",", "5"]) fireEvent.click(screen.getByRole("button", { name: k }));
    const input = screen.getByRole("textbox", { name: "Precio" }) as HTMLInputElement;
    expect(input.value).toBe("1800,5");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(1800.5);
  });

  it("fuera del rango no confirma y explica por qué", () => {
    const onConfirm = vi.fn();
    render(<OpenPriceDialog target={target} onClose={() => {}} onConfirm={onConfirm} />);
    const input = screen.getByRole("textbox", { name: "Precio" });
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar al carrito" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/mínimo/);
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toMatch(/máximo/);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("usar el sugerido y editar una línea ya cargada", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<OpenPriceDialog target={target} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /Usar sugerido/ }));
    fireEvent.click(screen.getByRole("button", { name: "Agregar al carrito" }));
    expect(onConfirm).toHaveBeenLastCalledWith(1200);
    rerender(<OpenPriceDialog target={{ ...target, current: 2500 }} onClose={() => {}} onConfirm={onConfirm} />);
    expect((screen.getByRole("textbox", { name: "Precio" }) as HTMLInputElement).value).toBe("2500");
    fireEvent.click(screen.getByRole("button", { name: "Guardar precio" }));
    expect(onConfirm).toHaveBeenLastCalledWith(2500);
  });
});
