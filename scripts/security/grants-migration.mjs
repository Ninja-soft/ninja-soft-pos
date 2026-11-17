// =============================================================================
// Migración de grants explícitos del Data API desde el estado esperado (SEC-07).
//
//   node scripts/security/grants-migration.mjs --target   → ajusta grants.expected.json al objetivo
//   node scripts/security/grants-migration.mjs --out=supabase/migrations/<ts>_explicit_data_api_grants.sql
//
// Objetivo (ADR-184):
//   - anon no escribe nada por el Data API (sin INSERT/UPDATE/DELETE); conserva
//     el SELECT que ya tenía (RLS decide las filas).
//   - Las tablas con RLS y sin policies quedan sin grants para anon y
//     authenticated (sólo se usan por RPC o service_role).
//   - service_role, como en prod: todo sobre tablas, secuencias y funciones.
// La migración NO usa `grant … on all tables` para anon ni authenticated: un
// `revoke all` + `grant` exacto por tabla y rol.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "./grants-snapshot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXPECTED = path.join(ROOT, "supabase", "security", "grants.expected.json");
const PRIV = { s: "select", i: "insert", u: "update", d: "delete" };
const ident = (n) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

/** Aplica las reglas del objetivo sobre una foto (no muta la entrada). */
export function toTarget(snap) {
  return {
    ...snap,
    tables: snap.tables.map((t) => {
      const noPolicy = t.rls && t.policies === 0 && (t.kind === "r" || t.kind === "p");
      return {
        ...t,
        anon: noPolicy ? "" : t.anon.replace(/[iud]/g, ""),
        authenticated: noPolicy ? "" : t.authenticated,
        // anon tampoco escribe por columna.
        columns: Object.fromEntries(
          Object.entries(t.columns ?? {}).filter(([k]) => !noPolicy && !/^anon (insert|update|delete)$/.test(k)),
        ),
      };
    }),
  };
}

const privList = (letters) =>
  [...letters]
    .map((l) => PRIV[l])
    .filter(Boolean)
    .join(", ");

/** SQL de la migración a partir del estado esperado. */
export function migrationSql(expected) {
  const out = [];
  out.push(`-- =============================================================================
-- SEC-07 · Grants explícitos del Data API (ADR-184)
-- =============================================================================
-- Generada por scripts/security/grants-migration.mjs desde
-- supabase/security/grants.expected.json. NO EDITAR A MANO: regenerar.
--
-- Reemplaza al PR #311 (grant masivo que reabría tablas cerradas) y permite
-- sacar \`auto_expose_new_tables\` de supabase/config.toml.
--   1. anon no escribe nada por el Data API; conserva su SELECT (RLS decide).
--   2. Por tabla y vista: revoke all a anon y authenticated, grant exacto y
--      grants por columna de nuevo (el revoke de tabla también los borra).
--   3. service_role con todo, como en prod.
--   4. authenticated usa las secuencias (inserts con identity); anon no.
--   5. Drift detectado por grants-parity: is_tenant_owner/manager sin anon.
--   6. Default privileges seguros para lo que creen las próximas migraciones
--      (parte de SEC-09): anon sin escritura ni EXECUTE.
-- Compatible hacia atrás con el código de main: ningún flujo escribe como anon
-- por el Data API (públicos por RPC/Edge) y las tablas sin policy no se leen
-- directo.
-- =============================================================================
`);
  out.push("-- 1-2. Tablas y vistas");
  for (const t of expected.tables) {
    const n = `public.${ident(t.name)}`;
    out.push(`revoke all on table ${n} from anon, authenticated;`);
    if (t.anon) out.push(`grant ${privList(t.anon)} on table ${n} to anon;`);
    if (t.authenticated) out.push(`grant ${privList(t.authenticated)} on table ${n} to authenticated;`);
    // Grants por columna: el revoke de arriba también los borra.
    for (const [key, cols] of Object.entries(t.columns ?? {}).sort()) {
      const [role, priv] = key.split(" ");
      out.push(`grant ${priv} (${cols.map(ident).join(", ")}) on table ${n} to ${role};`);
    }
  }
  out.push(`
-- 3. service_role (bypassa RLS; lo usan Edges y scripts del servidor)
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- 4. Secuencias
revoke all on all sequences in schema public from anon;
grant usage, select on all sequences in schema public to authenticated;

-- 5. Drift: revocadas en prod fuera del repo
revoke execute on function public.is_tenant_owner() from public, anon;
revoke execute on function public.is_tenant_manager() from public, anon;
grant execute on function public.is_tenant_owner() to authenticated;
grant execute on function public.is_tenant_manager() to authenticated;

-- 6. Default privileges para objetos nuevos creados por postgres
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges for role postgres in schema public
  revoke usage, update on sequences from anon;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;
`);
  return out.join("\n");
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
  const expected = JSON.parse(fs.readFileSync(EXPECTED, "utf8"));
  if (args.includes("--target")) {
    fs.writeFileSync(EXPECTED, stableStringify(toTarget(expected)));
    console.log("grants.expected.json ajustado al objetivo.");
  }
  const out = opt("out");
  if (out) {
    const exp = JSON.parse(fs.readFileSync(EXPECTED, "utf8"));
    fs.writeFileSync(path.resolve(ROOT, out), migrationSql(exp));
    console.log(`Migración: ${out} (${exp.tables.length} tablas/vistas)`);
  }
}
