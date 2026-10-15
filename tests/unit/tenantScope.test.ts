// Aislamiento entre cuentas en el navegador (ADR-152): caché por negocio y
// por área, membresía del negocio activo y notificaciones del negocio activo.
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  activeTenantIdOf,
  areaOf,
  cacheScopeOf,
  createScopedQueryClient,
  decideScopeChange,
  onlyActiveTenant,
  resetScopedCache,
} from "@/lib/tenant/scope";
import { scopeNotifications } from "@/modules/notifications/api";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const user = (id: string, tenant?: string) => ({ id, app_metadata: tenant ? { current_tenant_id: tenant } : {} });

describe("negocio activo del JWT", () => {
  it("lee app_metadata.current_tenant_id y nada más", () => {
    expect(activeTenantIdOf(user("u1", A))).toBe(A);
    expect(activeTenantIdOf(user("u1"))).toBeNull();
    expect(activeTenantIdOf(null)).toBeNull();
    expect(activeTenantIdOf({ id: "u1", app_metadata: { current_tenant_id: "" } })).toBeNull();
    // user_metadata nunca cuenta (lo escribe el usuario).
    expect(activeTenantIdOf({ id: "u1", user_metadata: { current_tenant_id: B } } as never)).toBeNull();
  });

  it("onlyActiveTenant agrega tenant_id = negocio activo a la consulta de membresías", () => {
    const eq = vi.fn().mockReturnThis();
    const q = { eq };
    expect(onlyActiveTenant(q, user("u1", B))).toBe(q);
    expect(eq).toHaveBeenCalledWith("tenant_id", B);
  });

  it("sin negocio activo no filtra (la autocuración elige uno)", () => {
    const eq = vi.fn().mockReturnThis();
    onlyActiveTenant({ eq }, user("u1"));
    expect(eq).not.toHaveBeenCalled();
  });
});

describe("área de la caché", () => {
  it("/internal y sus rutas son internas; el resto es del negocio", () => {
    expect(areaOf("/internal")).toBe("internal");
    expect(areaOf("/internal/tenants/x")).toBe("internal");
    expect(areaOf("/internalidad")).toBe("app");
    expect(areaOf("/dashboard")).toBe("app");
    expect(areaOf(null)).toBe("app");
  });
});

describe("cambio de cuenta dueña de la caché", () => {
  const sA = cacheScopeOf(user("u1", A));
  const sB = cacheScopeOf(user("u1", B));

  it("primera observación o misma cuenta: nada", () => {
    expect(decideScopeChange(null, sA, "/dashboard")).toBe("none");
    expect(decideScopeChange(sA, cacheScopeOf(user("u1", A)), "/pos")).toBe("none");
  });

  it("mismo usuario con otro negocio en el panel: limpiar y recargar", () => {
    expect(decideScopeChange(sA, sB, "/pos")).toBe("reload");
    expect(decideScopeChange(sA, sB, "/internal/tenants")).toBe("reload");
  });

  it("otro usuario en el mismo navegador: limpiar y recargar", () => {
    expect(decideScopeChange(sA, cacheScopeOf(user("u2", A)), "/dashboard")).toBe("reload");
  });

  it("en alta, login, onboarding o canje de acceso sólo limpia (navegan solas)", () => {
    for (const p of ["/signup", "/login", "/onboarding", "/auth/impersonate", "/login-internal"]) {
      expect(decideScopeChange(sA, sB, p)).toBe("clear");
    }
  });

  it("logout o login: limpiar", () => {
    const anon = cacheScopeOf(null);
    expect(decideScopeChange(sA, anon, "/dashboard")).toBe("clear");
    expect(decideScopeChange(anon, sA, "/dashboard")).toBe("clear");
  });
});

describe("resetScopedCache", () => {
  it("borra lo inactivo y deja lo montado sin datos del negocio anterior", async () => {
    const qc = createScopedQueryClient();
    qc.setQueryData(["customers"], [{ id: "c-del-negocio-A" }]);
    const fetchB = vi.fn().mockResolvedValue([{ id: "n-B" }]);
    qc.setQueryData(["notifications"], [{ id: "n-A" }]);
    const obs = new QueryObserver(qc, { queryKey: ["notifications"], queryFn: fetchB, staleTime: Infinity });
    const unsub = obs.subscribe(() => {});
    expect(obs.getCurrentResult().data).toEqual([{ id: "n-A" }]);

    await resetScopedCache(qc);

    expect(qc.getQueryData(["customers"])).toBeUndefined();
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(["notifications"])).toEqual([{ id: "n-B" }]);
    expect(obs.getCurrentResult().data).not.toEqual([{ id: "n-A" }]);
    unsub();
  });

  it("vacía las mutaciones pendientes", async () => {
    const qc = new QueryClient();
    qc.getMutationCache().build(qc, { mutationFn: async () => 1 });
    expect(qc.getMutationCache().getAll()).toHaveLength(1);
    await resetScopedCache(qc);
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
  });

  it("panel e /internal son cachés separadas: la misma key no se comparte", () => {
    const app = createScopedQueryClient();
    const internal = createScopedQueryClient();
    internal.setQueryData(["products"], [{ id: "de-un-cliente" }]);
    expect(app.getQueryData(["products"])).toBeUndefined();
  });
});

describe("notificaciones del negocio activo", () => {
  const rows = [
    { id: "a", target_tenant_id: A },
    { id: "b", target_tenant_id: B },
    { id: "p", target_tenant_id: null },
  ];

  it("sólo las del negocio activo y las de plataforma, marcadas", () => {
    const out = scopeNotifications(rows, A);
    expect(out.map((n) => n.id)).toEqual(["a", "p"]);
    expect(out.find((n) => n.id === "a")!.scope).toBe("business");
    expect(out.find((n) => n.id === "p")!.scope).toBe("platform");
  });

  it("al cambiar de negocio se ven las del otro, nunca las dos", () => {
    expect(scopeNotifications(rows, B).map((n) => n.id)).toEqual(["b", "p"]);
  });

  it("sin negocio activo sólo quedan las de plataforma", () => {
    expect(scopeNotifications(rows, null).map((n) => n.id)).toEqual(["p"]);
  });
});
