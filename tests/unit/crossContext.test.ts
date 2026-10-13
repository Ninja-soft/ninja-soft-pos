import { describe, expect, it } from "vitest";
import { branchTabTitle, crossContextNotice } from "@/lib/branches/crossContext";

const names: Record<string, string> = { c: "Centro", n: "Norte" };
const branchName = (id: string | null | undefined) => (id ? (names[id] ?? null) : null);

describe("aviso de contexto cruzado (H90)", () => {
  it("panel en Norte y turno propio en Centro: Vender lo dice", () => {
    const n = crossContextNotice({ filterStoreId: "n", posStoreId: "c", myShiftStoreId: "c", branchName });
    expect(n?.storeId).toBe("c");
    expect(n?.message).toBe("Tu caja abierta está en Centro");
    expect(n?.hint).toMatch(/Estás viendo Norte/);
  });

  it("sin turno propio y el equipo vende en otra sucursal", () => {
    const n = crossContextNotice({ filterStoreId: "n", posStoreId: "c", myShiftStoreId: null, branchName });
    expect(n?.message).toBe("Este equipo vende en Centro");
  });

  it("sin aviso cuando coinciden, con 'Todas' o sin datos", () => {
    expect(crossContextNotice({ filterStoreId: "c", posStoreId: "c", myShiftStoreId: "c", branchName })).toBeNull();
    expect(crossContextNotice({ filterStoreId: null, posStoreId: "c", myShiftStoreId: "n", branchName })).toBeNull();
    expect(crossContextNotice({ filterStoreId: "n", posStoreId: null, myShiftStoreId: null, branchName })).toBeNull();
    // El turno propio en la sucursal que se mira gana aunque el equipo recuerde otra.
    expect(crossContextNotice({ filterStoreId: "n", posStoreId: "c", myShiftStoreId: "n", branchName })).toBeNull();
  });
});

describe("título de pestaña con la sucursal", () => {
  it("prefija, cambia de sucursal y se saca sin apilar", () => {
    const t1 = branchTabTitle("Ventas | NinjaSoft", "Norte", null);
    expect(t1).toBe("Norte · Ventas | NinjaSoft");
    // Next vuelve a escribir el mismo título: no se apila.
    expect(branchTabTitle(t1, "Norte", "Norte")).toBe(t1);
    expect(branchTabTitle(t1, "Centro", "Norte")).toBe("Centro · Ventas | NinjaSoft");
    expect(branchTabTitle("Centro · Caja | NinjaSoft", null, "Centro")).toBe("Caja | NinjaSoft");
    // Navegación: Next escribe el título nuevo sin prefijo.
    expect(branchTabTitle("Reportes | NinjaSoft", "Norte", "Norte")).toBe("Norte · Reportes | NinjaSoft");
  });
});
