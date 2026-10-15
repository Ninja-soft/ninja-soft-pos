// ADR-145: maestro de motivos de reclamo de Mercado Libre. Armado de la fila
// desde la API (respuestas reales del 15/10/2026), completado con fetch falso
// que sólo hace GET, búsqueda y agrupado de la UI, y el seed de la migración.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FILL_MAX,
  fillReasons,
  isExcludable,
  needsParent,
  parseReasonCodes,
  reasonDescription,
  reasonFamily,
  reasonFromApi,
  reasonTitle,
  type MlReasonApi,
} from "@/supabase/functions/_shared/mercadolibre/reasons";
import { groupByFamily, indexReasons, missingReasons, reasonTitleOf, searchReasons, type ClaimReason } from "@/lib/mercadolibre/claimReasons";

// Respuestas reales de GET /post-purchase/v1/claims/reasons/{id}.
const PDD9939: MlReasonApi = {
  id: "PDD9939",
  flow: "post_purchase_delivered",
  name: "repentant_buyer",
  detail: "Llegó lo que compré en buenas condiciones pero no lo quiero",
  parent_id: null,
  status: "active",
  filter: { site_id: ["MLA", "MLB"] },
  settings: { expected_resolutions: ["change_product", "return_product"], rules_engine_triage: ["repentant"] },
};
const PDD9946: MlReasonApi = {
  id: "PDD9946",
  flow: "post_purchase_delivered",
  name: "broken_item",
  detail: "Llegó bien",
  parent_id: "PDD9945",
  status: "active",
  settings: { expected_resolutions: ["change_product", "return_product"], rules_engine_triage: ["defective"] },
};
const PDD9945: MlReasonApi = { id: "PDD9945", detail: "El producto está dañado", name: "broken_item_parent", flow: "post_purchase_delivered" };
const PNR9502: MlReasonApi = {
  id: "PNR9502",
  flow: "mediations_undelivered",
  name: "respondent_unanswered",
  detail: "El vendedor no me respondió",
  parent_id: null,
  status: "active",
  settings: { expected_resolutions: ["refund", "product"], rules_engine_triage: [] },
};

describe("reasons.ts", () => {
  it("familia por prefijo", () => {
    expect(reasonFamily("PDD9939")).toBe("PDD");
    expect(reasonFamily("pnr9501")).toBe("PNR");
    expect(reasonFamily("CS9527")).toBe("CS");
    expect(reasonFamily("XYZ123")).toBe("OTRO");
    expect(reasonFamily(null)).toBe("OTRO");
  });

  it("parsea códigos escritos a mano", () => {
    expect(parseReasonCodes("pdd9939, PNR9501;PDD9939  x 12")).toEqual({ valid: ["PDD9939", "PNR9501"], invalid: ["X", "12"] });
  });

  it("título con el padre sólo si el detalle no se entiende solo", () => {
    expect(needsParent("Llegó bien")).toBe(true);
    expect(needsParent("Otro")).toBe(true);
    expect(needsParent("Lo compré por error")).toBe(false);
    expect(reasonTitle("Llegó bien", "El producto está dañado")).toBe("El producto está dañado: llegó bien");
    expect(reasonTitle("Lo compré por error", "Me arrepentí de comprarlo")).toBe("Lo compré por error");
    expect(reasonTitle("Otro — motivo", null)).toBe("Otro - motivo");
  });

  it("descripción con el circuito y lo que puede pedir el comprador", () => {
    expect(reasonDescription("mediations_undelivered", ["refund", "product"])).toBe(
      "Mediación por producto no recibido. El comprador puede pedir que le devuelvan la plata o recibir el producto.",
    );
    expect(reasonDescription("cancel_sale", [])).toBe("Cancelación de la venta.");
    expect(reasonDescription(null, [])).toBeNull();
  });

  it("excluible orientativo: arrepentimiento y compra por error sí; demora y calidad no", () => {
    expect(isExcludable("repentant_buyer", ["repentant"])).toBe(true);
    expect(isExcludable("bought_by_mistake")).toBe(true);
    expect(isExcludable("unauthorized_purchase")).toBe(true);
    expect(isExcludable("delivered_out_of_time", ["repentant"])).toBe(false);
    expect(isExcludable("not_expected_quality_repentant", ["repentant"])).toBe(false);
    expect(isExcludable("broken_item", ["defective"])).toBe(false);
  });

  it("fila desde la API, con alias cuando ML responde con otro id", () => {
    const r = reasonFromApi("PDD9939", PDD9939, null, true);
    expect(r).toMatchObject({
      id: "PDD9939",
      family: "PDD",
      title: "Llegó lo que compré en buenas condiciones pero no lo quiero",
      excludable: true,
      recommended: true,
      alias_of: null,
      active: true,
      source: "api",
    });
    expect(reasonFromApi("PDD9946", PDD9946, PDD9945).title).toBe("El producto está dañado: llegó bien");
    const alias = reasonFromApi("PNR3430", PNR9502);
    expect(alias.alias_of).toBe("PNR9502");
    expect(alias.title).toBe("El vendedor no me respondió");
  });
});

