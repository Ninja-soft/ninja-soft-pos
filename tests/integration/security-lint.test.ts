// @vitest-environment node
// =============================================================================
// Lint de exposición de funciones (SEC-15). Corre en el job `rls` contra la
// base local de CI (DB_URL de `supabase status -o env`) con psql.
//   (1) Ninguna SECURITY DEFINER de `public` es ejecutable por anon si no está
//       en supabase/security/anon-allowlist.json.
//   (2) Ninguna SECURITY DEFINER ejecutable por authenticated que reciba
//       p_tenant / p_tenant_id deja de llamar a un guard reconocido, salvo las
//       de supabase/security/tenant-param-allowlist.json (heurístico).
//   (3) Ninguna función de `public` queda con search_path mutable, salvo la
//       línea base supabase/security/search-path-baseline.json (SEC-16 la vacía).
//   (4) Ninguna función de trigger de `public` es ejecutable por anon ni
//       authenticated (SEC-12).
// Cada falla trae la firma exacta y el arreglo listo para pegar en una
// migración nueva. Sin DB_URL local o sin psql, se salta (y en CI avisa).
// =============================================================================
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "supabase", "security", f), "utf8"));

/** Corre una consulta que devuelve una firma por fila. */
function sigs(sql: string): string[] {
  return execFileSync("psql", [DB_URL!, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    encoding: "utf8",
    input: sql,
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

const NOT_EXT = "not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')";
const SIG = "p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'";

/** Consulta del chequeo (1); la usa también la sonda (1b). */
const ANON_SECDEF_SQL = `select ${SIG} from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and has_function_privilege('anon', p.oid, 'EXECUTE') and ${NOT_EXT} order by 1;`;

export const TENANT_GUARD_RE =
  "(current_tenant_id\\(|auth\\.uid\\(|internal_scope|is_internal|platform_staff_billing_role|_assert|_edge_guard)";

describe.skipIf(!enabled)("security-lint · funciones de public", () => {
  it("(1) SECURITY DEFINER ejecutables por anon = allowlist", () => {
    const allow = new Set((readJson("anon-allowlist.json").functions as { sig: string }[]).map((f) => f.sig));
    const exposed = sigs(ANON_SECDEF_SQL);
    const extra = exposed.filter((s) => !allow.has(s));
    expect(
      extra,
      `SECURITY DEFINER ejecutables por anon fuera de supabase/security/anon-allowlist.json. Si no es pública a propósito, en una migración nueva:\n${extra
        .map((s) => `  revoke execute on function public.${s} from public, anon;`)
        .join("\n")}\nSi es pública a propósito: sumala a la allowlist con su motivo y documentala en docs/05-security.md §14.`,
    ).toEqual([]);
  });

  it("(1b) el chequeo detecta una SECURITY DEFINER nueva sin revoke", () => {
    // Una función nueva hereda el EXECUTE de PUBLIC (default global, SEC-09):
    // sin revoke explícito, anon la ejecuta y el lint lo marca.
    const found = sigs(`begin;
create function public._lint_probe_secdef() returns int language sql security definer
  set search_path = public, pg_temp as 'select 1';
${ANON_SECDEF_SQL}
rollback;`);
    expect(found).toContain("_lint_probe_secdef()");
  });

  it("(2) SECURITY DEFINER con p_tenant ejecutables por authenticated llaman a un guard", () => {
    const allow = new Set((readJson("tenant-param-allowlist.json").functions as { sig: string }[]).map((f) => f.sig));
    const found = sigs(`select ${SIG} from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and coalesce(array_to_string(p.proargnames, ','), '') ~ '(^|,)p_tenant(_id)?(,|$)'
        and ${NOT_EXT}
        and p.prosrc !~* '${TENANT_GUARD_RE}'
      order by 1;`);
    const extra = found.filter((s) => !allow.has(s));
    expect(
      extra,
      `SECURITY DEFINER que reciben p_tenant, las ejecuta authenticated y no validan membresía. Un usuario puede pasar el id de otro negocio. Arreglo: validar adentro (if p_tenant is distinct from current_tenant_id() and not is_internal() then raise exception 'forbidden'; end if;) o, si es un helper interno:\n${extra
        .map((s) => `  revoke execute on function public.${s} from public, anon, authenticated;`)
        .join("\n")}\nFalso positivo: sumalo a supabase/security/tenant-param-allowlist.json con su motivo.`,
    ).toEqual([]);
  });

  it("(3) sin search_path mutable fuera de la línea base", () => {
    const base = new Set(readJson("search-path-baseline.json").functions as string[]);
    const mutable = sigs(`select ${SIG} from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
        and ${NOT_EXT} order by 1;`);
    const extra = mutable.filter((s) => !base.has(s));
    expect(
      extra,
      `Funciones con search_path mutable. En la definición agregá \`set search_path = public, pg_temp\` o, en una migración nueva:\n${extra
        .map((s) => `  alter function public.${s} set search_path = public, pg_temp;`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("(4) las funciones de trigger no se ejecutan por el Data API", () => {
    const exposed = sigs(`select ${SIG} from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
        and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
        and ${NOT_EXT} order by 1;`);
    expect(
      exposed,
      `Funciones de trigger ejecutables por anon o authenticated (no tienen por qué: Postgres no chequea EXECUTE al disparar el trigger). En la misma migración que la crea:\n${exposed
        .map((s) => `  revoke execute on function public.${s} from public, anon, authenticated;`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

describe("security-lint · archivos de configuración", () => {
  it("las allowlists tienen motivo y la línea base no tiene repetidos", () => {
    for (const f of readJson("tenant-param-allowlist.json").functions as { sig: string; reason: string }[]) {
      expect(f.reason.length, f.sig).toBeGreaterThan(10);
    }
    const base = readJson("search-path-baseline.json").functions as string[];
    expect(new Set(base).size).toBe(base.length);
  });
});

describe.skipIf(enabled || !process.env.CI)("security-lint · salteado en CI", () => {
  it("avisa que no corrió", () => {
    console.warn(`[security-lint] SALTEADO en CI: DB_URL=${DB_URL ? "sí" : "no"} local=${isLocal} psql=${hasPsql}`);
    expect(process.env.GRANTS_PARITY_STRICT === "1", "en CI estricto el lint tiene que correr").toBe(false);
  });
});
