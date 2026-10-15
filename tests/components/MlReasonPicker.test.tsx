// ADR-145: selector de motivos de exclusión con el maestro de Mercado Libre.
// Guarda la misma lista de códigos de antes.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MlReasonLabel, MlReasonPicker } from "@/components/mercadolibre/gestor/MlReasonPicker";
import { indexReasons, type ClaimReason } from "@/lib/mercadolibre/claimReasons";

const R = (id: string, family: ClaimReason["family"], title: string, over: Partial<ClaimReason> = {}): ClaimReason => ({
  id,
  family,
  title,
  description: null,
  flow: null,
  alias_of: null,
  excludable: false,
  recommended: false,
  active: true,
  ...over,
});
const rows = [
  R("PDD9939", "PDD", "Llegó lo que compré en buenas condiciones pero no lo quiero", {
    recommended: true,
    excludable: true,
    description: "Reclamo con el producto entregado. El comprador puede pedir cambiarlo o devolver el producto.",
  }),
  R("PNR9501", "PNR", "Me arrepentí de la compra", { recommended: true, excludable: true }),
  R("PDD9727", "PDD", "Me arrepentí de comprarlo", { excludable: true }),
  R("PDD9946", "PDD", "El producto está dañado: llegó bien"),
  R("CS9527", "CS", "Tuve problemas con el envío: otro"),
];

function Harness({ initial, onChange, loadingIds }: { initial: string[]; onChange?: (v: string[]) => void; loadingIds?: string[] }) {
  const [v, setV] = useState(initial);
  return (
    <MlReasonPicker
      value={v}
      reasons={rows}
      loadingIds={loadingIds}
      onChange={(n) => {
        setV(n);
        onChange?.(n);
      }}
    />
  );
}

describe("MlReasonPicker", () => {
  it("chips con código y título; al tocar uno muestra la descripción", () => {
    render(<Harness initial={["PDD9939", "PNR9501"]} />);
    const chosen = screen.getByRole("list", { name: "Motivos elegidos" });
    expect(within(chosen).getByText("PDD9939")).toBeTruthy();
    expect(within(chosen).getByText("Me arrepentí de la compra")).toBeTruthy();
    fireEvent.click(within(chosen).getByText("PDD9939"));
    const detail = screen.getByRole("region", { name: "Detalle de PDD9939" });
    expect(within(detail).getByText(/El comprador puede pedir cambiarlo/)).toBeTruthy();
    expect(within(detail).getByText("Suele poder excluirse")).toBeTruthy();
  });

  it("sin búsqueda muestra Recomendados; con búsqueda agrupa por tipo y agrega", () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    expect(screen.getByText("Ninguno: ningún caso se marca para pedir la exclusión.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recomendados" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Buscar motivo"), { target: { value: "arrepenti" } });
    expect(screen.getByRole("region", { name: "Producto distinto o defectuoso" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Producto no recibido" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cancelación de la venta" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /PDD9727 Me arrepentí de comprarlo/ }));
    expect(onChange).toHaveBeenLastCalledWith(["PDD9727"]);
    expect(screen.getByRole("button", { name: /PDD9727 Me arrepentí de comprarlo/, pressed: true })).toBeTruthy();
  });

  it("filtro de los que suelen poder excluirse", () => {
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Sólo los que suelen poder excluirse" }));
    expect(screen.queryByText(/El producto está dañado/)).toBeNull();
    expect(screen.getByText("Me arrepentí de comprarlo")).toBeTruthy();
  });

  it("código manual que no está en el maestro: sin descripción y buscando", () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Buscar motivo"), { target: { value: "pdd1234" } });
    expect(screen.getByText(/no está en el maestro/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Agregar a mano/ }));
    expect(onChange).toHaveBeenLastCalledWith(["PDD1234"]);
    expect(screen.getByText("Sin descripción")).toBeTruthy();
  });

  it("muestra Buscando descripción mientras se completa y se puede quitar", () => {
    const onChange = vi.fn();
    render(<Harness initial={["PDD1234", "PDD9939"]} loadingIds={["PDD1234"]} onChange={onChange} />);
    expect(screen.getByText("Buscando descripción")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quitar PDD1234" }));
    expect(onChange).toHaveBeenLastCalledWith(["PDD9939"]);
  });

  it("deshabilitado: sin buscador ni botones para quitar", () => {
    render(<MlReasonPicker value={["PDD9939"]} reasons={rows} onChange={() => {}} disabled />);
    expect(screen.queryByLabelText("Buscar motivo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar PDD9939" })).toBeNull();
  });
});

describe("MlReasonLabel", () => {
  it("título con el código; sin maestro, la familia", () => {
    const idx = indexReasons(rows);
    const { rerender } = render(<MlReasonLabel id="PNR9501" index={idx} />);
    expect(screen.getByText("Me arrepentí de la compra")).toBeTruthy();
    expect(screen.getByText("(PNR9501)")).toBeTruthy();
    rerender(<MlReasonLabel id="PNR1111" index={idx} />);
    expect(screen.getByText("Producto no recibido")).toBeTruthy();
  });
});
