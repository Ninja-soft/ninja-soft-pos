// @vitest-environment node
// scripts/security/grants-migration.mjs (SEC-07): objetivo y SQL de grants explícitos.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type T = { name: string; kind: string; rls: boolean; policies: number; anon: string; authenticated: string };
type Snap = { tables: T[]; functions: unknown[] };
type Mod = { toTarget: (s: Snap) => Snap; migrationSql: (s: Snap) => string };

const ROOT = path.resolve(__dirname, "..", "..");
let mod: Mod;
beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", "security", "grants-migration.mjs")).href)) as Mod;
});

const snap = (tables: T[]): Snap => ({ tables, functions: [] });

describe("grants-migration", () => {
  it("objetivo: anon sin escritura y tablas sin policy sin grants; vistas intactas", () => {
    const out = mod.toTarget(
      snap([
        { name: "sales", kind: "r", rls: true, policies: 2, anon: "siud", authenticated: "siud" },
        { name: "secrets", kind: "r", rls: true, policies: 0, anon: "siud", authenticated: "siud" },
        { name: "v_saldos", kind: "v", rls: false, policies: 0, anon: "", authenticated: "siud" },
      ]),
    );
    expect(out.tables.map((t) => [t.name, t.anon, t.authenticated])).toEqual([
      ["sales", "s", "siud"],
      ["secrets", "", ""],
      ["v_saldos", "", "siud"],
    ]);
  });

  it("SQL: revoke + grant exacto por tabla, sin grant masivo a anon ni authenticated", () => {
    const sql = mod.migrationSql(
      snap([
        { name: "sales", kind: "r", rls: true, policies: 2, anon: "s", authenticated: "siud" },
        { name: "secrets", kind: "r", rls: true, policies: 0, anon: "", authenticated: "" },
      ]),
    );
    expect(sql).toContain("revoke all on table public.sales from anon, authenticated;");
    expect(sql).toContain("grant select on table public.sales to anon;");
    expect(sql).toContain("grant select, insert, update, delete on table public.sales to authenticated;");
    expect(sql).toContain("revoke all on table public.secrets from anon, authenticated;");
    expect(sql).not.toMatch(/grant [^;]* on table public\.secrets/);
    expect(sql).not.toMatch(/on all tables in schema public to (anon|authenticated)/);
    expect(sql).toContain("grant all on all tables in schema public to service_role;");
    expect(sql).toContain("revoke insert, update, delete, truncate, references, trigger on tables from anon;");
  });

  it("la migración commiteada coincide con grants.expected.json (regenerar si cambia)", () => {
    const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security", "grants.expected.json"), "utf8")) as Snap;
    const file = fs.readdirSync(path.join(ROOT, "supabase", "migrations")).find((f) => f.endsWith("_explicit_data_api_grants.sql"));
    expect(file).toBeDefined();
    const committed = fs.readFileSync(path.join(ROOT, "supabase", "migrations", file!), "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(mod.migrationSql(expected));
    expect(expected.tables.filter((t) => /[iud]/.test(t.anon))).toEqual([]);
  });
});
