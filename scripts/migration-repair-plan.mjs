// =============================================================================
// Plan de repair del historial de migraciones (SEC-01).
//
// supabase_migrations.schema_migrations de prod se llenó con el MCP
// (apply_migration), que registra la HORA DE APLICACIÓN como versión y el
// nombre del archivo como nombre. Ninguna versión remota coincide con un
// archivo del repo, así que `supabase db push` intentaría reaplicar todo.
//
// Este script cruza las filas remotas con supabase/migrations/ POR NOMBRE y
// emite el plan para dejar el historial igual al repo (el repo es la fuente de
// verdad):
//   - reverted: versiones remotas que no son una versión del repo;
//   - applied:  versiones del repo que no están registradas y que tienen
//     evidencia de estar aplicadas (una fila remota por nombre o por fusión).
//     Los archivos SIN ninguna fila remota ("sin verificar") quedan afuera
//     salvo con --include-unverified: marcarlos applied sin que estén en la
//     base haría que `db push` los saltee para siempre. SEC-02 los verifica
//     objeto por objeto antes de incluirlos.
//   - comandos `supabase migration repair` en tandas de 50 y el SQL
//     equivalente (una transacción con backup y control de conteo).
// No toca la base. Uso:
//   node scripts/migration-repair-plan.mjs --applied=list_migrations.json \
//     [--out=dir] [--include-unverified] [--backup=schema_migrations_bak_20261117] [--json]
// Sale con 1 si hay filas remotas desconocidas o una versión con otro nombre.
// =============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseApplied, parseMigrations } from "./deploy-check.mjs";

/**
 * Fusiones conocidas y verificadas: archivo del repo ⇐ nombres que quedaron en
 * la base (la migración se aplicó partida o con otro nombre).
 */
export const KNOWN_MERGES = {
  delivery_orders: [
    "delivery_orders_p1_schema",
    "delivery_orders_p2_rpcs",
    "delivery_orders_p3_kds_comanda",
    "delivery_orders_p4_create_sale",
  ],
  service_packs: [
    "service_packs_tables_and_rpc",
    "service_packs_create_sale",
    "service_packs_create_sale_zero_subtotal_fix",
  ],
  members_profiles: ["members_profiles_and_tenant_members"],
  fn_tenant_members: ["members_profiles_and_tenant_members"],
  pos_offer_warranty: ["apply_offer_warranty_column"],
  // Segundas partes aplicadas aparte por el MCP; el archivo contiene el cambio.
  product_modifiers: ["product_modifiers_create_sale"],
  charge_table_order_atomic: ["charge_table_order_atomic_drop_old_overload"],
  dining_courses: ["dining_courses_drop_old_add_item"],
};

/**
 * Filas remotas extra sin archivo propio cuyo contenido NO está verificado
 * (el archivo "parecido" ya tiene su propia fila). No bloquean el plan, pero
 * se listan para revisarlas contra `statements` del backup.
 */
export const KNOWN_EXTRA = ["onboarding_status_v2", "owner_subscription", "gate_payment_methods"];

/** Filas remotas que no corresponden a ningún archivo (verificaciones del MCP). */
export const KNOWN_ORPHANS = [/^verify_.*_files?_parse$/];

export const BATCH = 50;

/** Nombre remoto normalizado: sin el prefijo `\d{14}_` que tienen algunos. */
export function normalizeName(name) {
  return String(name ?? "")
    .trim()
    .replace(/^\d{14}_/, "")
    .toLowerCase();
}

/**
 * Cruza repo y remoto.
 * @param {{version: string, name: string, file: string}[]} repo  parseMigrations(...).list
 * @param {{version: string, name: string|null}[]} remote parseApplied(...)
 * @param {{includeUnverified?: boolean}} [opts]
 */