describe("fillReasons (acción reasons_fill)", () => {
  const api: Record<string, MlReasonApi> = { PDD9939, PDD9946, PDD9945, PNR3430: PNR9502 };
  const deps = (known: string[] = [], fail: string[] = []) => {
    const get = vi.fn(async (id: string) => {
      if (fail.includes(id)) throw new Error("rate_limited");
      return api[id] ?? null;
    });
    const save = vi.fn(async () => {});
    return { get, save, known: vi.fn(async () => new Set(known)) };
  };

  it("completa sólo los que faltan, con el padre si hace falta y 404 como desconocido", async () => {
    const d = deps(["PDD9939"]);
    const res = await fillReasons(["PDD9939", "pdd9946", "PNR3430", "PDD1234", "basura"], d);
    expect(res.filled).toEqual(["PDD9946", "PNR3430"]);
    expect(res.unknown).toEqual(["PDD1234"]);
    expect(res.pending).toEqual([]);
    expect(d.get.mock.calls.map((c) => c[0])).toEqual(["PDD9946", "PDD9945", "PNR3430", "PDD1234"]);
    const saved = d.save.mock.calls[0]![0] as Array<{ id: string; title: string; alias_of: string | null }>;
    expect(saved.find((r) => r.id === "PDD9946")?.title).toBe("El producto está dañado: llegó bien");
    expect(saved.find((r) => r.id === "PNR3430")?.alias_of).toBe("PNR9502");
  });

  it("un error de la API corta y deja el resto pendiente", async () => {
    const d = deps([], ["PDD9946"]);
    const res = await fillReasons(["PDD9939", "PDD9946", "PNR3430"], d);
    expect(res.filled).toEqual(["PDD9939"]);
    expect(res.pending).toEqual(["PDD9946", "PNR3430"]);
  });

  it("sin códigos válidos no consulta nada; tope por llamada", async () => {
    const d = deps();
    expect(await fillReasons(["", "x"], d)).toEqual({ filled: [], unknown: [], pending: [] });
    expect(d.known).not.toHaveBeenCalled();
    const many = Array.from({ length: 30 }, (_, i) => `PDD${1000 + i}`);
    await fillReasons(many, d);
    expect(d.get).toHaveBeenCalledTimes(FILL_MAX);
    expect(d.save).not.toHaveBeenCalled();
  });
});

const R = (id: string, title: string, over: Partial<ClaimReason> = {}): ClaimReason => ({
  id,
  family: reasonFamily(id),
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
  R("PDD9939", "Llegó lo que compré en buenas condiciones pero no lo quiero", { recommended: true, excludable: true }),
  R("PDD9502", "Me arrepentí de comprarlo", { recommended: true, excludable: true }),
  R("PDD9727", "Me arrepentí de comprarlo", { excludable: true, description: "Reclamo sin entrega confirmada." }),
  R("PNR9501", "Me arrepentí de la compra", { recommended: true, excludable: true }),
  R("PDD9946", "El producto está dañado: llegó bien"),
  R("CS9527", "Tuve problemas con el envío: otro", { active: false }),
];

describe("claimReasons (UI)", () => {
  it("busca sin acentos, por todas las palabras, en código, título y descripción", () => {
    expect(searchReasons(rows, "arrepenti").map((r) => r.id)).toEqual(["PDD9502", "PNR9501", "PDD9727"]);
    expect(searchReasons(rows, "sin entrega").map((r) => r.id)).toEqual(["PDD9727"]);
    expect(searchReasons(rows, "cs9527")[0]!.id).toBe("CS9527");
    expect(searchReasons(rows, "", { onlyExcludable: true }).every((r) => r.excludable)).toBe(true);
    expect(searchReasons(rows, "", { limit: 2 })).toHaveLength(2);
  });

  it("el código exacto va primero", () => {
    expect(searchReasons(rows, "PDD9727")[0]!.id).toBe("PDD9727");
  });

  it("agrupa por tipo en orden y sin grupos vacíos", () => {
    const g = groupByFamily(rows);
    expect(g.map((x) => x.label)).toEqual(["Producto distinto o defectuoso", "Producto no recibido", "Cancelación de la venta"]);
    expect(groupByFamily(rows.filter((r) => r.family === "PNR")).map((x) => x.family)).toEqual(["PNR"]);
  });

  it("título para mostrar y faltantes", () => {
    const idx = indexReasons(rows);
    expect(reasonTitleOf(idx, "pdd9502")).toBe("Me arrepentí de comprarlo");
    expect(reasonTitleOf(idx, "PNR1111")).toBe("Producto no recibido");
    expect(reasonTitleOf(idx, "ZZ123")).toBe("Otro motivo");
    expect(reasonTitleOf(idx, null)).toBe("Sin motivo");
    expect(missingReasons(idx, ["PDD9502", "pnr1111", null, "PNR1111", "nada"])).toEqual(["PNR1111"]);
    expect(missingReasons(undefined, ["PNR1111"])).toEqual([]);
  });
});

describe("seed de la migración 20261214100000", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261214100000_ml_claim_reasons.sql"), "utf8");
  const ids = [...sql.matchAll(/^\s+\('([A-Z]{2,4}\d{3,5})', '(PDD|PNR|CS|OTRO)'/gm)].map((m) => m[1]!);

  it("622 motivos sin repetir, con los 4 recomendados y los alias", () => {
    expect(ids).toHaveLength(622);
    expect(new Set(ids).size).toBe(622);
    for (const id of ["PDD9939", "PNR9501", "PDD9502", "PDD9829", "PNR3430"]) expect(ids).toContain(id);
    expect(sql).toMatch(/'PNR3430', 'PNR', 'El vendedor no me respondió'.*'PNR9502'/);
  });

  it("lectura authenticated, sin escritura fuera de service_role, sin em dash", () => {
    expect(sql).toMatch(/for select to authenticated using \(true\)/);
    expect(sql).toMatch(/revoke all on ml_claim_reasons from anon, authenticated/);
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/);
    expect(sql).not.toMatch(/—/);
  });
});
