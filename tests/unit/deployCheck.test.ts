// @vitest-environment node
// scripts/deploy-check.mjs (F1.5 · ADR-098): orden de migraciones, plan de
// pendientes y lista de Edge Functions públicas.
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Finding = { code: string; severity: string; object: string; detail: string };
type Mig = { version: string; name: string; file: string };
type Mod = {
  PUBLIC_FUNCTIONS: string[];
  parseMigrations: (files: string[]) => { list: Mig[]; findings: Finding[] };
  checkAgainstBase: (base: string[], changes: { status: string; file: string }[]) => Finding[];
  parseApplied: (text: string) => { version: string; name: string | null }[];
  planMigrations: (
    repo: Mig[],
    applied: { version: string; name: string | null }[],
    readSql?: (f: string) => string,
  ) => { lastApplied: string | null; pending: Mig[]; findings: Finding[] };
  parseConfigPublic: (toml: string) => string[];
  headerAuth: (src: string) => "public" | "jwt" | null;
  checkFunctions: (i: { dirs: string[]; config: string[]; headers: Record<string, string>; expected?: string[] }) => Finding[];
  checkDeployed: (d: { slug: string; verify_jwt: boolean }[], dirs: string[], expected?: string[]) => Finding[];
  run: (argv: string[], root: string) => Promise<{ findings: Finding[]; publicFunctions: string[] }>;
};

const ROOT = path.resolve(__dirname, "..", "..");
let mod: Mod;

beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", "deploy-check.mjs")).href)) as Mod;
});

const codes = (f: Finding[]) => f.map((x) => x.code);

describe("deploy-check · migraciones", () => {
  it("rechaza nombres inválidos y timestamps duplicados", () => {
    const { list, findings } = mod.parseMigrations([
      "20261109700000_ok.sql",
      "20261109700000_otra.sql",
      "2026_mal.sql",
      "20261109700100_Mayus.sql",
      "README.md",
    ]);
    expect(list.map((m) => m.version)).toEqual(["20261109700000", "20261109700000"]);
    expect(codes(findings).sort()).toEqual(["M1", "M1", "M2"]);
  });

  it("contra la base: avisa lo agregado fuera de orden y corta lo modificado", () => {
    const f = mod.checkAgainstBase(
      ["20261001000000_a.sql", "20261010000000_b.sql"],
      [
        { status: "A", file: "supabase/migrations/20261005000000_vieja.sql" },
        { status: "A", file: "supabase/migrations/20261011000000_nueva.sql" },
        { status: "M", file: "supabase/migrations/20261001000000_a.sql" },
        { status: "D", file: "supabase/migrations/20261010000000_b.sql" },
      ],
    );
    expect(f.map((x) => `${x.code}:${x.severity}`)).toEqual(["M5:warn", "M6:error", "M6:error"]);
  });

  it("lee aplicadas como texto o como JSON del MCP", () => {
    expect(mod.parseApplied("# comentario\n20261001000000 a\n20261002000000")).toEqual([
      { version: "20261001000000", name: "a" },
      { version: "20261002000000", name: null },
    ]);
    expect(mod.parseApplied('[{"version":"20261103120000","name":"b"}]')).toEqual([
      { version: "20261103120000", name: "b" },
    ]);
  });

  it("plan: pendientes en orden, huecos como error y destructivas como aviso", () => {
    const { list } = mod.parseMigrations([
      "20261001000000_a.sql",
      "20261002000000_hueco.sql",
      "20261003000000_c.sql",
      "20261004000000_d.sql",
      "20261005000000_e.sql",
    ]);
    // c se aplicó por el MCP: otra versión, mismo nombre.
    const plan = mod.planMigrations(
      list,
      [
        { version: "20261001000000", name: "a" },
        { version: "20261103999999", name: "c" },
        { version: "20260101000000", name: "fantasma" },
      ],
      (f) => (f.includes("_e") ? "delete from sales;" : "select 1;"),
    );
    expect(plan.lastApplied).toBe("20261003000000");
    expect(plan.pending.map((p) => p.name)).toEqual(["hueco", "d", "e"]);
    expect(plan.findings.map((x) => `${x.code}:${x.object}`)).toEqual([
      "M3:20261002000000_hueco.sql",
      "W1:20261005000000_e.sql",
      "M4:20260101000000 fantasma",
    ]);
  });

  it("DELETE con WHERE no es destructivo", () => {
    const { list } = mod.parseMigrations(["20261001000000_a.sql"]);
    const plan = mod.planMigrations(list, [], () => "delete from t where id = 1;");
    expect(plan.findings).toEqual([]);
  });
});

describe("deploy-check · Edge Functions", () => {
  it("lee sólo las [functions.*] con verify_jwt = false", () => {
    const toml = `[api]\nverify_jwt = false\n[functions.a]\nverify_jwt = false # pública\n[functions.b]\nverify_jwt = true\n[db]\n`;
    expect(mod.parseConfigPublic(toml)).toEqual(["a"]);
  });

  it("interpreta el encabezado", () => {
    expect(mod.headerAuth("// Edge: x (público, sin\n// JWT). Identifica")).toBe("public");
    expect(mod.headerAuth("// Deploy: verify_jwt = true.")).toBe("jwt");
    expect(mod.headerAuth("// verify_jwt **false**")).toBe("public");
    expect(mod.headerAuth("import x from 'y';")).toBeNull();
  });

  it("la config tiene que ser exactamente la lista esperada", () => {
    const f = mod.checkFunctions({
      dirs: ["a", "b", "c"],
      config: ["a", "c"],
      headers: { a: "// verify_jwt = false", b: "// público, sin JWT" },
      expected: ["a", "z"],
    });
    expect(f.map((x) => `${x.code}:${x.object}`).sort()).toEqual([
      "F1:c",
      "F2:c",
      "F2:z",
      "F2:z",
      "F3:b",
    ]);
  });

  it("compara lo desplegado", () => {
    const f = mod.checkDeployed(
      [
        { slug: "a", verify_jwt: true },
        { slug: "x", verify_jwt: false },
      ],
      ["a", "x", "nuevo"],
      ["a"],
    );
    expect(f.map((x) => `${x.code}:${x.object}`)).toEqual(["R1:x", "R2:a", "R3:nuevo"]);
  });

  it("el repo real pasa el chequeo estático", async () => {
    const res = await mod.run(["node", "deploy-check.mjs"], ROOT);
    expect(res.findings.filter((x) => x.severity === "error")).toEqual([]);
    expect(res.publicFunctions).toEqual([...mod.PUBLIC_FUNCTIONS].sort());
  });
});
