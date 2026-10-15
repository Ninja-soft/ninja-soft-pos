// =============================================================================
// ADR-136 · remitos de entrega y de envío con COT: espejos de la config y del
// aviso de COT contra el SQL, numeración, formulario, payload, errores y
// contratos de la migración y de la Edge.
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMITO_CONFIG,
  cotRequired,
  cotValid,
  cuitValid,
  dateAr,
  normalizeCuit,
  remitoConfig,
  remitoErrorMessage,
  remitoFileName,
  remitoFormErrors,
  remitoIssuePayload,
  remitoNumberLabel,
  remitoTotals,
  type RemitoFormInput,
} from "@/lib/remitos/logic";
import { cotProviderFor } from "@/lib/remitos/cot";
import { remitoPages, REMITO_ROWS_FIRST, REMITO_ROWS_NEXT } from "@/components/remitos/RemitoDocument";

const MIG = readFileSync(join(process.cwd(), "supabase", "migrations", "20261202100200_remitos.sql"), "utf8");
const EDGE = readFileSync(join(process.cwd(), "supabase", "functions", "send_receipt_email", "index.ts"), "utf8");
const CODE = MIG.replace(/--.*$/gm, "");

const form = (p: Partial<RemitoFormInput> = {}): RemitoFormInput => ({
  kind: "entrega",
  receiver_name: "",
  receiver_doc: "",
  receiver_address: "",
  delivery_address: "",
  packages: "1",
  weight_kg: "",
  declared_value: "",
  carrier_name: "",
  carrier_cuit: "",
  vehicle_plate: "",
  driver_name: "",
  cot_number: "",
  cot_jurisdiction: "pba",
  cot_valid_until: "",
  notes: "",
  show_prices: false,
  ...p,
});

describe("ADR-136 · configuración de remitos (espejo de remito_config)", () => {
  it("defaults", () => {
    expect(remitoConfig(null)).toEqual(DEFAULT_REMITO_CONFIG);
    expect(remitoConfig({ cot_jurisdiction: "marte", show_prices: "x" })).toEqual(DEFAULT_REMITO_CONFIG);
  });
  it("umbral con hasta 2 decimales; jurisdicción y leyenda", () => {
    expect(remitoConfig({ cot_threshold: "1500000.50", cot_jurisdiction: "caba", show_prices: true, legend: "  Hola  " })).toEqual({
      cot_threshold: 1500000.5,
      cot_jurisdiction: "caba",
      show_prices: true,
      legend: "Hola",
    });
    expect(remitoConfig({ cot_threshold: "1,5" }).cot_threshold).toBeNull();
    expect(remitoConfig({ cot_threshold: 200 }).cot_threshold).toBe(200);
  });
  it("el SQL usa el mismo patrón de umbral y defaults", () => {
    expect(MIG).toContain(`'^[0-9]{1,12}(\\.[0-9]{1,2})?$'`);
    expect(MIG).toMatch(/else 'pba' end/);
  });
});

describe("ADR-136 · aviso de COT (espejo de remito_cot_required)", () => {
  // Casos SQL: threshold not null and coalesce(j, 'pba') in ('pba','caba') and value >= threshold.
  const cases: [number | null, "pba" | "caba" | "otra" | null, number, boolean][] = [
    [null, "pba", 1e9, false],
    [100, "pba", 100, true],
    [100, "caba", 99.99, false],
    [100, "caba", 101, true],
    [100, "otra", 1e9, false],
    [100, null, 100, true],
  ];
  it.each(cases)("umbral %s · %s · %s → %s", (t, j, v, out) => {
    expect(cotRequired(t, j, v)).toBe(out);
  });
  it("SQL equivalente", () => {
    expect(CODE).toMatch(/p_threshold is not null\s+and coalesce\(p_jurisdiction, 'pba'\) in \('pba', 'caba'\)\s+and coalesce\(p_value, 0\) >= p_threshold/);
  });
  it("hoy el COT es manual (hook para ARBA pendiente)", () => {
    expect(cotProviderFor("pba").key).toBe("manual");
    expect(CODE).toContain("'arba_ws'");
  });
});

