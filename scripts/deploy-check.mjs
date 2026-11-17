#!/usr/bin/env node
// =============================================================================
// scripts/deploy-check.mjs  (F1.5 · ADR-098)
//
// Chequeo verificable del deploy: lo que hay que mirar ANTES de aplicar
// migraciones y desplegar Edge Functions. Nunca escribe en ninguna base.
//
// Estático (default, corre en CI):
//   M1  nombre de migración inválido (debe ser <14 dígitos>_<snake_case>.sql)
//   M2  timestamp de migración duplicado
//   M5  (--base) migración nueva con timestamp menor que la última de la base:
//       queda "en el medio" y `supabase db push` la saltea sin --include-all
//   M6  (--base) migración existente modificada, renombrada o borrada: las
//       aplicadas son inmutables, se corrigen con una migración nueva
//   F1  carpeta de Edge Function sin index.ts
//   F2  la lista de Edge públicas (verify_jwt = false) de supabase/config.toml
//       no es exactamente PUBLIC_FUNCTIONS
//   F3  el encabezado de una Edge dice lo contrario de la lista (pública que
//       declara verify_jwt = true, o privada que se declara sin JWT)
//
// Contra la base (sólo lectura):
//   --applied=<archivo>  versiones aplicadas (una por línea "version[ nombre]",
//                        o el JSON de list_migrations del MCP de Supabase)
//   --remote             Management API (SUPABASE_ACCESS_TOKEN +
//                        SUPABASE_PROJECT_REF): lee
//                        supabase_migrations.schema_migrations y la lista de
//                        Edge Functions desplegadas con su verify_jwt
//   M3  migración del repo más vieja que la última aplicada y que no está
//       aplicada (hueco: el orden real del deploy no es el del repo)
//   M4  migración aplicada que no está en el repo (aviso)
//   W1  migración pendiente con sentencias destructivas (aviso)
//   R1  Edge desplegada con verify_jwt = false que no está en la lista pública
//   R2  Edge pública de la lista desplegada con verify_jwt = true (el
//       proveedor recibe 401 y el cobro no se acredita)
//   R3  Edge del repo que no está desplegada (aviso)
//   Imprime el PLAN: migraciones pendientes en orden (todas las >= a la última
//   aplicada) y sus avisos.
//
//   --advisors           Management API (mismos secrets): GET
//                        /v1/projects/{ref}/advisors/security (los lints de
//                        Splinter: {lints: [{name, title, level, metadata}]})
//   A1  un lint vigilado supera su umbral de scripts/security-baseline.json
//       (severidad del baseline: hoy error para SECURITY DEFINER ejecutables
//       por anon y search_path mutable)
//   A2  SECURITY DEFINER ejecutable por anon que no está en
//       supabase/security/anon-allowlist.json (error)
//   A3  lint de nivel ERROR que el baseline no vigila (aviso)
//
// Uso:
//   node scripts/deploy-check.mjs                       # estático
//   node scripts/deploy-check.mjs --base=origin/main    # + orden contra la rama base
//   node scripts/deploy-check.mjs --applied=applied.txt # + plan de migraciones
//   node --env-file=.env.local scripts/deploy-check.mjs --remote
//   node --env-file=.env.local scripts/deploy-check.mjs --remote --advisors
//   node scripts/deploy-check.mjs --json
//   (CI nocturno: .github/workflows/drift.yml)
//
// Sale con 1 si hay errores (los avisos no cortan). La lógica es pura y se
// exporta para los tests (tests/unit/deployCheck.test.ts).
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Edge Functions públicas: las llama un tercero (procesador de pagos, Mercado
 * Pago, la página pública de checkout) o un usuario sin sesión. Todas validan
 * por su cuenta (re-consulta al proveedor, `state` de un solo uso, token del
 * link). Cualquier otra Edge exige JWT en el gateway.
 * Cambiar esta lista exige cambiar supabase/config.toml y documentarlo.
 */
