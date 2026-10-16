// Detalle de auditoría legible (TX-AUD, ADR-160): título, quién/cuándo/dónde,
// Antes → Después por sección y datos técnicos plegados.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AuditEventBody, AuditEventHeader, type AuditDetailEvent } from "@/components/audit/AuditEventDetail";
import { presentAuditEvent } from "@/lib/audit/present";

const CAT = "11111111-1111-4111-8111-111111111111";
const CAT2 = "22222222-2222-4222-8222-222222222222";

const event: AuditDetailEvent = {
  id: "ev1",
  created_at: "2026-10-15T13:30:00Z",
  entity_type: "products",
  entity_id: "p1",
  action: "UPDATE",
  before_data: { name: "Arroz 1 kg", price: 1500, allow_negative: null, cost_fx_date: null, category_id: CAT, tenant_id: "t" },
  after_data: { name: "Arroz 1 kg", price: 1800, allow_negative: null, cost_fx_date: "", category_id: CAT2, tenant_id: "t" },
  reason: "Aumento de proveedor",
  actorName: "juan pérez",
  storeName: "Centro",
};

describe("AuditEventDetail", () => {
  it("muestra título humano, sólo los cambios y datos técnicos plegados", () => {
    const names = (kind: string, id: string) => (kind === "category" ? ({ [CAT]: "Almacén", [CAT2]: "Bebidas" } as Record<string, string>)[id] : null);
    const presented = presentAuditEvent(event, names);
    render(
      <>
        <AuditEventHeader event={event} presented={presented} />
        <AuditEventBody event={event} presented={presented} />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Producto editado: Arroz 1 kg" })).toBeInTheDocument();
    expect(screen.getByText("Juan Pérez")).toBeInTheDocument();
    expect(screen.getByText("15/10/2026 10:30")).toBeInTheDocument();
    expect(screen.getByText("Centro")).toBeInTheDocument();
    expect(screen.getByText("2 cambios")).toBeInTheDocument();
    expect(screen.getByText("Precio de venta")).toBeInTheDocument();
    expect(screen.getByText("Almacén")).toBeInTheDocument();
    expect(screen.getByText("Bebidas")).toBeInTheDocument();
    expect(screen.queryByText(/allow_negative|Permite vender sin stock|vacío/)).toBeNull();
    expect(screen.queryByText(/"tenant_id"/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ver datos técnicos/ }));
    expect(screen.getAllByText(/"allow_negative": null/)).toHaveLength(2);
  });
});
