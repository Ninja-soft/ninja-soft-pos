// F17 · ADR-057: resolución de credenciales de proveedor por sucursal.
import { describe, expect, it } from "vitest";
import {
  exactScopeRow,
  loadProviderSecret,
  oauthStateFor,
  pickSecretRow,
  scopeErrorStatus,
  storeFromOAuthState,
  type SecretRow,
} from "@/supabase/functions/_shared/paymentSecrets";

const NORTE = "11111111-1111-4111-8111-111111111111";
const SUR = "22222222-2222-4222-8222-222222222222";

const tenantRow: SecretRow = { id: "t", store_id: null, secrets: { api_key: "negocio" } };
const norteRow: SecretRow = { id: "n", store_id: NORTE, secrets: { api_key: "norte" } };
const surRow: SecretRow = { id: "s", store_id: SUR, secrets: { api_key: "sur" } };

describe("pickSecretRow", () => {
  it("la sucursal con credencial propia gana sobre la del negocio", () => {
    expect(pickSecretRow([tenantRow, norteRow, surRow], NORTE)?.id).toBe("n");
  });
  it("una sucursal sin credencial hereda la del negocio", () => {
    expect(pickSecretRow([tenantRow, norteRow], SUR)?.id).toBe("t");
  });
  it("nunca usa la credencial de otra sucursal", () => {
    expect(pickSecretRow([norteRow, surRow], "33333333-3333-4333-8333-333333333333")).toBeNull();
    expect(pickSecretRow([norteRow], null)).toBeNull();
  });
  it("sin sucursal usa la del negocio", () => {
    expect(pickSecretRow([norteRow, tenantRow], null)?.id).toBe("t");
  });
  it("sin filas no hay credencial", () => {
    expect(pickSecretRow([], NORTE)).toBeNull();
    expect(pickSecretRow(null, null)).toBeNull();
  });
});

describe("exactScopeRow", () => {
  it("usa exactamente la credencial con la que se creó el cobro", () => {
    expect(exactScopeRow([tenantRow, norteRow], NORTE)?.id).toBe("n");
    expect(exactScopeRow([tenantRow, norteRow], null)?.id).toBe("t");
  });
  it("si la de la sucursal ya no existe, cae a la del negocio", () => {
    expect(exactScopeRow([tenantRow], NORTE)?.id).toBe("t");
  });
  it("sin filas devuelve null", () => {
    expect(exactScopeRow([], NORTE)).toBeNull();
  });
});

// Cliente falso de supabase-js: registra filtros y devuelve filas o error.
function fakeAdmin(opts: { rows?: SecretRow[]; error?: boolean; legacy?: Record<string, unknown> | null }) {
  const calls: string[] = [];
  const builder = (select: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      eq: (k: string, v: unknown) => ((filters[k] = v), q),
      or: (expr: string) => (calls.push(`or:${expr}`), q),
      is: (k: string, v: unknown) => (calls.push(`is:${k}:${v}`), q),
      maybeSingle: async () => ({ data: opts.legacy ? { secrets: opts.legacy } : null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(
          opts.error ? { data: null, error: { message: "column store_id does not exist" } } : { data: opts.rows ?? [], error: null },
        ).then(res),
    };
    calls.push(`select:${select}`);
    return q;
  };
  return { calls, admin: { from: () => ({ select: builder }) } };
}

describe("loadProviderSecret", () => {
  it("resuelve sucursal → negocio y filtra por la sucursal pedida", async () => {
    const { admin, calls } = fakeAdmin({ rows: [tenantRow, norteRow] });
    const r = await loadProviderSecret(admin, "tenant", "gocuotas", { storeId: NORTE });
    expect(r).toEqual({ secrets: { api_key: "norte" }, scopeStoreId: NORTE, rowId: "n" });
    expect(calls).toContain(`or:store_id.is.null,store_id.eq.${NORTE}`);
  });
  it("una sucursal inválida no entra al filtro y usa la del negocio", async () => {
    const { admin, calls } = fakeAdmin({ rows: [tenantRow] });
    const r = await loadProviderSecret(admin, "tenant", "gocuotas", { storeId: "x,store_id.neq.null" });
    expect(r?.scopeStoreId).toBeNull();
    expect(calls).toContain("is:store_id:null");
  });
  it("alcance exacto del intent con respaldo al negocio", async () => {
    const { admin } = fakeAdmin({ rows: [tenantRow] });
    const r = await loadProviderSecret(admin, "tenant", "gocuotas", { scopeStoreId: SUR });
    expect(r?.rowId).toBe("t");
  });
  it("base sin la migración: cae a la consulta de siempre", async () => {
    const { admin } = fakeAdmin({ error: true, legacy: { api_key: "viejo" } });
    const r = await loadProviderSecret(admin, "tenant", "gocuotas", { storeId: NORTE });
    expect(r).toEqual({ secrets: { api_key: "viejo" }, scopeStoreId: null, rowId: null });
  });
});

describe("OAuth por sucursal", () => {
  it("la sucursal viaja en el state y se recupera", () => {
    const st = oauthStateFor("abc", NORTE);
    expect(storeFromOAuthState(st)).toBe(NORTE);
    expect(oauthStateFor("abc", null)).toBe("abc");
    expect(storeFromOAuthState("abc")).toBeNull();
    expect(storeFromOAuthState("abc.s.no-uuid")).toBeNull();
  });
  it("mapea errores de alcance a HTTP", () => {
    expect(scopeErrorStatus("store_not_found")).toBe(404);
    expect(scopeErrorStatus("feature_not_in_plan")).toBe(402);
    expect(scopeErrorStatus("forbidden")).toBe(403);
  });
});