export function buildRepairPlan(repo, remote, opts = {}) {
  const repoByVersion = new Map(repo.map((r) => [r.version, r]));
  const remoteVersions = new Set(remote.map((r) => r.version));
  const repoByName = new Map(repo.map((r) => [r.name.toLowerCase(), r]));
  const mergedInto = new Map();
  for (const [file, parts] of Object.entries(KNOWN_MERGES)) {
    for (const p of parts) mergedInto.set(p, [...(mergedInto.get(p) ?? []), file]);
  }

  const matchedRepo = new Set();
  const remoteRows = remote.map((r) => {
    const name = normalizeName(r.name);
    const base = { ...r, normalized: name };
    const sameVersion = repoByVersion.get(r.version);
    if (sameVersion) {
      // Misma versión con otro nombre: el historial dice que se aplicó algo
      // distinto a ese archivo. No se adivina.
      if (name && name !== sameVersion.name.toLowerCase()) return { ...base, kind: "version_name_mismatch", repo: [] };
      matchedRepo.add(r.version);
      return { ...base, kind: "version", repo: [r.version] };
    }
    const direct = repoByName.get(name);
    if (direct) {
      matchedRepo.add(direct.version);
      return { ...base, kind: "name", repo: [direct.version] };
    }
    const merged = (mergedInto.get(name) ?? []).map((f) => repoByName.get(f)).filter(Boolean);
    if (merged.length) {
      for (const m of merged) matchedRepo.add(m.version);
      return { ...base, kind: "merge", repo: merged.map((m) => m.version) };
    }
    if (KNOWN_EXTRA.includes(name)) return { ...base, kind: "extra", repo: [] };
    if (KNOWN_ORPHANS.some((re) => re.test(name))) return { ...base, kind: "orphan", repo: [] };
    return { ...base, kind: "unknown", repo: [] };
  });

  const unverified = repo.filter((r) => !matchedRepo.has(r.version));
  const reverted = remote.filter((r) => !repoByVersion.has(r.version)).map((r) => r.version).sort();
  const applied = repo
    .filter((r) => !remoteVersions.has(r.version))
    .filter((r) => opts.includeUnverified || matchedRepo.has(r.version))
    .map((r) => r.version)
    .sort();

  const exactRepo = new Set(remoteRows.filter((r) => r.kind === "version" || r.kind === "name").flatMap((r) => r.repo));
  const viaMerge = new Set(remoteRows.filter((r) => r.kind === "merge").flatMap((r) => r.repo));
  const kinds = (k) => remoteRows.filter((r) => r.kind === k);
  const label = (r) => `${r.version} ${r.normalized}`;

  return {
    counts: {
      repo: repo.length,
      remote: remote.length,
      reverted: reverted.length,
      applied: applied.length,
      matchedByVersion: kinds("version").length,
      matchedByName: kinds("name").length,
      merged: kinds("merge").length,
      extra: kinds("extra").length,
      orphan: kinds("orphan").length,
      unknown: kinds("unknown").length + kinds("version_name_mismatch").length,
      unverified: unverified.length,
      expectedRowsAfter: remote.length - reverted.length + applied.length,
    },
    includeUnverified: Boolean(opts.includeUnverified),
    reverted,
    applied,
    remoteRows,
    // Sin par por nombre exacto: del repo, los archivos que sólo se cruzan por
    // una fusión; del remoto, las filas fusionadas, extra, huérfanas o desconocidas.
    repoWithoutExactRemote: repo.filter((r) => viaMerge.has(r.version) && !exactRepo.has(r.version)).map((r) => r.file),
    remoteWithoutExactRepo: remoteRows.filter((r) => r.kind !== "version" && r.kind !== "name").map(label),
    extraRemote: kinds("extra").map(label),
    unknownRemote: [...kinds("unknown"), ...kinds("version_name_mismatch")].map(label),
    // Archivos del repo sin ninguna fila remota (ni por versión, ni por nombre,
    // ni por fusión): hay que verificar que su contenido esté en la base.
    unverified: unverified.map((r) => r.file),
  };
}

