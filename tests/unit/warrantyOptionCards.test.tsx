// ADR-139: selector de garantía del POS. Tarjetas comparables con el precio
// de la línea, los meses, hasta cuándo cubre y "Sin garantía".
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WarrantyOptionCards } from "@/components/pos/WarrantyOptionCards";
import { WarrantyOfferCard } from "@/components/pos/WarrantyOfferCard";
import type { WarrantyOption, WarrantyTarget } from "@/lib/warranty/pos";

const opt = (over: Partial<WarrantyOption>): WarrantyOption => ({
  planId: "p12",
  label: "+12 meses",
  months: 12,
  unitPrice: 50_000,
  total: 100_000,
  description: null,
  terms: null,
  pricePct: 10,
  ...over,
});
const OPTIONS = [opt({}), opt({ planId: "p24", label: "+24 meses", months: 24, unitPrice: 90_000, total: 180_000, description: "Dos años más" })];
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

describe("WarrantyOptionCards", () => {
  it("muestra 'Sin garantía' y una tarjeta por opción con precio, meses, precio por unidad y vencimiento", () => {
    render(
      <WarrantyOptionCards
        options={OPTIONS}
        value=""
        onChange={() => {}}
        quantity={2}
        factoryMonths={12}
        today={new Date("2026-10-15T15:00:00Z")}
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]!.textContent).toContain("Sólo la de fábrica (12 meses)");
    expect(radios[2]!.textContent).toContain("+24 meses");
    expect(radios[2]!.textContent).toContain("Dos años más");
    expect(radios[2]!.textContent).toContain("c/u");
    // 15/10/2026 + 12 de fábrica + 24 = 15/10/2029.
    expect(radios[2]!.textContent).toContain("Cubre hasta el 15/10/2029");
    expect(digits(radios[2]!.textContent)).toContain("180000");
  });

  it("elegir marca la tarjeta y volver a tocarla la saca", () => {
    const onChange = vi.fn();
    const { rerender } = render(<WarrantyOptionCards options={OPTIONS} value="" onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(onChange).toHaveBeenLastCalledWith("p12");
    rerender(<WarrantyOptionCards options={OPTIONS} value="p12" onChange={onChange} />);
    const on = screen.getAllByRole("radio")[1]!;
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(on.className).toContain("choice-on");
    fireEvent.click(on);
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("un plan que ya no se ofrece cuenta como 'Sin garantía'", () => {
    render(<WarrantyOptionCards options={OPTIONS} value="viejo" onChange={() => {}} />);
    expect(screen.getAllByRole("radio")[0]!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("WarrantyOfferCard", () => {
  const target: WarrantyTarget = { lineId: "l1", label: "Smart TV", quantity: 1, factoryMonths: 6, options: OPTIONS };

  it("ofrece sobre la primera línea elegible y se puede descartar", () => {
    const onSelect = vi.fn();
    render(<WarrantyOfferCard targets={[target]} selectedWarrantyId="" onSelect={onSelect} />);
    expect(screen.getByText("Ofrecé garantía extendida")).toBeTruthy();
    expect(screen.getByText("Smart TV")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("radio")[2]!);
    expect(onSelect).toHaveBeenCalledWith("p24");
    fireEvent.click(screen.getByLabelText("Descartar oferta de garantía"));
    expect(screen.queryByText("Ofrecé garantía extendida")).toBeNull();
  });

  it("sin líneas elegibles no muestra nada", () => {
    const { container } = render(<WarrantyOfferCard targets={[]} selectedWarrantyId="" onSelect={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