export const PUBLIC_FUNCTIONS = [
  "catalog_purchase_webhook",
  "clover_webhook",
  "delivery_channel_webhook",
  "directo_webhook",
  "dlocalgo_webhook",
  "getnet_checkout",
  "getnet_webhook",
  "gocuotas_webhook",
  "ml_oauth_callback",
  "ml_webhook",
  "mobbex_webhook",
  "modo_webhook",
  "mp_billing_webhook",
  "mp_oauth_callback",
  "mp_orders_webhook",
  "mp_token_broker",
  "mp_webhook",
  "nave_webhook",
  "payway_checkout",
  "payway_webhook",
  "send_password_recovery",
  "talo_webhook",
  "ualabis_webhook",
  "viumi_webhook",
];

const MIGRATION_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/;

const DESTRUCTIVE = [
  [/\bdrop\s+table\b/i, "DROP TABLE"],
  [/\bdrop\s+column\b/i, "DROP COLUMN"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b(?![^;]*\bwhere\b)/i, "DELETE sin WHERE"],
  [/\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i, "cambio de tipo de columna"],
  [/\bdrop\s+schema\b/i, "DROP SCHEMA"],
];

/** Parsea los nombres de archivo de supabase/migrations. */
export function parseMigrations(files) {
  const findings = [];
  const list = [];
  const seen = new Map();
  for (const f of [...files].sort()) {
    if (!f.endsWith(".sql")) continue;
    const m = MIGRATION_RE.exec(f);
    if (!m) {
      findings.push({ code: "M1", severity: "error", object: f, detail: "nombre inválido: <14 dígitos>_<snake_case>.sql" });
      continue;
    }
    const [, version, name] = m;
    if (seen.has(version)) {
      findings.push({ code: "M2", severity: "error", object: f, detail: `timestamp duplicado con ${seen.get(version)}` });
    } else seen.set(version, f);
    list.push({ version, name, file: f });
  }
  return { list, findings };
}

/**
 * Compara contra la rama base: lo agregado tiene que ir después de la última
 * migración de la base, y lo existente no se toca.
 * `changes` = [{ status: "A"|"M"|"D"|"R...", file }] (git diff --name-status).
 */
export function checkAgainstBase(baseFiles, changes) {
  const findings = [];
  const baseVersions = baseFiles.map((f) => MIGRATION_RE.exec(f)?.[1]).filter(Boolean).sort();
  const baseMax = baseVersions[baseVersions.length - 1] ?? null;
  for (const { status, file } of changes) {
    const name = path.basename(file);
    if (status === "A") {
      const v = MIGRATION_RE.exec(name)?.[1];
      if (v && baseMax && v < baseMax) {
        findings.push({
          code: "M5",
          severity: "warn",
          object: name,
          detail: `timestamp menor que la última de la base (${baseMax}): aplicar en orden de timestamp, no de merge`,
        });
      }
    } else {
      findings.push({
        code: "M6",
        severity: "error",
        object: name,
        detail: `migración existente ${status === "D" ? "borrada" : status.startsWith("R") ? "renombrada" : "modificada"}: son inmutables, corregir con una nueva`,
      });
    }
  }
  return findings;
}

/**
 * Normaliza la lista de aplicadas: texto "version[ nombre]" por línea, o JSON
 * (array de {version, name} o de strings, o {migrations: [...]}).
 */
export function parseApplied(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : (j.migrations ?? j.result ?? []);
    return arr.map((r) => (typeof r === "string" ? { version: r, name: null } : { version: String(r.version), name: r.name ?? null }));
  }
  return t
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [version, ...rest] = l.split(/[\s|,]+/);
      return { version, name: rest.join("_") || null };
    });
}

/**
 * Plan de migraciones. Una migración del repo cuenta como aplicada si coincide
 * la versión o el nombre (las aplicadas por el MCP llevan la hora de aplicación
 * como versión y el nombre del archivo como nombre).
 */