describe("ADR-136 · numeración, validación y payload", () => {
  it("número del punto de venta interno", () => {
    expect(remitoNumberLabel(1, 12)).toBe("0001-00000012");
    expect(remitoFileName({ pto_vta: 3, number: 7 })).toBe("remito-0003-00000007.pdf");
  });
  it("COT y CUIT con el mismo formato que el servidor", () => {
    expect(cotValid("")).toBe(true);
    expect(cotValid("12")).toBe(false);
    expect(cotValid("1234567890123456")).toBe(true);
    expect(cotValid("COT-ABC 1")).toBe(false);
    expect(CODE).toContain("'^[0-9A-Za-z-]{6,40}$'");
    expect(normalizeCuit("30-50000000-1")).toBe("30500000001");
    expect(cuitValid("30-50000000-1")).toBe(true);
    expect(cuitValid("123")).toBe(false);
    expect(cuitValid("")).toBe(true);
  });
  it("errores del formulario", () => {
    expect(remitoFormErrors(form())).toEqual([]);
    expect(remitoFormErrors(form({ packages: "0" }))).toContain("Los bultos van de 1 a 9999.");
    expect(remitoFormErrors(form({ kind: "envio" }))).toContain("Cargá el domicilio de entrega.");
    expect(remitoFormErrors(form({ cot_number: "x" }))).toContain("El COT va con 6 a 40 letras, números o guiones.");
  });
  it("payload de remito_issue", () => {
    const p = remitoIssuePayload(
      { dispatchId: "d1", saleId: "s1" },
      form({ receiver_name: " Ana ", declared_value: "1.500,5".replace(".", ""), carrier_cuit: "30-50000000-1", cot_number: "1234567890" }),
    );
    expect(p).toMatchObject({ dispatch_id: "d1", kind: "entrega", receiver_name: "Ana", declared_value: 1500.5, carrier_cuit: "30500000001", cot_number: "1234567890", cot_jurisdiction: "pba", packages: 1 });
    expect(p).not.toHaveProperty("sale_id");
    expect(remitoIssuePayload({ dispatchId: null, saleId: "s1" }, form())).toMatchObject({ sale_id: "s1", declared_value: null });
  });
  it("totales, fecha en hora de Argentina y hojas", () => {
    expect(remitoTotals([{ qty: 2, unit_price: 100 }, { qty: 1.5, unit_price: null }])).toEqual({ units: 3.5, value: 200 });
    expect(dateAr("2026-10-15T02:30:00Z")).toBe("14/10/2026");
    expect(dateAr("2026-12-01")).toBe("01/12/2026");
    expect(remitoPages(3)).toEqual([[0, 3]]);
    expect(remitoPages(REMITO_ROWS_FIRST + REMITO_ROWS_NEXT + 1)).toEqual([
      [0, REMITO_ROWS_FIRST],
      [REMITO_ROWS_FIRST, REMITO_ROWS_FIRST + REMITO_ROWS_NEXT],
      [REMITO_ROWS_FIRST + REMITO_ROWS_NEXT, REMITO_ROWS_FIRST + REMITO_ROWS_NEXT + 1],
    ]);
  });
  it("errores del servidor en criollo", () => {
    expect(remitoErrorMessage(new Error('duplicate key value violates unique constraint "remitos_dispatch_active_key"'))).toMatch(/ya tiene un remito vigente/);
    expect(remitoErrorMessage({ message: "void_requires_manager" })).toMatch(/dueño o encargado/);
    expect(remitoErrorMessage("feature_not_in_plan: entregas_remitos")).toBe("Tu plan no incluye remitos.");
  });
});

describe("ADR-136 · contratos de la migración y de la Edge", () => {
  it("gating, RLS y sin escritura por REST", () => {
    expect(CODE).toContain("tenant_has_feature_for(v_tenant, 'entregas_remitos')");
    expect(CODE).not.toMatch(/is_internal\(\)/);
    for (const t of ["remitos", "remito_items"]) {
      expect(CODE).toMatch(new RegExp(`create policy ${t}_branch_scope on ${t}\\s+as restrictive`));
      expect(CODE).toContain(`revoke all on ${t} from anon, authenticated;`);
    }
    expect(CODE).toMatch(/create policy remitos_select on remitos\s+for select using \(tenant_id = \(select current_tenant_id\(\)\) or \(select internal_scope\(\)\)\)/);
    expect(CODE).not.toMatch(/create policy \w+ on \w+\s+for (insert|update|delete)/i);
  });
  it("un remito vigente por entrega y número correlativo con lock", () => {
    expect(CODE).toMatch(/remitos_dispatch_active_key on remitos\(dispatch_id\)\s+where dispatch_id is not null and status = 'emitido'/);
    expect(CODE).toContain("pg_advisory_xact_lock(hashtext('remito_number:' || v_tenant::text))");
  });
  it("auditoría de emitir, COT, editar, anular y configurar", () => {
    for (const a of ["remito_issued", "remito_cot_set", "remito_updated", "remito_voided", "remito_config_saved"]) expect(CODE).toContain(a);
    expect(EDGE).toContain('action: "remito_emailed"');
  });
  it("la Edge exige la feature y el acceso a la sucursal del remito", () => {
    expect(EDGE).toContain('p_key: "entregas_remitos"');
    expect(EDGE).toContain('rpc("user_can_access_store"');
  });
});
