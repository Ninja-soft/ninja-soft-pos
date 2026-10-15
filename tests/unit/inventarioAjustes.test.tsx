// =============================================================================
// ADR-137: Inventario que se entiende. Ajustes de stock con motivo y
// aprobación (regla del umbral, diferencia y valor), capacidades por miembro
// (espejo del SQL), importación de ajustes y conteos desde Excel (parseo con
// el motor único), planillas de stock y para contar, fecha de Argentina,
// contratos de la migración (gating, grants, sin is_internal) y la pestaña
// Ajustes (pendientes, aprobar, nadie aprueba lo propio).
// =============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ADJUST_REASONS,
  adjustDraftError,
  adjustmentDelta,
  adjustmentErrorMessage,
  adjustmentValue,
  approvalRuleText,
  needsApproval,
  type ApprovalPolicy,
} from "@/lib/stock/adjustments";
import {
  AUDITOR_PRESET,
  CAPABILITIES,
  CAPABILITY_KEYS,
  ROLE_CAPABILITIES,
  effectiveCapabilities,
  grantBlockedReason,
  hasCapability,
} from "@/lib/permissions/capabilities";
import {
  countSheetRows,
  fmtDateTimeAR,
  isLow,
  sheetName,
  stockSheet,
  stockSheetColumns,
  type StockSheetRow,
} from "@/lib/stock/inventorySheet";
import { parseImportGrid } from "@/lib/utils/xlsxImport";
import { buildPayloads, templateSheets } from "@/lib/import/engine";
import { importErrorMessage, importNoteMessage } from "@/lib/import/messages";
import {
  parseAdjustOp,
  parseAdjustReason,
  stockAdjustmentImportDefinition as def,
  type StockAdjustmentImportRow,
} from "@/modules/imports/stockAdjustments";
import { importDefinition } from "@/modules/imports/registry";
import { FEATURE_INFO } from "@/lib/saas/featureInfo";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");
const MAIN = readFileSync(join(MIG_DIR, "20261203100100_ajustes_stock_aprobacion.sql"), "utf8");
const FEAT = readFileSync(join(MIG_DIR, "20261203100000_features_ajustes_stock.sql"), "utf8");
const CODE = MAIN.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");

const policy = (over: Partial<ApprovalPolicy> = {}): ApprovalPolicy => ({
  approval_enabled: true,
  approver: "owner",
  threshold_units: null,
  threshold_value: null,
  require_photo: false,
  feature: true,
  ...over,
});

describe("regla de aprobación por umbral (espejo de stock_adjustment_needs_approval)", () => {
  it("apagada o sin la feature, nada espera", () => {
    expect(needsApproval(policy({ approval_enabled: false }), { role: "manager", units: 999, value: 1e9 })).toBe(false);
    expect(needsApproval(policy({ feature: false }), { role: "manager", units: 999, value: 1e9 })).toBe(false);
  });

  it("el dueño nunca espera", () => {
    expect(needsApproval(policy(), { role: "owner", units: 500, value: 1e6 })).toBe(false);
  });

  it("sin umbrales, todo lo de los demás espera", () => {
    expect(needsApproval(policy(), { role: "cashier", units: 1, value: 0 })).toBe(true);
  });

  it("umbral de unidades: desde, con el valor absoluto", () => {
    const p = policy({ threshold_units: 10 });
    expect(needsApproval(p, { role: "manager", units: 9, value: 0 })).toBe(false);
    expect(needsApproval(p, { role: "manager", units: 10, value: 0 })).toBe(true);
    expect(needsApproval(p, { role: "manager", units: -12, value: 0 })).toBe(true);
  });

  it("umbral de pesos o de unidades: alcanza con uno", () => {
    const p = policy({ threshold_units: 100, threshold_value: 50_000 });
    expect(needsApproval(p, { role: "manager", units: 3, value: -49_999.99 })).toBe(false);
    expect(needsApproval(p, { role: "manager", units: 3, value: -50_000 })).toBe(true);
    expect(needsApproval(p, { role: "manager", units: 100, value: 0 })).toBe(true);
  });

  it("el SQL tiene la misma regla", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function stock_adjustment_needs_approval("));
    expect(fn).toMatch(/coalesce\(p_role, ''\) <> 'owner'/);
    expect(fn).toMatch(/p_threshold_units is null and p_threshold_value is null/);
    expect(fn).toMatch(/abs\(coalesce\(p_units, 0\)\) >= p_threshold_units/);
    expect(fn).toMatch(/abs\(coalesce\(p_value, 0\)\) >= p_threshold_value/);
  });

  it("texto de la regla en criollo", () => {
    const t = approvalRuleText(policy({ approver: "auditor", threshold_units: 10 }), (n) => `$ ${n}`);
    expect(t).toContain("desde 10 unidades");
    expect(t).toContain("el dueño o un auditor");
    expect(approvalRuleText(policy({ approval_enabled: false }), String)).toMatch(/en el momento/);
  });
});