export function planMigrations(repo, applied, readSql = () => "") {
  const findings = [];
  const byVersion = new Set(applied.map((a) => a.version));
  const byName = new Set(applied.map((a) => a.name).filter(Boolean));
  const matched = new Set();
  for (const r of repo) {
    if (byVersion.has(r.version) || byName.has(r.name) || byName.has(`${r.version}_${r.name}`)) matched.add(r.file);
  }
  const matchedVersions = repo.filter((r) => matched.has(r.file)).map((r) => r.version);
  const lastApplied = matchedVersions.length ? matchedVersions.sort()[matchedVersions.length - 1] : null;
  const pending = [];
  for (const r of repo) {
    if (matched.has(r.file)) continue;
    if (lastApplied && r.version < lastApplied) {
      findings.push({ code: "M3", severity: "error", object: r.file, detail: `no aplicada y más vieja que la última aplicada (${lastApplied})` });
    }
    pending.push(r);
    const sql = readSql(r.file);
    for (const [re, label] of DESTRUCTIVE) {
      if (re.test(sql)) findings.push({ code: "W1", severity: "warn", object: r.file, detail: `${label}: revisar plan de datos antes de aplicar` });
    }
  }
  const repoVersions = new Set(repo.map((r) => r.version));
  const repoNames = new Set(repo.flatMap((r) => [r.name, `${r.version}_${r.name}`]));
  for (const a of applied) {
    if (!repoVersions.has(a.version) && !(a.name && repoNames.has(a.name))) {
      findings.push({ code: "M4", severity: "warn", object: `${a.version}${a.name ? ` ${a.name}` : ""}`, detail: "aplicada en la base pero no está en el repo" });
    }
  }
  return { lastApplied, pending, findings };
}

/** `[functions.<slug>]` con `verify_jwt = false` en supabase/config.toml. */
export function parseConfigPublic(toml) {
  const out = [];
  let current = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = /^\[functions\.([A-Za-z0-9_-]+)\]$/.exec(line);
    if (sec) {
      current = sec[1];
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^verify_jwt\s*=\s*false$/.test(line)) out.push(current);
  }
  return out.sort();
}

/** Lo que el encabezado de la Edge dice de su JWT (null si no lo dice). */
export function headerAuth(source) {
  const head = source
    .split(/\r?\n/)
    .slice(0, 40)
    .map((l) => l.replace(/^\s*\/\/\s?/, ""))
    .join(" ");
  if (/verify_jwt\s*(?:=\s*)?\**\s*false|no-verify-jwt|sin\s+JWT/i.test(head)) return "public";
  if (/verify_jwt\s*(?:=\s*)?\**\s*true/i.test(head)) return "jwt";
  return null;
}

export function checkFunctions({ dirs, config, headers, expected = PUBLIC_FUNCTIONS }) {
  const findings = [];
  const exp = [...expected].sort();
  for (const d of dirs) {
    if (headers[d] === undefined) findings.push({ code: "F1", severity: "error", object: d, detail: "sin index.ts" });
  }
  const missing = exp.filter((f) => !config.includes(f));
  const extra = config.filter((f) => !exp.includes(f));
  for (const f of missing) findings.push({ code: "F2", severity: "error", object: f, detail: "pública esperada pero sin verify_jwt = false en config.toml" });
  for (const f of extra) findings.push({ code: "F2", severity: "error", object: f, detail: "verify_jwt = false en config.toml pero no está en la lista pública" });
  for (const f of exp) {
    if (!dirs.includes(f)) findings.push({ code: "F2", severity: "error", object: f, detail: "pública esperada que no existe en supabase/functions" });
  }
  for (const d of dirs) {
    const h = headers[d];
    if (!h) continue;
    const declared = headerAuth(h);
    if (exp.includes(d) && declared === "jwt") {
      findings.push({ code: "F3", severity: "error", object: d, detail: "en la lista pública pero el encabezado dice verify_jwt = true" });
    }
    if (!exp.includes(d) && declared === "public") {
      findings.push({ code: "F3", severity: "error", object: d, detail: "el encabezado la declara pública pero no está en la lista" });
    }
  }
  return findings;
}

/** Compara lo desplegado ([{slug, verify_jwt}]) con el repo y la lista. */
export function checkDeployed(deployed, dirs, expected = PUBLIC_FUNCTIONS) {
  const findings = [];
  const bySlug = new Map(deployed.map((f) => [f.slug, f]));
  for (const f of deployed) {
    if (f.verify_jwt === false && !expected.includes(f.slug)) {
      findings.push({ code: "R1", severity: "error", object: f.slug, detail: "desplegada sin JWT y no está en la lista pública" });
    }
  }
  for (const slug of expected) {
    const f = bySlug.get(slug);
    if (f && f.verify_jwt !== false) {
      findings.push({ code: "R2", severity: "error", object: slug, detail: "pública desplegada con verify_jwt = true: el proveedor recibe 401" });
    }
  }
  for (const d of dirs) {
    if (!bySlug.has(d)) findings.push({ code: "R3", severity: "warn", object: d, detail: "está en el repo pero no desplegada" });
  }
  return findings;
}

