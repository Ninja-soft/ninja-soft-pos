// @vitest-environment node
// =============================================================================
// Paridad de grants del Data API (SEC-06): la base local de CI contra el
// estado objetivo `supabase/security/grants.expected.json` (al empezar, igual
// a la foto de prod `grants.prod.json`).
//
// Corre la misma consulta que `pnpm security:snapshot` con psql contra
// DB_URL (lo exporta `supabase status -o env` en el job `rls`). Sin DB_URL o
// sin psql, se salta. NUNCA apuntar DB_URL a producción.
//
// Modo: hoy local (auto_expose_new_tables) y prod difieren, así que el test
// imprime el diff legible y sólo falla con GRANTS_PARITY_STRICT=1. SEC-07 lo
// pasa a estricto cuando los grants queden explícitos.
// =============================================================================
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Snap = { tables: Record<string, unknown>[]; functions: Record<string, unknown>[] };
type Diff = { kind: string; object: string; field: string; expected: unknown; actual: unknown };
type Mod = {
  snapshotViaPsql: (dbUrl: string) => Snap;
  diffSnapshots: (expected: Snap, actual: Snap) => Diff[];
  formatDiff: (d: Diff[], max?: number) => string;
};

const ROOT = path.resolve(__dirname, "..", "..");
const DB_URL = process.env.DB_URL;
const isLocal = (() => {
  try {
    return ["127.0.0.1", "localhost", "host.docker.internal"].includes(new URL(DB_URL ?? "").hostname);
  } catch {
    return false;
  }
})();
const hasPsql = (() => {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const enabled = Boolean(DB_URL && isLocal && hasPsql);
const strict = process.env.GRANTS_PARITY_STRICT === "1";

let mod: Mod;
beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", "security", "grants-snapshot.mjs")).href)) as Mod;
});

const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security", f), "utf8")) as Snap;

describe("grants · foto commiteada", () => {
  it("grants.prod.json y grants.expected.json existen y tienen tablas y funciones", () => {
    for (const f of ["grants.prod.json", "grants.expected.json"]) {
      const s = readJson(f);
      expect(s.tables.length, f).toBeGreaterThan(100);
      expect(s.functions.length, f).toBeGreaterThan(100);
    }
  });

  it("el diff entre dos fotos es legible", () => {
    const a = { tables: [{ name: "t", kind: "r", rls: true, policies: 1, anon: "s", authenticated: "siud" }], functions: [] };
    const b = { tables: [{ name: "t", kind: "r", rls: true, policies: 1, anon: "siud", authenticated: "siud" }], functions: [] };
    const d = mod.diffSnapshots(a, b);
    expect(d).toEqual([
      { kind: "tables", object: "t", field: "anon INSERT", expected: false, actual: true },
      { kind: "tables", object: "t", field: "anon UPDATE", expected: false, actual: true },
      { kind: "tables", object: "t", field: "anon DELETE", expected: false, actual: true },
    ]);
    expect(mod.formatDiff(d).split("\n")[0]).toBe("tables.t anon INSERT: esperado=false actual=true");
  });
});

describe.skipIf(!enabled)("grants · paridad local contra el estado esperado", () => {
  it(`la base local coincide con grants.expected.json${strict ? " (estricto)" : " (informativo)"}`, () => {
    let actual: Snap;
    try {
      actual = mod.snapshotViaPsql(DB_URL!);
    } catch (e) {
      // Informativo: un error de conexión o de SQL no tumba el job hasta SEC-07.
      console.warn(`[grants-parity] no se pudo sacar la foto local: ${e instanceof Error ? e.message : String(e)}`);
      if (strict) throw e;
      return;
    }
    const expected = readJson("grants.expected.json");
    const diff = mod.diffSnapshots(expected, actual);
    if (diff.length) {
      console.warn(`[grants-parity] ${diff.length} diferencias contra grants.expected.json:\n${mod.formatDiff(diff, 80)}`);
    }
    expect(actual.tables.length).toBeGreaterThan(100);
    if (strict) expect(diff, mod.formatDiff(diff, 50)).toEqual([]);
  });
});

describe.skipIf(enabled || !process.env.CI)("grants · paridad salteada en CI", () => {
  it("avisa que no hubo control de paridad", () => {
    console.warn(`[grants-parity] SALTEADO en CI: DB_URL=${DB_URL ? "sí" : "no"} local=${isLocal} psql=${hasPsql}`);
    expect(enabled).toBe(false);
  });
});