export function chunk(arr, n = BATCH) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Comandos del CLI: primero reverted, después applied. */
export function repairCommands(plan) {
  return [
    "set -euo pipefail",
    ...chunk(plan.reverted).map((c) => `supabase migration repair --status reverted ${c.join(" ")}`),
    ...chunk(plan.applied).map((c) => `supabase migration repair --status applied ${c.join(" ")}`),
  ];
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * SQL equivalente para el MCP, en una transacción: respaldo de la tabla, borra
 * las versiones remotas sin archivo, inserta las del repo (statements = null;
 * un insert común, para que una colisión aborte todo) y controla el conteo
 * final. La columna `statements` de las filas borradas queda en el respaldo.
 */
export function repairSql(plan, repo, backup = "schema_migrations_bak") {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(backup)) throw new Error(`nombre de backup inválido: ${backup}`);
  const byVersion = new Map(repo.map((r) => [r.version, r]));
  const lines = [
    "begin;",
    `create table supabase_migrations.${backup} as table supabase_migrations.schema_migrations;`,
  ];
  for (const c of chunk(plan.reverted)) {
    lines.push(`delete from supabase_migrations.schema_migrations where version in (${c.map(q).join(", ")});`);
  }
  for (const c of chunk(plan.applied)) {
    const values = c.map((v) => `(${q(v)}, ${q(byVersion.get(v).name)}, null)`).join(",\n  ");
    lines.push(`insert into supabase_migrations.schema_migrations (version, name, statements) values\n  ${values};`);
  }
  lines.push(
    `do $check$ begin
  if (select count(*) from supabase_migrations.schema_migrations) <> ${plan.counts.expectedRowsAfter} then
    raise exception 'repair: se esperaban ${plan.counts.expectedRowsAfter} filas';
  end if;
end $check$;`,
    "commit;",
  );
  return lines.join("\n");
}

export function run(argv, root) {
  const args = argv.slice(2);
  const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const appliedPath = opt("applied");
  if (!appliedPath) throw new Error("Falta --applied=<archivo> (JSON de list_migrations o 'version nombre' por línea).");
  const migDir = path.join(root, "supabase", "migrations");
  const { list: repo } = parseMigrations(fs.readdirSync(migDir));
  const remote = parseApplied(fs.readFileSync(appliedPath, "utf8"));
  const plan = buildRepairPlan(repo, remote, { includeUnverified: args.includes("--include-unverified") });
  const out = opt("out");
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "repair-reverted.txt"), plan.reverted.join("\n") + "\n");
    fs.writeFileSync(path.join(out, "repair-applied.txt"), plan.applied.join("\n") + "\n");
    fs.writeFileSync(path.join(out, "repair-unverified.txt"), plan.unverified.join("\n") + "\n");
    fs.writeFileSync(path.join(out, "repair-commands.sh"), repairCommands(plan).join("\n") + "\n");
    fs.writeFileSync(path.join(out, "repair.sql"), repairSql(plan, repo, opt("backup")) + "\n");
  }
  return { plan, commands: repairCommands(plan) };
}

const self = fileURLToPath(import.meta.url);
const sameFile = (a, b) => {
  try {
    const [x, y] = [fs.realpathSync(a), fs.realpathSync(b)];
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return false;
  }
};
if (process.argv[1] && sameFile(process.argv[1], self)) {
  const root = path.resolve(path.dirname(self), "..");
  try {
    const { plan } = run(process.argv, root);
    if (process.argv.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else {
      const c = plan.counts;
      console.log(`Repo: ${c.repo} archivos · remoto: ${c.remote} filas`);
      console.log(
        `Remotas: ${c.matchedByVersion} por versión, ${c.matchedByName} por nombre, ${c.merged} fusionadas, ${c.extra} extra a revisar, ${c.orphan} huérfanas, ${c.unknown} desconocidas`,
      );
      console.log(`Plan: ${c.reverted} reverted · ${c.applied} applied · filas esperadas después: ${c.expectedRowsAfter}`);
      console.log(`\nRepo sin par exacto en el remoto (${plan.repoWithoutExactRemote.length}):`);
      for (const f of plan.repoWithoutExactRemote) console.log(`  ${f}`);
      console.log(`\nRemoto sin par exacto en el repo (${plan.remoteWithoutExactRepo.length}):`);
      for (const r of plan.remoteWithoutExactRepo) console.log(`  ${r}`);
      if (plan.extraRemote.length) {
        console.log(`\nFilas remotas extra sin archivo propio (${plan.extraRemote.length}): revisar su statements en el backup.`);
        for (const r of plan.extraRemote) console.log(`  ${r}`);
      }
      if (plan.unknownRemote.length) {
        console.log(`\n[!] Remotas desconocidas o con otro nombre (${plan.unknownRemote.length}), revisar antes del repair:`);
        for (const r of plan.unknownRemote) console.log(`  ${r}`);
      }
      console.log(
        `\nArchivos sin ninguna fila remota: ${c.unverified} — ${plan.includeUnverified ? "INCLUIDOS como applied (--include-unverified)" : "fuera del plan; verificarlos y correr con --include-unverified"}.`,
      );
    }
    process.exit(plan.unknownRemote.length ? 1 : 0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
