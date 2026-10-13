// @vitest-environment node
// scripts/db-audit-perf.mjs (ADR-090): parser de migraciones y reglas de la
// auditoría estática de rendimiento.
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Finding = { code: string; severity: string; table: string | null; object: string; detail: string; file?: string };
type AuditMod = {
  splitStatements: (sql: string) => { sql: string; line: number }[];
  bareCalls: (expr: string, funcs: string[], lit?: string[]) => string[];
  wrapCall: (expr: string, fn: string) => string;
  auditMigrations: (dir: string, opts?: { before?: string; allTables?: boolean }) => { files: number; findings: Finding[] };
};

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
let mod: AuditMod;

beforeAll(async () => {
  const url = pathToFileURL(path.join(ROOT, "scripts", "db-audit-perf.mjs")).href;
  mod = (await import(/* @vite-ignore */ url)) as AuditMod;
});

describe("db-audit-perf · lexer y helpers", () => {
  it("parte sentencias respetando dollar quotes, strings y comentarios", () => {
    const sql = `
      -- comentario; con punto y coma
      create function f() returns int language sql as $$ select 1; $$;
      insert into t values ('a;b');
      /* bloque; */ select 2;
    `;
    const out = mod.splitStatements(sql).map((s) => s.sql);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("$$ select 1; $$");
    expect(out[1]).toContain("'a;b'");
  });

  it("detecta llamadas sueltas y respeta las envueltas", () => {
    const expr = "tenant_id = (select current_tenant_id()) or internal_scope() or (select auth.uid()) is null";
    expect(mod.bareCalls(expr, ["current_tenant_id", "internal_scope", "auth.uid"])).toEqual(["internal_scope"]);
    expect(mod.bareCalls("tax_can_write('x'::text)", [], ["tax_can_write"])).toEqual(["tax_can_write"]);
    expect(mod.wrapCall("a = current_tenant_id() and b = (select current_tenant_id())", "current_tenant_id")).toBe(
      "a = (select current_tenant_id()) and b = (select current_tenant_id())",
    );
  });
});

describe("db-audit-perf · migraciones del repo", () => {
  const blocking = (fs: Finding[]) =>
    fs.filter((f) => ["P1", "P2", "P4", "P5", "P6"].includes(f.code) && f.severity !== "low");

  it("antes de 20261108500000 encuentra los problemas que la migración corrige", () => {
    const res = mod.auditMigrations(MIGRATIONS, { before: "20261108500000" });
    const codes = new Set(blocking(res.findings).map((f) => f.code));
    expect(codes.has("P1")).toBe(true);
    expect(codes.has("P5")).toBe(true);
    expect(codes.has("P6")).toBe(true);
    expect(res.findings.some((f) => f.code === "P5" && f.object.startsWith("fiscal_documents(caea_id)"))).toBe(true);
    expect(res.findings.some((f) => f.code === "P1" && f.object === "sales_branch_scope")).toBe(true);
  });

  it("con todas las migraciones no quedan hallazgos P1, P2, P4, P5, P6 ni P7 en las tablas grandes", () => {
    const res = mod.auditMigrations(MIGRATIONS);
    expect(blocking(res.findings).map((f) => `${f.code} ${f.object}`)).toEqual([]);
    expect(res.findings.filter((f) => f.code === "P7").map((f) => f.object)).toEqual([]);
  });

  it("ADR-093: antes de 20261108600000 create_sale y return_sale_v2 insertaban sin tenant_id (P8)", () => {
    const res = mod.auditMigrations(MIGRATIONS, { before: "20261108600000" });
    const p8 = res.findings.filter((f) => f.code === "P8").map((f) => f.object);
    expect(p8).toContain("create_sale() insert into sales");
    expect(p8).toContain("create_sale() insert into sale_items");
    expect(p8).toContain("create_sale() insert into payments");
    expect(p8).toContain("create_sale() insert into stock_movements");
    expect(p8).toContain("return_sale_v2() insert into sale_returns");
  });

  it("ADR-093: con todas las migraciones las RPC calientes pasan tenant_id en cada insert", () => {
    const res = mod.auditMigrations(MIGRATIONS);
    expect(res.findings.filter((f) => f.code === "P8").map((f) => `${f.object} (${f.file})`)).toEqual([]);
  });
});
