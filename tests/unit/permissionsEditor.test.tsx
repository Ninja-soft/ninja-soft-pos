import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ROLE_BY_KEY, type BaseRole } from "@/lib/permissions/capabilities";
import { assignableRoles, copyName, explainPerson, permissionErrorMessage, type RoleLike } from "@/lib/permissions/editor";

// --- mocks -------------------------------------------------------------------
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
const saveRole = vi.fn();
vi.mock("@/modules/permissions/hooks", () => ({
  usePermissionMutations: () => ({ saveRole: { mutateAsync: saveRole, isPending: false } }),
}));

import { RoleEditorModal, type RoleDraft } from "@/components/permissions/RoleEditorModal";

const sys = (k: string): RoleLike => {
  const r = SYSTEM_ROLE_BY_KEY.get(k)!;
  return { id: r.id, name: r.name, base: r.base, system: true, capabilities: [...r.capabilities] };
};
const draft = (over: Partial<RoleDraft> = {}): RoleDraft => ({
  id: null,
  name: "Cajero plus",
  description: "",
  color: "teal",
  icon: "store",
  base: "cashier",
  capabilities: [...SYSTEM_ROLE_BY_KEY.get("cashier")!.capabilities],
  template: "cashier",
  ...over,
});

beforeEach(() => {
  toast.mockReset();
  saveRole.mockReset();
  saveRole.mockResolvedValue("rol-1");
});

describe("lógica del editor", () => {
  it("roles asignables: el dueño todo menos Dueño; un encargado nada de nivel Encargado ni con permisos que no tiene", () => {
    const roles = ["owner", "manager", "cashier", "viewer", "seller", "auditor"].map(sys);
    const custom: RoleLike = { id: "c1", name: "Precios", base: "cashier", system: false, capabilities: ["products.view", "products.edit", "products.price"] };
    const all = [...roles, custom];
    expect(assignableRoles(all, { actorIsOwner: true, actorCaps: [], featureOn: true }).map((r) => r.name)).not.toContain("Dueño");
    expect(assignableRoles(all, { actorIsOwner: true, actorCaps: [], featureOn: false }).some((r) => r.id === "c1")).toBe(false);
    const mgr = sys("manager").capabilities.filter((c) => c !== "products.price");
    const names = assignableRoles(all, { actorIsOwner: false, actorCaps: mgr, featureOn: true }).map((r) => r.name);
    expect(names).toEqual(["Cajero", "Solo lectura", "Vendedor", "Auditor"]);
  });

  it("explica de dónde sale cada permiso", () => {
    const roles = [sys("cashier")];
    const r = explainPerson(
      { base: "cashier" as BaseRole, role_id: roles[0]!.id, overrides: [{ capability: "customers.delete", effect: "grant" }] },
      roles,
      true,
    );
    expect(r.detail.get("customers.delete")!.source).toBe("override");
    expect(r.detail.get("sales.create")!.source).toBe("role");
    expect(r.detail.get("stock.adjust")!.blocked).toBe("not_granted");
  });

  it("nombre de copia sin chocar y mensajes en castellano", () => {
    expect(copyName("Cajero", ["Cajero", "Cajero (copia)"])).toBe("Cajero (copia 2)");
    expect(permissionErrorMessage(new Error("escalation_not_allowed: products.price"))).toMatch(/permisos que vos no tenés/);
    expect(permissionErrorMessage(new Error("feature_not_in_plan: roles_permisos"))).toMatch(/Business/);
    expect(permissionErrorMessage(new Error("algo raro"))).toBe("No se pudo guardar. Probá de nuevo.");
  });
});

describe("<RoleEditorModal>", () => {
  const renderEditor = (over: Partial<Parameters<typeof RoleEditorModal>[0]> = {}) =>
    render(
      <RoleEditorModal
        open
        onOpenChange={() => undefined}
        initial={draft()}
        readOnly={false}
        members={0}
        takenNames={["Cajero", "Encargado"]}
        {...over}
      />,
    );

  it("modo simple: un módulo a Administrar prende sus permisos y guarda normalizado", async () => {
    renderEditor();
    const ventas = screen.getByRole("radiogroup", { name: "Acceso a Ventas" });
    fireEvent.click(within(ventas).getByRole("radio", { name: "Administrar" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar rol" }));
    await waitFor(() => expect(saveRole).toHaveBeenCalledTimes(1));
    const arg = saveRole.mock.calls[0]![0];
    expect(arg.capabilities).toContain("sales.void.past_days");
    expect(arg.base).toBe("cashier");
    expect(arg.name).toBe("Cajero plus");
  });

  it("modo avanzado: prender una capacidad suma sus dependencias y avisa", () => {
    renderEditor({ initial: draft({ capabilities: [] }) });
    fireEvent.click(screen.getByRole("radio", { name: "Avanzado" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Anular ventas de días anteriores" }));
    expect(screen.getByText(/También se prendió lo que hace falta: .*Anular ventas del día/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Ver ventas" }).getAttribute("aria-checked")).toBe("true");
  });

  it("lo que pide nivel Encargado queda bloqueado para un rol de nivel Cajero", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("radio", { name: "Avanzado" }));
    const cfg = screen.getByRole("checkbox", { name: "Editar la configuración del POS" });
    expect(cfg.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(/Pide nivel base Encargado/).length).toBeGreaterThan(0);
  });

  it("no deja guardar con un nombre repetido", () => {
    renderEditor({ initial: draft({ name: "cajero" }) });
    expect(screen.getByText("Ya hay un rol con ese nombre")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Guardar rol" }).hasAttribute("disabled")).toBe(true);
  });

  it("un rol de sistema se ve sin poder editarlo", () => {
    renderEditor({ readOnly: true, initial: draft({ name: "Cajero" }) });
    expect(screen.queryByRole("button", { name: "Guardar rol" })).toBeNull();
    expect(screen.getByText("Rol de sistema: duplicalo para cambiarlo")).toBeTruthy();
  });

  it("plantilla: Como Encargado cambia el nivel y los permisos", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Como Encargado" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar rol" }));
    await waitFor(() => expect(saveRole).toHaveBeenCalled());
    const arg = saveRole.mock.calls[0]![0];
    expect(arg.base).toBe("manager");
    expect(arg.capabilities).toContain("team.manage");
    expect(arg.template).toBe("manager");
  });
});