describe("diferencia, valor y formulario", () => {
  it("sumar, restar y fijar", () => {
    expect(adjustmentDelta("add", 5, 10)).toBe(5);
    expect(adjustmentDelta("remove", 3, 10)).toBe(-3);
    expect(adjustmentDelta("set", 7.5, 10)).toBe(-2.5);
    expect(adjustmentDelta("set", 10, 10)).toBe(0);
  });

  it("valor al costo con signo y sin costo = 0", () => {
    expect(adjustmentValue(-3, 100)).toBe(-300);
    expect(adjustmentValue(2, 33.335)).toBe(66.67);
    expect(adjustmentValue(4, null)).toBe(0);
  });

  it("motivo obligatorio, nota con Otro, cantidad válida y foto si va a aprobación", () => {
    const base = { mode: "remove" as const, qty: "2", reason: "rotura" as const, notes: "", hasPhoto: false };
    expect(adjustDraftError({ ...base, reason: null })).toMatch(/motivo/);
    expect(adjustDraftError({ ...base, qty: "" })).toMatch(/cantidad/);
    expect(adjustDraftError({ ...base, qty: "-1" })).toMatch(/positivo/);
    expect(adjustDraftError({ ...base, qty: "0" })).toMatch(/mayor a cero/);
    expect(adjustDraftError({ ...base, mode: "set", qty: "0" })).toBeNull();
    expect(adjustDraftError({ ...base, reason: "otro" })).toMatch(/nota/);
    expect(adjustDraftError({ ...base, qty: "1,5" })).toBeNull();
    expect(adjustDraftError(base, { photoRequired: true })).toMatch(/foto/);
    expect(adjustDraftError(base)).toBeNull();
  });

  it("los motivos del catálogo son los del check de la tabla", () => {
    const check = /reason\s+text not null check \(reason in \(([^)]*)\)\)/.exec(CODE)?.[1] ?? "";
    const sqlReasons = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlReasons).toEqual(ADJUST_REASONS.map((r) => r.value).sort());
  });

  it("errores del servidor en lenguaje simple", () => {
    expect(adjustmentErrorMessage({ message: "self_approval_forbidden" })).toMatch(/otra persona/);
    expect(adjustmentErrorMessage({ message: "forbidden_capability: stock.adjust" })).toMatch(/permiso/);
    expect(adjustmentErrorMessage({ message: "feature_not_in_plan: aprobacion_ajustes" })).toMatch(/plan/);
    expect(adjustmentErrorMessage({ message: "insufficient_warehouse_stock" })).toMatch(/depósito/);
  });
});

