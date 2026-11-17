// =============================================================================
// Foto de grants del Data API (SEC-06). Sólo lectura.
//   pnpm security:snapshot                       → prod (Management API, SUPABASE_ACCESS_TOKEN)
//   node scripts/security/grants-snapshot.mjs --db-url=postgres://…  → cualquier base (psql)
// Escribe supabase/security/grants.prod.json (o --out=<archivo>) ordenado y
// estable. Sin dependencias nuevas.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SNAPSHOT_SQL = fs.readFileSync(path.join(ROOT, "scripts", "security", "grants-snapshot.sql"), "utf8");
export const PROJECT_REF = "hrkditzrsavehnhngakb";

/** JSON con claves ordenadas y 2 espacios: diff estable en git. */
export function stableStringify(v) {
  const sort = (x) =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]))
        : x;
  return JSON.stringify(sort(v), null, 2) + "\n";
}

/** Corre la foto con psql (local / CI). */
export function snapshotViaPsql(dbUrl) {
  const out = execFileSync("psql", [dbUrl, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", SNAPSHOT_SQL], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim());
}

/** Corre la foto en prod por la Management API (read_only). */
export async function snapshotViaManagementApi(token, ref = PROJECT_REF) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: SNAPSHOT_SQL, read_only: true }),
  });
  if (!r.ok) throw new Error(`Management API ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  const s = rows?.[0]?.snapshot;
  return typeof s === "string" ? JSON.parse(s) : s;
}

/**
 * Diff legible entre dos fotos: [{ kind, object, field, expected, actual }].
 * `expected` es el estado objetivo (grants.expected.json).
 */
const PRIVS = [["s", "SELECT"], ["i", "INSERT"], ["u", "UPDATE"], ["d", "DELETE"]];

export function diffSnapshots(expected, actual) {
  const out = [];
  for (const [kind, key, fields] of [
    ["tables", "name", ["kind", "rls", "policies", "anon", "authenticated"]],
    ["functions", "sig", ["secdef", "anon", "authenticated", "config"]],
  ]) {
    const e = new Map((expected[kind] ?? []).map((x) => [x[key], x]));
    const a = new Map((actual[kind] ?? []).map((x) => [x[key], x]));
    for (const [k, ex] of e) {
      const ac = a.get(k);
      if (!ac) {
        out.push({ kind, object: k, field: "(existe)", expected: true, actual: false });
        continue;
      }
      for (const f of fields) {
        if (ex[f] === ac[f]) continue;
        // Privilegios de tabla ("siud"): una línea por privilegio que cambia.
        if (kind === "tables" && (f === "anon" || f === "authenticated")) {
          for (const [l, priv] of PRIVS) {
            const e1 = String(ex[f]).includes(l);
            const a1 = String(ac[f]).includes(l);
            if (e1 !== a1) out.push({ kind, object: k, field: `${f} ${priv}`, expected: e1, actual: a1 });
          }
        } else out.push({ kind, object: k, field: f, expected: ex[f], actual: ac[f] });
      }
    }
    for (const k of a.keys()) if (!e.has(k)) out.push({ kind, object: k, field: "(existe)", expected: false, actual: true });
  }
  return out;
}

export function formatDiff(diff, max = 200) {
  const lines = diff.slice(0, max).map((d) => `${d.kind}.${d.object} ${d.field}: esperado=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`);
  if (diff.length > max) lines.push(`… y ${diff.length - max} diferencias más`);
  return lines.join("\n");
}

const self = fileURLToPath(import.meta.url);
const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] ?? "");
    const b = fs.realpathSync(self);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  // Sólo la foto de prod va a grants.prod.json; una base local nunca la pisa.
  const out = opt("out") ?? path.join(ROOT, "supabase", "security", opt("db-url") ? "grants.local.json" : "grants.prod.json");
  try {
    let snap;
    if (opt("db-url")) snap = snapshotViaPsql(opt("db-url"));
    else {
      const token = process.env.SUPABASE_ACCESS_TOKEN;
      if (!token) throw new Error("Falta SUPABASE_ACCESS_TOKEN (o pasá --db-url=postgres://…).");
      snap = await snapshotViaManagementApi(token, opt("ref") ?? PROJECT_REF);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, stableStringify(snap));
    console.log(`${snap.tables.length} tablas/vistas · ${snap.functions.length} funciones → ${path.relative(ROOT, out)}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