/**
 * Normaliza la respuesta de GET /v1/projects/{ref}/advisors/security:
 * `{ lints: [{ name, title, level: "ERROR"|"WARN"|"INFO", facing, categories,
 * description, detail, remediation, metadata: { schema, name, type }, cache_key }] }`.
 * Acepta también el array suelto. Devuelve los lints y el conteo por `name`.
 */
export function parseAdvisors(json) {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.lints) ? json.lints : null;
  if (!arr) throw new Error("respuesta de advisors sin `lints`");
  const lints = arr
    .filter((l) => l && typeof l.name === "string")
    .map((l) => ({
      name: l.name,
      title: l.title ?? l.name,
      level: String(l.level ?? "").toUpperCase(),
      object: l.metadata?.name ? `${l.metadata.schema ? `${l.metadata.schema}.` : ""}${l.metadata.name}` : null,
      fn: l.metadata?.type === "function" ? (l.metadata?.name ?? null) : null,
    }));
  const counts = {};
  for (const l of lints) counts[l.name] = (counts[l.name] ?? 0) + 1;
  return { lints, counts };
}

/**
 * Compara los lints con el baseline versionado (scripts/security-baseline.json):
 * `{ advisors: { <lint name>: { max, severity? } } }`. `allowlist` = nombres de
 * las funciones de supabase/security/anon-allowlist.json (sin firma).
 */
export function checkAdvisors(parsed, baseline, allowlist = null) {
  const findings = [];
  const rules = baseline?.advisors ?? {};
  for (const [name, rule] of Object.entries(rules)) {
    const n = parsed.counts[name] ?? 0;
    if (n > rule.max) {
      const objs = parsed.lints.filter((l) => l.name === name && l.object).map((l) => l.object);
      findings.push({
        code: "A1",
        severity: rule.severity ?? "error",
        object: name,
        detail: `${n} > umbral ${rule.max}${objs.length ? `: ${objs.slice(0, 30).join(", ")}${objs.length > 30 ? ", …" : ""}` : ""}`,
      });
    }
  }
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const l of parsed.lints) {
      if (l.name === "anon_security_definer_function_executable" && l.fn && !allowed.has(l.fn)) {
        findings.push({ code: "A2", severity: "error", object: l.object ?? l.fn, detail: "SECURITY DEFINER ejecutable por anon fuera de anon-allowlist.json" });
      }
    }
  }
  const unwatched = new Map();
  for (const l of parsed.lints) {
    if (l.level === "ERROR" && !(l.name in rules)) unwatched.set(l.name, (unwatched.get(l.name) ?? 0) + 1);
  }
  for (const [name, n] of unwatched) {
    findings.push({ code: "A3", severity: "warn", object: name, detail: `${n} lint(s) de nivel ERROR sin umbral en security-baseline.json` });
  }
  return findings;
}

/** Nombres (sin firma) de supabase/security/anon-allowlist.json. */
export function allowlistNames(json) {
  return (json?.functions ?? []).map((f) => String(f.sig ?? f.name ?? "").replace(/\(.*$/, "").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------
function readRepo(root) {
  const migDir = path.join(root, "supabase", "migrations");
  const fnDir = path.join(root, "supabase", "functions");
  const migFiles = fs.readdirSync(migDir);
  const dirs = fs
    .readdirSync(fnDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  const headers = {};
  for (const d of dirs) {
    const p = path.join(fnDir, d, "index.ts");
    if (fs.existsSync(p)) headers[d] = fs.readFileSync(p, "utf8");
  }
  const config = parseConfigPublic(fs.readFileSync(path.join(root, "supabase", "config.toml"), "utf8"));
  return { migDir, migFiles, dirs, headers, config };
}

function gitBase(root, base) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const baseFiles = git(["ls-tree", "--name-only", `${base}`, "supabase/migrations/"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((f) => path.basename(f));
  const changes = git(["diff", "--name-status", `${base}...HEAD`, "--", "supabase/migrations"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("\t");
      return { status: parts[0], file: parts[parts.length - 1] };
    });
  return { baseFiles, changes };
}

function apiAuth(flag) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!token || !ref) throw new Error(`${flag} necesita SUPABASE_ACCESS_TOKEN y SUPABASE_PROJECT_REF`);
  return { ref, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

async function remote() {
  const { ref, headers } = apiAuth("--remote");
  const q = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "select version, name from supabase_migrations.schema_migrations order by version", read_only: true }),
  });
  if (!q.ok) throw new Error(`Management API (migraciones) ${q.status}`);
  const applied = (await q.json()).map((r) => ({ version: String(r.version), name: r.name ?? null }));
  const f = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, { headers });
  if (!f.ok) throw new Error(`Management API (functions) ${f.status}`);
  const deployed = (await f.json()).map((x) => ({ slug: x.slug, verify_jwt: x.verify_jwt }));
  return { applied, deployed };
}

