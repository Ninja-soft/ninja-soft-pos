// @vitest-environment node
// SEC-28: registro de las Edge Functions públicas (verify_jwt = false).
// supabase/security/public-edges.json tiene que listar exactamente las de
// PUBLIC_FUNCTIONS (scripts/deploy-check.mjs) y las de supabase/config.toml, y
// lo que declara (límite por IP, límite de cuerpo, firma, state, clave) tiene
// que verse en el código de la Edge o de los _shared que importa. Las Edges no
// se tocan: el registro reemplaza documentar el mecanismo en cada encabezado.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Entry = {
  name: string;
  auth: string[];
  ipLimit: boolean;
  bodyLimit: boolean;
  unitTest: string | null;
  tasks: string[];
  notes: string;
};
type Registry = { authKinds: string[]; functions: Entry[] };
type DeployCheck = { PUBLIC_FUNCTIONS: string[]; parseConfigPublic: (toml: string) => string[] };

const ROOT = path.resolve(__dirname, "..", "..");
const FUNCTIONS = path.join(ROOT, "supabase", "functions");
const registry = JSON.parse(
  fs.readFileSync(path.join(ROOT, "supabase", "security", "public-edges.json"), "utf8"),
) as Registry;
const names = registry.functions.map((f) => f.name).sort();

let mod: DeployCheck;
beforeAll(async () => {
  mod = (await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, "scripts", "deploy-check.mjs")).href)) as DeployCheck;
});

/**
 * index.ts de la Edge + los _shared que importa directamente (un nivel), sin
 * requestGuard.ts (define los helpers: contaría como uso en todas).
 */
function edgeSource(name: string): string {
  const index = fs.readFileSync(path.join(FUNCTIONS, name, "index.ts"), "utf8");
  const shared = [...index.matchAll(/from\s+"\.\.\/_shared\/([A-Za-z0-9_/]+\.ts)"/g)]
    .map((m) => m[1] ?? "")
    .filter((f) => f !== "requestGuard.ts")
    .map((f) => path.join(FUNCTIONS, "_shared", f))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"));
  return [index, ...shared].join("\n");
}

describe("registro de Edges públicas · pertenencia", () => {
  it("coincide con PUBLIC_FUNCTIONS de deploy-check", () => {
    expect(names).toEqual([...mod.PUBLIC_FUNCTIONS].sort());
  });

  it("coincide con las verify_jwt = false de config.toml", () => {
    const toml = fs.readFileSync(path.join(ROOT, "supabase", "config.toml"), "utf8");
    expect(names).toEqual(mod.parseConfigPublic(toml));
  });

  it("sin nombres repetidos y cada Edge existe en el repo", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(fs.existsSync(path.join(FUNCTIONS, n, "index.ts")), n).toBe(true);
  });
});

describe("registro de Edges públicas · contenido", () => {
  it.each(registry.functions.map((f) => [f.name, f] as const))("%s: campos válidos", (_name, f) => {
    expect(f.auth.length).toBeGreaterThan(0);
    for (const a of f.auth) expect(registry.authKinds, a).toContain(a);
    expect(typeof f.ipLimit).toBe("boolean");
    expect(typeof f.bodyLimit).toBe("boolean");
    expect(f.notes.length).toBeGreaterThan(20);
    for (const t of f.tasks) expect(t).toMatch(/^SEC-\d+[a-z]?$/);
    if (f.unitTest !== null) expect(fs.existsSync(path.join(ROOT, f.unitTest)), f.unitTest).toBe(true);
  });

  it.each(registry.functions.map((f) => [f.name, f] as const))("%s: lo declarado se ve en el código", (name, f) => {
    const src = edgeSource(name);
    expect(/createIpLimiter\(/.test(src), "ipLimit").toBe(f.ipLimit);
    expect(/read(Json|Text)Limited\(/.test(src), "bodyLimit").toBe(f.bodyLimit);
    const has = (re: RegExp) => re.test(src);
    if (f.auth.includes("hmac")) expect(has(/verify\w*Signature|decideMpSignature/), "hmac").toBe(true);
    if (f.auth.includes("state")) expect(has(/_oauth_states/), "state").toBe(true);
    if (f.auth.includes("api_key")) expect(has(/SHA-256/), "api_key").toBe(true);
    if (f.auth.includes("static_token")) expect(has(/safeEqual\(/), "static_token").toBe(true);
  });
});
