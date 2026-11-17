// @vitest-environment node
// scripts/migration-repair-plan.mjs (SEC-01): cruce del historial remoto con
// supabase/migrations por nombre y plan de repair.
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Mig = { version: string; name: string; file: string };
type Remote = { version: string; name: string | null };
type Plan = {
  counts: Record<string, number>;
  reverted: string[];
  applied: string[];
  repoWithoutExactRemote: string[];
  remoteWithoutExactRepo: string[];
  unknownRemote: string[];
  unverified: string[];
  extraRemote: string[];
};
type Mod = {
  normalizeName: (n: string | null) => string;
  buildRepairPlan: (repo: Mig[], remote: Remote[], opts?: { includeUnverified?: boolean }) => Plan;
  repairCommands: (p: Plan) => string[];
  repairSql: (p: Plan, repo: Mig[], backup?: string) => string;
  chunk: <T>(a: T[], n?: number) => T[][];
};
type DC = {
  parseMigrations: (files: string[]) => { list: Mig[] };
  parseApplied: (t: string) => Remote[];
};

const ROOT = path.resolve(__dirname, "..", "..");
let mod: Mod;
let dc: DC;

beforeAll(async () => {
  const load = (f: string) => import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", f)).href);
  mod = (await load("migration-repair-plan.mjs")) as Mod;
  dc = (await load("deploy-check.mjs")) as DC;
});

const repoOf = (files: string[]) => dc.parseMigrations(files).list;

describe("migration-repair-plan", () => {
  it("normaliza el prefijo numérico que tienen algunos nombres remotos", () => {
    expect(mod.normalizeName("20260608270000_owner_subscription_panel")).toBe("owner_subscription_panel");
    expect(mod.normalizeName("Coupons")).toBe("coupons");
    expect(mod.normalizeName(null)).toBe("");
  });

  it("cruza por nombre: todo el remoto reverted, todo el repo applied", () => {
    const repo = repoOf(["20260530120000_extensions_and_helpers.sql", "20260608270000_owner_subscription_panel.sql"]);
    const remote = dc.parseApplied(
      ["20260530151614 extensions_and_helpers", "20260608013101 20260608270000_owner_subscription_panel"].join("\n"),
    );
    const p = mod.buildRepairPlan(repo, remote);
    expect(p.counts.matchedByName).toBe(2);
    expect(p.reverted).toEqual(["20260530151614", "20260608013101"]);
    expect(p.applied).toEqual(["20260530120000", "20260608270000"]);
    expect(p.unknownRemote).toEqual([]);
    expect(p.unverified).toEqual([]);
  });

  it("reconoce las fusiones conocidas y las huérfanas de verificación", () => {
    const repo = repoOf(["20260608720000_delivery_orders.sql", "20260608560000_service_packs.sql"]);
    const remote = dc.parseApplied(
      [
        "20260609042214 delivery_orders_p1_schema",
        "20260609042306 delivery_orders_p2_rpcs",
        "20260608202106 service_packs_tables_and_rpc",
        "20260609063626 verify_delivery_files_parse",
        "20260609063752 verify_create_sale_file_parse",
        "20260601000000 algo_que_no_existe",
      ].join("\n"),
    );
    const p = mod.buildRepairPlan(repo, remote);
    expect(p.counts.merged).toBe(3);
    expect(p.counts.orphan).toBe(2);
    expect(p.unknownRemote).toEqual(["20260601000000 algo_que_no_existe"]);
    expect(p.repoWithoutExactRemote.sort()).toEqual(["20260608560000_service_packs.sql", "20260608720000_delivery_orders.sql"]);
    expect(p.remoteWithoutExactRepo).toHaveLength(6);
    expect(p.unverified).toEqual([]);
  });

  it("acepta versiones con hora 'inválida' y no revierte la versión que coincide con su nombre", () => {
    const repo = repoOf(["20260531240000_ticket_h9.sql", "20260608750001_delivery_rpc_parity_guards.sql"]);
    const remote = dc.parseApplied(
      ["20260531240000 ticket_h9", "20260609062026 20260608750001_delivery_rpc_parity_guards"].join("\n"),
    );
    const p = mod.buildRepairPlan(repo, remote);
    expect(p.counts.matchedByVersion).toBe(1);
    expect(p.counts.matchedByName).toBe(1);
    expect(p.reverted).toEqual(["20260609062026"]);
    expect(p.applied).toEqual(["20260608750001"]);
  });

  it("una versión remota igual a la del repo pero con otro nombre es desconocida", () => {
    const repo = repoOf(["20260601000000_coupons.sql"]);
    const p = mod.buildRepairPlan(repo, dc.parseApplied("20260601000000 otra_cosa"));
    expect(p.unknownRemote).toEqual(["20260601000000 otra_cosa"]);
    expect(p.reverted).toEqual([]);
    expect(p.applied).toEqual([]);
  });

  it("las filas extra conocidas no bloquean pero se listan", () => {
    const repo = repoOf(["20260608100000_onboarding_status.sql"]);
    const p = mod.buildRepairPlan(
      repo,
      dc.parseApplied(["20260607180437 onboarding_status", "20260607180501 onboarding_status_v2"].join("\n")),
    );
    expect(p.unknownRemote).toEqual([]);
    expect(p.extraRemote).toEqual(["20260607180501 onboarding_status_v2"]);
  });

  it("los archivos sin fila remota quedan fuera del plan salvo con includeUnverified", () => {
    const repo = repoOf(["20260530120000_vieja.sql", "20261011120000_nueva.sql"]);
    const remote = dc.parseApplied("20260530151614 vieja");
    const safe = mod.buildRepairPlan(repo, remote);
    expect(safe.unverified).toEqual(["20261011120000_nueva.sql"]);
    expect(safe.applied).toEqual(["20260530120000"]);
    const all = mod.buildRepairPlan(repo, remote, { includeUnverified: true });
    expect(all.applied).toEqual(["20260530120000", "20261011120000"]);
    expect(all.counts.expectedRowsAfter).toBe(2);
  });

  it("emite comandos en tandas de 50 (reverted antes que applied) y SQL transaccional con backup y control", () => {
    const files = Array.from({ length: 120 }, (_, i) => `20270101${String(100000 + i).padStart(6, "0")}_m${i}.sql`);
    const repo = repoOf(files);
    const remote = dc.parseApplied(
      [
        ...Array.from({ length: 60 }, (_, i) => `2026010${Math.floor(i / 10)}0000${String(i % 10).padStart(2, "0")} m${i}`),
      ].join("\n"),
    );
    const p = mod.buildRepairPlan(repo, remote);
    const cmds = mod.repairCommands(p);
    expect(cmds[0]).toBe("set -euo pipefail");
    const rev = cmds.findIndex((c) => c.includes("--status reverted"));
    const app = cmds.findIndex((c) => c.includes("--status applied"));
    expect(rev).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(rev);
    expect(cmds.filter((c) => c.includes("--status reverted"))).toHaveLength(2);
    expect(p.applied).toHaveLength(60);
    expect(cmds.filter((c) => c.includes("--status applied"))).toHaveLength(2);

    const sql = mod.repairSql(p, repo, "schema_migrations_bak_20261117");
    expect(sql.startsWith("begin;\ncreate table supabase_migrations.schema_migrations_bak_20261117 as table")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).not.toContain("on conflict");
    expect(sql).toContain(`<> ${p.counts.expectedRowsAfter} then`);
    expect(sql).toContain("('20270101100000', 'm0', null)");
    expect(() => mod.repairSql(p, repo, "x; drop table y")).toThrow();
    expect(mod.chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});