async function remoteAdvisors() {
  const { ref, headers } = apiAuth("--advisors");
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/advisors/security`, { headers });
  if (!r.ok) throw new Error(`Management API (advisors) ${r.status}`);
  return parseAdvisors(await r.json());
}

export async function run(argv, root) {
  const args = argv.slice(2);
  const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const repo = readRepo(root);
  const { list, findings } = parseMigrations(repo.migFiles);
  findings.push(...checkFunctions({ dirs: repo.dirs, config: repo.config, headers: repo.headers }));
  const base = opt("base");
  if (base) {
    const { baseFiles, changes } = gitBase(root, base);
    findings.push(...checkAgainstBase(baseFiles, changes));
  }
  let plan = null;
  let applied = null;
  if (opt("applied")) applied = parseApplied(fs.readFileSync(opt("applied"), "utf8"));
  if (args.includes("--remote")) {
    const r = await remote();
    applied = r.applied;
    findings.push(...checkDeployed(r.deployed, repo.dirs));
  }
  let advisors = null;
  if (args.includes("--advisors")) {
    const parsed = await remoteAdvisors();
    const baseline = JSON.parse(fs.readFileSync(path.join(root, "scripts", "security-baseline.json"), "utf8"));
    const allowPath = path.join(root, "supabase", "security", "anon-allowlist.json");
    const allow = fs.existsSync(allowPath) ? allowlistNames(JSON.parse(fs.readFileSync(allowPath, "utf8"))) : null;
    advisors = parsed.counts;
    findings.push(...checkAdvisors(parsed, baseline, allow));
  }
  if (applied) {
    plan = planMigrations(list, applied, (f) => fs.readFileSync(path.join(repo.migDir, f), "utf8"));
    findings.push(...plan.findings);
  }
  return {
    migrations: list.length,
    functions: repo.dirs.length,
    publicFunctions: repo.config,
    plan: plan ? { lastApplied: plan.lastApplied, pending: plan.pending.map((p) => p.file) } : null,
    advisors,
    findings: findings.filter((f, i, a) => a.findIndex((g) => g.code === f.code && g.object === f.object && g.detail === f.detail) === i),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const res = await run(process.argv, root);
    const errors = res.findings.filter((f) => f.severity === "error");
    if (process.argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`Migraciones: ${res.migrations} · Edge Functions: ${res.functions} · públicas (verify_jwt = false): ${res.publicFunctions.length}`);
      if (res.plan) {
        console.log(`\nÚltima aplicada: ${res.plan.lastApplied ?? "(ninguna)"}`);
        console.log(`Pendientes en orden (${res.plan.pending.length}):`);
        for (const p of res.plan.pending) console.log(`  ${p}`);
      }
      if (res.advisors) {
        console.log("\nAdvisors de seguridad (lints por nombre):");
        for (const [k, n] of Object.entries(res.advisors).sort()) console.log(`  ${k}: ${n}`);
      }
      console.log(`\nHallazgos: ${errors.length} errores, ${res.findings.length - errors.length} avisos`);
      for (const f of res.findings) console.log(`[${f.severity}] ${f.code} ${f.object}: ${f.detail}`);
    }
    process.exit(errors.length ? 1 : 0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