describe("capacidades por miembro (espejo de capability_role_default)", () => {
  it("el catálogo TS es el del SQL", () => {
    const arr = /array\[([^\]]*)\]::text\[\]/.exec(CODE)?.[1] ?? "";
    const sql = [...arr.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(sql).toEqual([...CAPABILITY_KEYS]);
    expect(CAPABILITIES.map((c) => c.key)).toEqual([...CAPABILITY_KEYS]);
  });

  it("lo que trae cada rol coincide con el SQL", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function capability_role_default("));
    for (const role of ["manager", "cashier", "viewer"] as const) {
      const line = new RegExp(`when p_role = '${role}' then p_cap in \\(([^)]*)\\)`, "s").exec(fn)?.[1] ?? "";
      const sql = [...line.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
      expect(sql, role).toEqual([...ROLE_CAPABILITIES[role]].sort());
    }
    expect(ROLE_CAPABILITIES.owner).toEqual(CAPABILITY_KEYS);
  });

  it("efectivas = rol + otorgadas; sin rol, nada", () => {
    expect(effectiveCapabilities("cashier", ["stock.adjust.approve"])).toEqual(["stock.view", "stock.adjust.approve"]);
    expect(hasCapability("manager", [], "stock.adjust.approve")).toBe(false);
    expect(hasCapability("owner", [], "stock.settings")).toBe(true);
    expect(effectiveCapabilities(null, ["stock.adjust"])).toEqual([]);
  });

  it("solo lectura no puede ser auditor ni ajustar; el dueño ya tiene todo", () => {
    expect(grantBlockedReason("viewer", "stock.adjust.approve")).toMatch(/Solo lectura/);
    expect(grantBlockedReason("viewer", "stock.export")).toBeNull();
    expect(grantBlockedReason("owner", "stock.adjust")).toMatch(/todos los permisos/);
    expect(grantBlockedReason("cashier", "stock.adjust.approve")).toBeNull();
    expect(AUDITOR_PRESET).toContain("stock.adjust.approve");
  });
});

// Grilla como la leería exceljs: encabezados de la plantilla + filas.
function grid(rows: string[][]): string[][] {
  const headers = def.fields({}).map((f) => f.header);
  return [headers, ...rows];
}
// Columnas: Sucursal, Depósito, Código dep., SKU, EAN, Producto, Sistema, Operación, Cantidad, Motivo, Nota.
const row = (o: Partial<Record<"sku" | "op" | "qty" | "reason" | "notes" | "wh", string>>) => [
  "Central", o.wh ?? "", "", o.sku ?? "", "", "Prod", "10", o.op ?? "", o.qty ?? "", o.reason ?? "", o.notes ?? "",
];

describe("importación de ajustes y conteos (motor único, ADR-078)", () => {
  const parse = (rows: string[][]) =>
    parseImportGrid<StockAdjustmentImportRow>(grid(rows), def.fields({}), {
      schema: def.schema?.({}),
      dedupeKey: def.dedupeKey,
    });

  it("está en el registro con su RPC", () => {
    expect(importDefinition("stock_adjustments").rpc).toBe("import_stock_adjustments");
  });

  it("operación y motivo por etiqueta; vacío = Fijar y Conteo", () => {
    expect(parseAdjustOp("Sumar")).toBe("add");
    expect(parseAdjustOp("-")).toBe("remove");
    expect(parseAdjustOp("Fijar cantidad")).toBe("set");
    expect(parseAdjustOp("")).toBe("set");
    expect(parseAdjustOp("mover")).toBeNull();
    expect(parseAdjustReason("Vencimiento")).toBe("vencimiento");
    expect(parseAdjustReason("Robo o faltante")).toBe("robo");
    expect(parseAdjustReason("error_carga")).toBe("error_carga");
    expect(parseAdjustReason("")).toBe("conteo");
    expect(parseAdjustReason("magia")).toBeNull();
  });

  it("previsualización por fila: ok o error con motivo", () => {
    const res = parse([
      row({ sku: "COCA", qty: "22" }),
      row({ sku: "YERBA", op: "Restar", qty: "2", reason: "Rotura" }),
      row({ sku: "", qty: "1" }),
      row({ sku: "MATE", op: "Restar", qty: "-3" }),
      row({ sku: "AZUCAR", op: "Sumar", qty: "0", reason: "Ingreso sin compra" }),
      row({ sku: "SAL", op: "Restar", qty: "1", reason: "Otro" }),
      row({ sku: "TE", op: "Mover", qty: "1" }),
      row({ sku: "CAFE" }),
      row({ sku: "COCA", qty: "21" }),
    ]);
    expect(res.fatalError).toBeNull();
    const [coca, yerba, sinCodigo, negativo, cero, otro, mover, vacio, dup] = res.rows;
    expect(coca!.errors).toEqual([]);
    expect(coca!.data.op).toBe("set");
    expect(coca!.data.reason).toBe("conteo");
    expect(yerba!.errors).toEqual([]);
    expect(yerba!.data).toMatchObject({ op: "remove", reason: "rotura", qty: 2 });
    expect(sinCodigo!.errors.join(" ")).toMatch(/SKU o el código de barras/);
    expect(negativo!.errors.join(" ")).toMatch(/Restar/);
    expect(cero!.errors.join(" ")).toMatch(/mayor a cero/);
    expect(otro!.errors.join(" ")).toMatch(/nota/);
    expect(mover!.errors.join(" ")).toMatch(/Sumar, Restar o Fijar/);
    expect(vacio!.errors).toEqual([]); // sin cantidad: el servidor la omite
    expect(vacio!.data.qty).toBeNull();
    expect(dup!.errors.join(" ")).toMatch(/repet|duplic/i);
  });

  it("al servidor no viajan las columnas de referencia", () => {
    const res = parse([row({ sku: "COCA", qty: "5" })]);
    const [p] = buildPayloads(def, res.rows);
    expect(p).not.toHaveProperty("product");
    expect(p).not.toHaveProperty("system_qty");
    expect(p).toMatchObject({ sku: "COCA", op: "set", qty: 5, reason: "conteo", _row: 2 });
  });

  it("notas y errores de las filas", () => {
    expect(importNoteMessage("pending_approval")).toMatch(/apruebe/);
    expect(importNoteMessage("no_qty")).toMatch(/no se toca/);
    expect(importErrorMessage("reason_notes_required")).toMatch(/nota/);
    expect(importErrorMessage("feature_not_in_plan: ajustes_stock")).toMatch(/ajustes de stock/);
  });

  it("la plantilla trae Instrucciones y listas desplegables", () => {
    const [data, help] = templateSheets(def, { stores: ["Central"], warehouses: ["Fondo"] });
    expect(data!.columns.find((c) => c.key === "op")?.options).toEqual(["Sumar", "Restar", "Fijar"]);
    expect(data!.columns.find((c) => c.key === "warehouse")?.options).toEqual(["Fondo"]);
    expect(help!.name).toBe("Instrucciones");
  });
});

const sheetRow = (over: Partial<StockSheetRow> = {}): StockSheetRow => ({
  product_id: "p1",
  variant_id: null,
  product_name: "Coca",
  variant_label: null,
  sku: "COCA",
  barcode: "779",
  image_url: null,
  unit: "un",
  category_name: "Bebidas",
  cost: 100,
  price: 200,
  store_qty: 10,
  min_qty: 12,
  max_qty: null,
  location: null,
  principal_qty: 6,
  by_warehouse: { w1: 4 },
  total_count: 1,
  ...over,
});

describe("planillas de stock y para contar", () => {
  const whs = [
    { id: "w0", name: "Salón", kind: "principal" },
    { id: "w1", name: "Fondo", kind: "reserva" },
  ];

  it("una columna por depósito y el costo sólo si se ve", () => {
    const withCost = stockSheetColumns(whs, true).map((c) => c.header);
    expect(withCost).toEqual(expect.arrayContaining(["SKU", "Código de barras", "Costo", "Stock sucursal", "Salón de ventas", "Fondo", "Valor al costo"]));
    const noCost = stockSheetColumns(whs, false).map((c) => c.header);
    expect(noCost).not.toContain("Costo");
    expect(noCost).not.toContain("Valor al costo");
    expect(stockSheetColumns([], true).map((c) => c.header)).not.toContain("Salón de ventas");
  });

  it("hoja con totales sin contar negativos", () => {
    const s = stockSheet({ id: "s", name: "Central" }, [sheetRow(), sheetRow({ product_id: "p2", store_qty: -2 })], whs, {
      showCost: true,
      generatedAt: "01/12/2026 10:00",
    });
    expect(s.totals).toEqual({ store_qty: 10, value: 1000 });
    expect(s.rows[0]).toMatchObject({ wh_w1: 4, principal_qty: 6, value: 1000 });
  });

  it("la planilla para contar sale en el formato de la importación", () => {
    const [r] = countSheetRows([sheetRow()], { label: "Central" }, whs[1]!);
    expect(r).toMatchObject({ store: "Central", warehouse: "Fondo", sku: "COCA", system_qty: 4, op: "Fijar", reason: "Conteo (inventario físico)", qty: null });
    const [all] = countSheetRows([sheetRow()], { label: "Central" });
    expect(all!.system_qty).toBe(10);
    // Y se vuelve a leer con el motor: sin cantidad no hay error.
    const g = grid([[String(r!.store), String(r!.warehouse), "", "COCA", "779", "Coca", "4", "Fijar", "", "Conteo (inventario físico)", ""]]);
    const parsed = parseImportGrid<StockAdjustmentImportRow>(g, def.fields({}), { schema: def.schema?.({}) });
    expect(parsed.rows[0]!.errors).toEqual([]);
    expect(parsed.rows[0]!.data.reason).toBe("conteo");
  });

  it("bajo el mínimo y nombres de hoja válidos", () => {
    expect(isLow(sheetRow())).toBe(true);
    expect(isLow(sheetRow({ min_qty: null }))).toBe(false);
    expect(sheetName("Stock Central/Norte: depósito [1] con nombre larguísimo")).toHaveLength(31);
    expect(sheetName("a/b")).toBe("a b");
  });

  it("fecha y hora de Argentina sin importar el huso del navegador", () => {
    // 02:30 UTC del 1/12 = 23:30 del 30/11 en Argentina.
    expect(fmtDateTimeAR("2026-12-01T02:30:00Z")).toBe("30/11/2026 23:30");
    expect(fmtDateTimeAR(null)).toBe("");
  });
});

describe("contratos de la migración (ADR-137)", () => {
  it("features: ajustes_stock BASE y aprobacion_ajustes OPTIONAL Pro+ con copy", () => {
    expect(FEAT).toMatch(/\('ajustes_stock',[\s\S]*?'catalogo', true, 71\)/);
    expect(FEAT).toMatch(/\('aprobacion_ajustes',[\s\S]*?'catalogo', false, 77\)/);
    expect(FEAT).toMatch(/'aprobacion_ajustes', \(p\.key in \('pro', 'business', 'enterprise'\)\)/);
    expect(FEATURE_INFO.ajustes_stock?.minPlan).toBe("Start");
    expect(FEATURE_INFO.aprobacion_ajustes?.minPlan).toBe("Pro");
    expect(FEATURE_INFO.aprobacion_ajustes?.requires).toEqual(["ajustes_stock"]);
  });

  it("gating real en el servidor", () => {
    expect(CODE).toMatch(/tenant_has_feature_for\(p_tenant, 'ajustes_stock'\)/);
    expect(CODE).toMatch(/v_enabled and not tenant_has_feature_for\(v_tenant, 'aprobacion_ajustes'\)/);
    expect(CODE).toMatch(/tenant_has_feature_for\(p_tenant, 'aprobacion_ajustes'\)\s*and stock_adjustment_needs_approval/);
    expect(CODE).toMatch(/_import_exec\('stock_adjustments', 'ajustes_stock'/);
  });

  it("nunca or is_internal() y lecturas con initplan", () => {
    expect(CODE).not.toMatch(/is_internal\(\)/);
    for (const m of CODE.matchAll(/create policy [\s\S]*?;/g)) {
      const bare = m[0].replace(/\(select [a-z_]+\(\)\)/g, "");
      expect(bare, m[0]).not.toMatch(/(current_tenant_id|internal_scope|user_allowed_store_ids|stock_my_role)\(\)/);
    }
    expect(CODE).toMatch(/tenant_id = \(select current_tenant_id\(\)\) or \(select internal_scope\(\)\)/);
  });

  it("sin escritura por REST y RPC con grants acotados", () => {
    for (const t of ["member_capabilities", "stock_adjustment_policy", "stock_adjustments"]) {
      expect(CODE).toMatch(new RegExp(`revoke insert, update, delete on ${t} from anon, authenticated`));
    }
    for (const fn of ["_stock_adjust_apply", "_stock_adjustment_request", "_import_stock_adjustments_run", "_stock_can_approve"]) {
      expect(CODE).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s+from public, anon, authenticated`));
    }
  });

  it("auditoría en cada acción crítica", () => {
    for (const action of [
      "stock_adjustment_requested",
      "stock_adjustment_applied",
      "stock_adjustment_approved",
      "stock_adjustment_rejected",
      "stock_adjustment_cancelled",
      "stock_adjustment_policy_updated",
      "capability_granted",
      "capability_revoked",
    ]) {
      expect(CODE, action).toContain(`'${action}'`);
    }
  });
});

// ── Pestaña Ajustes ─────────────────────────────────────────────────────────

const decide = vi.fn(async () => ({ status: "applied" }));
const ME = "user-auditor";
const pendingRows = [
  {
    id: "a1", store_id: "s1", store_name: "Central", warehouse_id: null, warehouse_name: null,
    product_id: "p1", variant_id: null, product_name: "Coca 500", variant_label: null, sku: "COCA",
    image_url: null, unit: "un", mode: "remove", qty: 12, reason: "robo", notes: "faltante", photo_path: null,
    system_qty: 30, delta: -12, unit_cost: 100, value: -1200, status: "pending", needs_approval: true,
    source: "manual", requested_by: "user-encargado", requested_by_name: "Ana", requested_at: "2026-12-01T13:00:00Z",
    decided_by: null, decided_by_name: null, decided_at: null, decision_notes: null, applied_delta: null, applied_at: null,
  },
  {
    id: "a2", store_id: "s1", store_name: "Central", warehouse_id: null, warehouse_name: null,
    product_id: "p2", variant_id: null, product_name: "Yerba 1 kg", variant_label: null, sku: "YER",
    image_url: null, unit: "un", mode: "remove", qty: 11, reason: "rotura", notes: null, photo_path: null,
    system_qty: 30, delta: -11, unit_cost: null, value: null, status: "pending", needs_approval: true,
    source: "manual", requested_by: ME, requested_by_name: "Yo", requested_at: "2026-12-01T13:05:00Z",
    decided_by: null, decided_by_name: null, decided_at: null, decision_notes: null, applied_delta: null, applied_at: null,
  },
  {
    id: "a3", store_id: "s1", store_name: "Central", warehouse_id: null, warehouse_name: null,
    product_id: "p3", variant_id: null, product_name: "Galletitas", variant_label: null, sku: "GAL",
    image_url: null, unit: "un", mode: "add", qty: 5, reason: "ingreso", notes: null, photo_path: null,
    system_qty: 0, delta: 5, unit_cost: 50, value: 250, status: "applied", needs_approval: false,
    source: "import", requested_by: "user-encargado", requested_by_name: "Ana", requested_at: "2026-11-30T15:00:00Z",
    decided_by: null, decided_by_name: null, decided_at: null, decision_notes: null, applied_delta: 5, applied_at: "2026-11-30T15:00:00Z",
  },
];

vi.mock("@/modules/stock/adjustments", () => ({
  useAdjustmentPolicy: () => ({
    data: { approval_enabled: true, approver: "auditor", threshold_units: 10, threshold_value: null, require_photo: false, feature: true },
  }),
  useStockAdjustments: () => ({ data: pendingRows, isLoading: false }),
  useAdjustmentMutations: () => ({
    decide: { mutateAsync: decide, isPending: false, variables: undefined },
    decideMany: { mutateAsync: vi.fn(), isPending: false },
    cancel: { mutateAsync: vi.fn() },
    savePolicy: { mutateAsync: vi.fn(), isPending: false },
    setCapability: { mutateAsync: vi.fn(), isPending: false },
  }),
  useCapabilityMembers: () => ({ data: [] }),
  useAdjustmentPhotoUrl: () => ({ data: null, isLoading: false }),
}));
vi.mock("@/modules/stock/hooks", () => ({ useCurrentUserId: () => ({ data: ME }) }));

import { ToastProvider } from "@/components/ui/Toast";
import { AdjustmentsTab } from "@/components/stock/inventory/AdjustmentsTab";

describe("pestaña Ajustes", () => {
  const renderTab = (role: string, canApproveCap: boolean) =>
    render(
      <ToastProvider>
        <AdjustmentsTab
          storeId="s1"
          role={role}
          canAdjust
          canApproveCap={canApproveCap}
          canConfigure={false}
          onNew={() => undefined}
        />
      </ToastProvider>,
    );

  it("el auditor ve los pendientes, aprueba el ajeno y no el propio", async () => {
    renderTab("cashier", true);
    expect(screen.getByText("Esperando aprobación (2)")).toBeTruthy();
    expect(screen.getByText(/desde 10 unidades/)).toBeTruthy();
    const approveButtons = screen.getAllByRole("button", { name: /^Aprobar$/ });
    expect(approveButtons).toHaveLength(1);
    expect(screen.getByText(/Lo pediste vos/)).toBeTruthy();
    fireEvent.click(approveButtons[0]!);
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ id: "a1", approve: true }));
  });

  it("sin permiso de auditor no hay botones de aprobar", () => {
    renderTab("manager", false);
    expect(screen.queryAllByRole("button", { name: /^Aprobar$/ })).toHaveLength(0);
    // Historial con motivo, origen Excel y quién lo pidió.
    expect(screen.getByText("Galletitas")).toBeTruthy();
    expect(screen.getByText("Excel")).toBeTruthy();
    expect(screen.getAllByText(/Pidió Ana/).length).toBeGreaterThan(0);
  });
});
