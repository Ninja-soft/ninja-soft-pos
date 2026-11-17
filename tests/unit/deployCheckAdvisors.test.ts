// @vitest-environment node
// scripts/deploy-check.mjs --advisors (SEC-04): parser de
// GET /v1/projects/{ref}/advisors/security y umbrales de security-baseline.json.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Finding = { code: string; severity: string; object: string; detail: string };
type Lint = { name: string; title: string; level: string; object: string | null; fn: string | null };
type Parsed = { lints: Lint[]; counts: Record<string, number> };
type Baseline = { advisors: Record<string, { max: number; severity?: string }> };
type Mod = {
  parseAdvisors: (json: unknown) => Parsed;
  checkAdvisors: (p: Parsed, baseline: Baseline, allowlist?: string[] | null) => Finding[];
  allowlistNames: (json: unknown) => string[];
};

const ROOT = path.resolve(__dirname, "..", "..");
let mod: Mod;

beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", "deploy-check.mjs")).href)) as Mod;
});

// Forma de la Management API (lints de Splinter).
const lint = (name: string, level: string, fnName: string | null, type = "function") => ({
  name,
  title: name,
  level,
  facing: "EXTERNAL",
  categories: ["SECURITY"],
  description: "",
  detail: "",
  remediation: "https://supabase.com/docs/guides/database/database-linter",
  metadata: fnName ? { schema: "public", name: fnName, type } : {},
  cache_key: `${name}_public_${fnName ?? "x"}`,
});

const FIXTURE = {
  lints: [
    lint("anon_security_definer_function_executable", "WARN", "public_catalog"),
    lint("anon_security_definer_function_executable", "WARN", "api_token_issue"),
    lint("anon_security_definer_function_executable", "WARN", "secreta"),
    lint("function_search_path_mutable", "WARN", "calc"),
    lint("rls_disabled_in_public", "ERROR", "tabla", "table"),
    lint("auth_leaked_password_protection", "WARN", null),
    { title: "sin name" },
  ],
};

const BASELINE: Baseline = {
  advisors: {
    anon_security_definer_function_executable: { max: 2 },
    function_search_path_mutable: { max: 0, severity: "error" },
    security_definer_view: { max: 0, severity: "warn" },
  },
};

describe("deploy-check · advisors", () => {
  it("cuenta los lints por name y descarta los que no lo traen", () => {
    const p = mod.parseAdvisors(FIXTURE);
    expect(p.counts).toEqual({
      anon_security_definer_function_executable: 3,
      function_search_path_mutable: 1,
      rls_disabled_in_public: 1,
      auth_leaked_password_protection: 1,
    });
    expect(p.lints[0]).toEqual({
      name: "anon_security_definer_function_executable",
      title: "anon_security_definer_function_executable",
      level: "WARN",
      object: "public.public_catalog",
      fn: "public_catalog",
    });
    expect(p.lints.find((l) => l.name === "rls_disabled_in_public")?.fn).toBeNull();
  });

  it("acepta el array suelto y rechaza una respuesta sin lints", () => {
    expect(mod.parseAdvisors(FIXTURE.lints.slice(0, 1)).counts).toEqual({ anon_security_definer_function_executable: 1 });
    expect(() => mod.parseAdvisors({ message: "Unauthorized" })).toThrow(/lints/);
  });

  it("umbrales, allowlist y ERROR sin vigilar", () => {
    const f = mod.checkAdvisors(mod.parseAdvisors(FIXTURE), BASELINE, ["public_catalog", "api_token_issue"]);
    expect(f.map((x) => `${x.code}:${x.severity}:${x.object}`)).toEqual([
      "A1:error:anon_security_definer_function_executable",
      "A1:error:function_search_path_mutable",
      "A2:error:public.secreta",
      "A3:warn:rls_disabled_in_public",
    ]);
    expect(f[0]?.detail).toMatch(/^3 > umbral 2: public\.public_catalog, public\.api_token_issue, public\.secreta$/);
  });

  it("en el umbral no hay hallazgos", () => {
    const p = mod.parseAdvisors({ lints: FIXTURE.lints.slice(0, 2) });
    expect(mod.checkAdvisors(p, BASELINE, ["public_catalog", "api_token_issue"])).toEqual([]);
    expect(mod.checkAdvisors(mod.parseAdvisors({ lints: [] }), BASELINE)).toEqual([]);
  });

  it("el baseline versionado tiene los umbrales de prod y la allowlist coincide", () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "security-baseline.json"), "utf8")) as Baseline;
    expect(baseline.advisors.anon_security_definer_function_executable).toMatchObject({ max: 19, severity: "error" });
    expect(baseline.advisors.function_search_path_mutable).toMatchObject({ max: 0, severity: "error" });
    const allow = mod.allowlistNames(
      JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security", "anon-allowlist.json"), "utf8")),
    );
    expect(allow).toContain("api_token_issue");
    expect(new Set(allow).size).toBe(baseline.advisors.anon_security_definer_function_executable?.max);
  });
});
