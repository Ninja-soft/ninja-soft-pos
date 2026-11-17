#!/usr/bin/env node
// =============================================================================
// scripts/release.mjs  (OPS-53 · ADR-193)
//
// Versión y registro de cada deploy a producción. Una versión PATCH por cada
// tanda que se despliega (0.2.0, 0.2.1, 0.2.2…). No toca ninguna base ni
// GitHub: sólo escribe archivos del repo.
//
//   prepare --version X.Y.Z [--date YYYY-MM-DD] [--from <ref>] [--to <ref>]
//           [--tanda <rama>] [--prod <ref>] [--remote] [--applied <archivo>]
//           [--deployed <archivo>] [--dry-run] [--force]
//     1. package.json → X.Y.Z (tiene que ser semver y mayor que la actual).
//     2. CHANGELOG.md: corta `## [Unreleased]` en `## [X.Y.Z] - fecha` y deja
//        un `[Unreleased]` vacío arriba.
//     3. docs/releases/vX.Y.Z.md: qué aplicó el deploy, agrupado por deploy a
//        producción (cada merge de `tanda/*` en el first-parent es un bloque;
//        lo que falta mergear es el bloque final "este deploy"):
//        rango de commits, PRs (número, tarea, título), migraciones nuevas
//        (columna "aplicada en prod"), Edge Functions afectadas (carpeta
//        propia cambiada o que importa —directa o indirectamente— un módulo
//        cambiado de `_shared/`; columna "desplegada") y flags/features
//        sembrados por las migraciones.
//     --from      default: último tag v* alcanzable desde --to; si no hay,
//                 el último merge de tanda/* en el first-parent de --prod.
//     --to        default HEAD.
//     --prod      default origin/main. Los bloques ya mergeados ahí se marcan
//                 aplicados/desplegados ("sí (en main)") salvo que haya datos
//                 remotos; el resto queda "pendiente de verificar".
//     --remote    sólo lectura contra la Management API (SUPABASE_ACCESS_TOKEN
//                 + SUPABASE_PROJECT_REF, como deploy-check): migraciones de
//                 supabase_migrations.schema_migrations y Edges desplegadas
//                 con su updated_at.
//     --applied   como deploy-check: versiones aplicadas (texto o el JSON de
//                 list_migrations del MCP). --deployed: JSON de Edges
//                 [{slug, updated_at}] (list_edge_functions del MCP).
//
//   record --version X.Y.Z [mismas opciones que prepare]
//     Regenera sólo docs/releases/vX.Y.Z.md (no toca package.json ni el
//     CHANGELOG; la fecha sale de la sección del CHANGELOG). Para completar
//     las columnas después del deploy: `record ... --to vX.Y.Z --remote`.
//
//   notes --version X.Y.Z
//     Imprime la sección del CHANGELOG (para `gh release create
//     --notes-file`), con el link al registro del deploy.
//
// La lógica es pura y se exporta para tests/unit/release.test.ts.
// =============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiAuth, parseApplied } from "./deploy-check.mjs";

// ---------------------------------------------------------------- versiones

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** "1.2.3" → [1, 2, 3]; null si no es semver X.Y.Z (sin prerelease). */
export function parseSemver(v) {
  const m = SEMVER_RE.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`versión inválida: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Tira si `next` no es semver o no es mayor que `current`. */
export function assertNextVersion(current, next) {
  if (!parseSemver(next)) throw new Error(`versión inválida: "${next}" (formato X.Y.Z)`);
  if (compareSemver(next, current) <= 0) throw new Error(`la versión ${next} tiene que ser mayor que la actual (${current})`);
  return next;
}

export function isIsoDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
}

/** Cambia sólo el campo "version" de package.json, sin reformatear. */
export function bumpPackageJson(text, version) {
  const current = JSON.parse(text).version;
  assertNextVersion(current, version);
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(out).version !== version) throw new Error("no se pudo actualizar la versión de package.json");
  return out;
}

// ---------------------------------------------------------------- CHANGELOG

const UNRELEASED_RE = /^## \[Unreleased\][^\n]*\n/m;
const SECTION_RE = /^## /gm;

/** Ancla de GitHub para `## [X.Y.Z] - fecha` (`#xyz---fecha`). */
export function changelogAnchor(version, date) {
  return `#${version.replace(/\./g, "")}---${date}`;
}

function sectionBounds(md, headingRe) {
  const m = headingRe.exec(md);
  if (!m) return null;
  const start = m.index;
  const bodyStart = start + m[0].length;
  SECTION_RE.lastIndex = bodyStart;
  const next = SECTION_RE.exec(md);
  const end = next ? next.index : md.length;
  return { start, bodyStart, end };
}

/** Saca separadores `---` y espacios del final de un cuerpo de sección. */
function trimBody(body) {
  return body.replace(/(\s*\n---\s*)+$/, "").trim();
}

/**
 * Mueve el contenido de `## [Unreleased]` a `## [version] - date` y deja un
 * `[Unreleased]` vacío arriba (una nota `> …` al tope se queda en
 * Unreleased). Tira si no hay Unreleased, si está vacío o si
 * la versión ya tiene sección.
 */
export function cutChangelog(md, version, date) {
  if (!parseSemver(version)) throw new Error(`versión inválida: "${version}"`);
  if (!isIsoDate(date)) throw new Error(`fecha inválida: "${date}" (AAAA-MM-DD)`);
  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(md)) {
    throw new Error(`el CHANGELOG ya tiene la sección [${version}]`);
  }
  const b = sectionBounds(md, UNRELEASED_RE);
  if (!b) throw new Error("el CHANGELOG no tiene `## [Unreleased]`");
  // Una nota en blockquote al tope de Unreleased (cómo se versiona) se queda
  // en Unreleased; se mueve el resto.
  const all = trimBody(md.slice(b.bodyStart, b.end));
  const lead = /^(?:>[^\n]*(?:\n|$))+/.exec(all);
  const note = lead ? lead[0].trim() : "";
  const body = trimBody(all.slice(lead ? lead[0].length : 0));
  if (!body) throw new Error("`[Unreleased]` está vacío: no hay nada para versionar");
  const head = md.slice(0, b.start);
  const rest = md.slice(b.end);
  const keep = note ? `${note}\n\n` : "";
  return `${head}## [Unreleased]\n\n${keep}---\n\n## [${version}] - ${date}\n\n${body}\n\n---\n\n${rest}`;
}

/** Tope del cuerpo de un release de GitHub (125.000 caracteres) con margen. */
export const GH_NOTES_LIMIT = 100_000;

/**
 * Notas para `gh release create --notes-file`. Si la sección completa no entra
 * en el tope de GitHub, queda la versión compacta: notas `>`, encabezados y el
 * título en negrita de cada entrada, con el link al CHANGELOG completo.
 * @param {string} body
 * @param {{ record?: string | null, changelogUrl?: string | null, limit?: number }} [opts]
 */
export function releaseNotes(body, { record = null, changelogUrl = null, limit = GH_NOTES_LIMIT } = {}) {
  const tail = record ? `\n\n---\n\nRegistro del deploy (PRs, migraciones, Edge Functions): \`${record}\`.\n` : "\n";
  if (body.length + tail.length <= limit) return body + tail;
  const compact = body
    .split("\n")
    .map((l) => {
      const m = /^- (\*\*.+?\*\*)/.exec(l);
      if (m) return `- ${m[1]}`;
      return /^(#|>|\s*$)/.test(l) ? l : null;
    })
    .filter((l) => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const where = changelogUrl ? `[CHANGELOG.md](${changelogUrl})` : "`CHANGELOG.md`";
  return `${compact}\n\n---\n\nVersión compacta (la sección completa supera el límite de GitHub): el detalle de cada entrada está en ${where}.${tail}`;
}

/** Cuerpo de la sección `[version]` (sin el encabezado), o null. */
export function changelogSection(md, version) {
  const re = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n`, "m");
  const b = sectionBounds(md, re);
  if (!b) return null;
  return trimBody(md.slice(b.bodyStart, b.end));
}

// ---------------------------------------------------------------- commits

const TASK_ID_RE = /\b[A-Z][A-Z0-9]{1,6}-\d+[A-Za-z]?\b/g;

/**
 * Asunto de un squash de PR: `tipo(scope): título (TAREA) (#123)`.
 * La tarea es el último paréntesis antes de `(#N)` si son sólo ids
 * (`SEC-07`, `SEC-02, ADR-183`, `SEC-07/SEC-08`).
 */
export function parseCommitSubject(subject) {
  let s = String(subject).trim();
  let pr = null;
  const prM = /\s*\(#(\d+)\)\s*$/.exec(s);
  if (prM) {
    pr = Number(prM[1]);
    s = s.slice(0, prM.index);
  }
  let task = null;
  const taskM = /\s*\(([^()]+)\)\s*$/.exec(s);
  if (taskM) {
    const inner = taskM[1] ?? "";
    const ids = inner.match(TASK_ID_RE) ?? [];
    const leftover = inner.replace(TASK_ID_RE, "").replace(/[\s,/·;+y]+/g, "");
    if (ids.length && !leftover) {
      task = ids.join(", ");
      s = s.slice(0, taskM.index);
    }
  }
  const typeM = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*/.exec(s);
  return { pr, task, type: typeM ? typeM[1] : null, scope: typeM?.[2] ?? null, title: s.trim() };
}

/** `Merge pull request #587 from Org/tanda/2026-11-17-4` → {pr, branch}. */
export function parseDeployMerge(subject) {
  const m = /^Merge pull request #(\d+) from [^/\s]+\/(tanda\/\S+)/.exec(String(subject).trim());
  if (m) return { pr: Number(m[1]), branch: m[2] ?? "" };
  const b = /^Merge branch '(tanda\/[^']+)'/.exec(String(subject).trim());
  return b ? { pr: null, branch: b[1] ?? "" } : null;
}

/**
 * Agrupa el first-parent (de viejo a nuevo) en bloques de deploy.
 * `firstParent` = [{sha, parents: [], date, subject}]; `commitsOf(base, tip)`
 * devuelve los commits (no merge) de un merge. Cada merge de tanda cierra un
 * bloque; lo que queda después es el bloque final (pendiente de deploy).
 */
export function groupBlocks(from, firstParent, commitsOf) {
  const blocks = [];
  let pending = [];
  let base = from;
  for (const c of firstParent) {
    const deploy = c.parents.length > 1 ? parseDeployMerge(c.subject) : null;
    if (c.parents.length > 1) {
      const inner = commitsOf(c.parents[0], c.parents[1]);
      if (deploy) {
        blocks.push({ kind: "deploy", branch: deploy.branch, pr: deploy.pr, merge: c.sha, date: c.date, base, end: c.sha, commits: [...pending, ...inner] });
        pending = [];
        base = c.sha;
      } else pending.push(...inner);
    } else pending.push(c);
  }
  const last = firstParent[firstParent.length - 1];
  if (pending.length && last) blocks.push({ kind: "pending", branch: null, pr: null, merge: null, date: last.date, base, end: last.sha, commits: pending });
  return blocks;
}

// ---------------------------------------------------------------- diff

const MIG_RE = /^supabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)$/;

/** Líneas de `git diff --name-status` → [{status, file}] (rename = destino). */
export function parseNameStatus(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("\t");
      return { status: (parts[0] ?? "").charAt(0), file: parts[parts.length - 1] ?? "" };
    });
}

export function addedMigrations(changes) {
  return changes
    .filter((c) => c.status === "A" || c.status === "R" || c.status === "C")
    .map((c) => MIG_RE.exec(c.file)?.[1])
    .filter(Boolean)
    .sort();
}

/** Especificadores de import/export estáticos de un módulo TS/JS. */
export function parseImports(source) {
  const out = new Set();
  const re = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1] ?? m[2]);
  return [...out].filter(Boolean);
}

/** Resuelve un import relativo (posix). Externos (https:, npm:, jsr:) → null. */
export function resolveImport(fromFile, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
}

/**
 * Edge Functions afectadas por un set de archivos cambiados.
 * `files` = {ruta: contenido} de supabase/functions en el commit final del
 * bloque; `changed` = rutas cambiadas. Una Edge cuenta si cambió su carpeta o
 * si alcanza (imports transitivos) un archivo cambiado fuera de ella.
 * Devuelve [{slug, own, via: [rutas]}] ordenado por slug.
 */
export function affectedFunctions(files, changed, root = "supabase/functions") {
  const changedSet = new Set(changed);
  const graph = new Map();
  for (const [f, src] of Object.entries(files)) {
    graph.set(f, parseImports(src).map((s) => resolveImport(f, s)).filter(Boolean));
  }
  const slugs = new Set();
  for (const f of Object.keys(files)) {
    const rel = f.startsWith(`${root}/`) ? f.slice(root.length + 1) : null;
    const dir = rel?.split("/")[0];
    if (rel && rel.includes("/") && dir && !dir.startsWith("_")) slugs.add(dir);
  }
  const out = [];
  for (const slug of [...slugs].sort()) {
    const prefix = `${root}/${slug}/`;
    const own = changed.some((c) => c.startsWith(prefix));
    const seen = new Set();
    const stack = Object.keys(files).filter((f) => f.startsWith(prefix));
    while (stack.length) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      for (const dep of graph.get(f) ?? []) if (!seen.has(dep)) stack.push(dep);
    }
    const via = [...seen].filter((f) => !f.startsWith(prefix) && changedSet.has(f)).sort();
    if (own || via.length) out.push({ slug, own, via });
  }
  return out;
}

/** Edges borradas en el bloque (carpeta cambiada que ya no existe). */
export function removedFunctions(files, changed, root = "supabase/functions") {
  const present = new Set(Object.keys(files).map((f) => f.slice(root.length + 1).split("/")[0]));
  const gone = new Set();
  for (const c of changed) {
    if (!c.startsWith(`${root}/`)) continue;
    const rel = c.slice(root.length + 1);
    const dir = rel.split("/")[0];
    if (rel.includes("/") && dir && !dir.startsWith("_") && !present.has(dir)) gone.add(dir);
  }
  return [...gone].sort();
}

/**
 * Keys sembradas por una migración en `features`, `feature_flags` o
 * `system_settings` (primer literal de cada fila de `values`).
 */
export function extractFlags(sql) {
  const out = [];
  const clean = String(sql).replace(/--[^\n]*/g, "");
  for (const stmt of clean.split(";")) {
    const m = /insert\s+into\s+(?:public\.)?(features|feature_flags|system_settings)\b[\s\S]*?\bvalues\b([\s\S]*)/i.exec(stmt);
    if (!m) continue;
    const table = (m[1] ?? "").toLowerCase();
    const rows = m[2] ?? "";
    const re = /(?:^|[,\s])\(\s*'([a-z0-9_.-]+)'/gi;
    let r;
    while ((r = re.exec(rows))) if (r[1]) out.push({ table, key: r[1] });
  }
  return out.filter((f, i, a) => a.findIndex((g) => g.table === f.table && g.key === f.key) === i);
}

// ---------------------------------------------------------------- estado

/** "aplicada en prod" de una migración. */
export function migrationStatus(file, { applied, inProd }) {
  if (applied) {
    const m = /^(\d{14})_(.+)\.sql$/.exec(file);
    const version = m?.[1];
    const name = m?.[2];
    const hit = applied.some((a) => a.version === version || (a.name && (a.name === name || a.name === `${version}_${name}`)));
    return hit ? "sí (verificada)" : "no";
  }
  return inProd ? "sí (en main)" : "pendiente de verificar";
}

/** "desplegada" de una Edge: con datos remotos, updated_at ≥ fecha del bloque. */
export function functionStatus(slug, { deployed, inProd, since }) {
  if (deployed) {
    const d = deployed.find((x) => x.slug === slug);
    if (!d) return "no desplegada";
    const at = typeof d.updated_at === "number" ? d.updated_at : Date.parse(String(d.updated_at ?? ""));
    if (!Number.isFinite(at)) return "desplegada (sin fecha)";
    const day = new Date(at).toISOString().slice(0, 10);
    return since && at < Date.parse(since) ? `no (última ${day})` : `sí (${day})`;
  }
  return inProd ? "sí (en main)" : "pendiente";
}

// ---------------------------------------------------------------- registro

const short = (sha) => (sha ? String(sha).slice(0, 8) : "");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function prLink(n, repoUrl) {
  if (n == null) return "—";
  return repoUrl ? `[#${n}](${repoUrl}/pull/${n})` : `#${n}`;
}

/**
 * Markdown del registro del deploy. `rel` = {version, date, from, to,
 * blocks: [{title, kind, pr, merge, base, end, date, prs, migrations,
 * functions, removed, flags, configChanged}], repoUrl, sources}.
 */
export function renderRecord(rel) {
  const { version, date, blocks, repoUrl } = rel;
  const total = (k) => blocks.reduce((n, b) => n + (b[k]?.length ?? 0), 0);
  const L = [];
  L.push(`# v${version} · ${date}`, "");
  L.push("> Registro del deploy generado por `pnpm release:prepare` (OPS-53). Las columnas *aplicada en prod* y *desplegada* se completan o corrigen después del deploy (ver `docs/workflows/release-workflow.md`).", "");
  L.push(`- **Versión:** \`${version}\``);
  L.push(`- **Fecha:** ${date}`);
  L.push(`- **Rango:** \`${short(rel.from)}..${short(rel.to)}\``);
  L.push(`- **CHANGELOG:** [\`[${version}] - ${date}\`](../../CHANGELOG.md${changelogAnchor(version, date)})`);
  L.push(`- **Contenido:** ${total("prs")} PRs, ${total("migrations")} migraciones y ${total("functions")} Edge Functions en ${blocks.length} ${blocks.length === 1 ? "bloque" : "bloques"} de deploy.`);
  if (rel.sources) L.push(`- **Estado:** ${rel.sources}`);
  L.push("");
  blocks.forEach((b, i) => {
    L.push(`## ${i + 1}. ${b.title}`, "");
    const meta = [`rango \`${short(b.base)}..${short(b.end)}\``];
    if (b.merge) meta.push(`merge \`${short(b.merge)}\``);
    if (b.pr != null) meta.push(`PR de deploy ${prLink(b.pr, repoUrl)}`);
    if (b.date) meta.push(b.kind === "deploy" ? `mergeado ${b.date}` : `último commit ${b.date}`);
    L.push(`${meta.join(" · ")}.`, "");
    L.push(`### PRs (${b.prs.length})`, "");
    if (b.prs.length) {
      L.push("| PR | Tarea | Título | Commit |", "|---|---|---|---|");
      for (const p of b.prs) L.push(`| ${prLink(p.pr, repoUrl)} | ${cell(p.task ?? "—")} | ${cell(p.title)} | \`${short(p.sha)}\` |`);
    } else L.push("Sin PRs.");
    L.push("");
    L.push(`### Migraciones (${b.migrations.length})`, "");
    if (b.migrations.length) {
      L.push("| Archivo | Aplicada en prod |", "|---|---|");
      for (const m of b.migrations) L.push(`| \`${m.file}\` | ${m.status} |`);
    } else L.push("Sin migraciones.");
    L.push("");
    L.push(`### Edge Functions (${b.functions.length})`, "");
    if (b.functions.length) {
      L.push("| Función | Motivo | Desplegada |", "|---|---|---|");
      for (const f of b.functions) {
        const why = [f.own ? "código propio" : null, ...f.via.map((v) => `\`${v.replace(/^supabase\/functions\//, "")}\``)].filter(Boolean).join(", ");
        L.push(`| \`${f.slug}\` | ${why} | ${f.status} |`);
      }
    } else L.push("Sin Edge Functions.");
    L.push("");
    const notes = [];
    for (const f of b.flags ?? []) notes.push(`Flag/feature sembrado: \`${f.key}\` en \`${f.table}\` (${f.file}).`);
    for (const r of b.removed ?? []) notes.push(`Edge borrada del repo: \`${r}\` (borrarla también del proyecto si sigue desplegada).`);
    if (b.configChanged) notes.push("Cambió `supabase/config.toml` (revisar `verify_jwt` y settings de Auth).");
    for (const n of b.notes ?? []) notes.push(n);
    L.push("### Notas", "");
    L.push(...(notes.length ? notes.map((n) => `- ${n}`) : ["- Sin flags ni notas automáticas."]), "");
  });
  L.push("---", "");
  L.push("*Aplicada en prod:* `sí (verificada)` = está en `supabase_migrations.schema_migrations` (`--remote`/`--applied`); `sí (en main)` = el bloque ya estaba mergeado en `main` y se tomó por aplicada; `pendiente de verificar` = todavía no. *Desplegada:* con `--remote`/`--deployed`, `sí` si la Edge se desplegó después del último commit del bloque que la tocó (su carpeta o lo que importa). Una Edge cambiada sólo por un `_shared/` también hay que redesplegarla.", "");
  L.push("Si el cambio de un `_shared/` no toca lo que usa esa Edge (por ejemplo, una opción nueva que no pasa), un `no` es esperable: anotarlo en las notas del bloque en lugar de redesplegar a ciegas.", "");
  L.push("El PR de release que agrega este registro no figura en las tablas.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- CLI (git)

function gitIn(root) {
  return (args, input) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
}

function tryGit(git, args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

export function defaultFrom(git, to, prod) {
  const tag = tryGit(git, ["describe", "--tags", "--abbrev=0", "--match", "v*", to]);
  if (tag) return tag;
  const fp = tryGit(git, ["log", "--first-parent", "--merges", "--format=%H%x09%s", prod]) ?? "";
  for (const line of fp.split("\n")) {
    const [sha, subject] = line.split("\t");
    if (sha && subject && parseDeployMerge(subject)) return sha;
  }
  throw new Error("no hay tag v* ni merge de tanda/* en el first-parent: pasá --from");
}

/** Contenidos de supabase/functions en `ref` ({ruta: texto}). */
function functionFiles(git, ref) {
  const list = (tryGit(git, ["ls-tree", "-r", "--name-only", ref, "--", "supabase/functions"]) ?? "")
    .split("\n")
    .filter((f) => /\.(ts|tsx|js|mjs|mts)$/.test(f));
  if (!list.length) return {};
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: git.root,
    input: list.map((f) => `${ref}:${f}`).join("\n") + "\n",
    maxBuffer: 256 * 1024 * 1024,
  });
  const files = {};
  let pos = 0;
  for (const f of list) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString("utf8").split(" ");
    const size = Number(header[2]);
    files[f] = out.subarray(nl + 1, nl + 1 + size).toString("utf8");
    pos = nl + 1 + size + 1;
  }
  return files;
}

function isAncestor(git, a, b) {
  try {
    git(["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

async function remoteState() {
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
  const deployed = (await f.json()).map((x) => ({ slug: x.slug, updated_at: x.updated_at }));
  return { applied, deployed };
}

function parseDeployed(text) {
  const j = JSON.parse(text);
  const arr = Array.isArray(j) ? j : (j.functions ?? j.result ?? []);
  return arr.map((x) => ({ slug: x.slug ?? x.name, updated_at: x.updated_at ?? x.updatedAt ?? null }));
}

/** Arma el registro completo leyendo git (sin escribir nada). */
export async function collectRelease(root, opts) {
  const git = gitIn(root);
  git.root = root;
  const to = git(["rev-parse", opts.to ?? "HEAD"]).trim();
  const prod = opts.prod ?? "origin/main";
  const from = git(["rev-parse", opts.from ?? defaultFrom(git, to, prod)]).trim();
  const prodSha = tryGit(git, ["rev-parse", prod]);
  const fpText = git(["log", "--first-parent", "--reverse", "--format=%H%x09%P%x09%cs%x09%s", `${from}..${to}`]);
  const firstParent = fpText
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, parents, date, ...s] = l.split("\t");
      return { sha: sha ?? "", parents: (parents ?? "").split(" ").filter(Boolean), date: date ?? "", subject: s.join("\t") };
    });
  const commitsOf = (a, b) =>
    git(["log", "--no-merges", "--reverse", "--format=%H%x09%P%x09%cs%x09%s", `${a}..${b}`])
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, parents, date, ...s] = l.split("\t");
        return { sha: sha ?? "", parents: (parents ?? "").split(" ").filter(Boolean), date: date ?? "", subject: s.join("\t") };
      });
  const raw = groupBlocks(from, firstParent, commitsOf);

  let applied = null;
  let deployed = null;
  const sources = [];
  if (opts.remote) {
    ({ applied, deployed } = await remoteState());
    sources.push("migraciones y Edges verificadas con la Management API");
  }
  if (opts.applied) {
    applied = parseApplied(readFileSync(opts.applied, "utf8"));
    sources.push(`migraciones verificadas con \`${path.basename(opts.applied)}\``);
  }
  if (opts.deployed) {
    deployed = parseDeployed(readFileSync(opts.deployed, "utf8"));
    sources.push(`Edges verificadas con \`${path.basename(opts.deployed)}\``);
  }
  if (!sources.length) sources.push(`sin datos remotos: lo mergeado en \`${prod}\` figura aplicado/desplegado, el resto pendiente de verificar`);

  const blocks = raw.map((b) => {
    const inProd = Boolean(prodSha && isAncestor(git, b.end, prodSha));
    const changes = parseNameStatus(git(["diff", "--name-status", "-M", b.base, b.end]));
    const changed = changes.map((c) => c.file);
    const files = functionFiles(git, b.end);
    // Para "desplegada": la Edge tiene que ser posterior al último commit del
    // bloque que tocó su carpeta o algo que importa.
    const sinceOf = (f) =>
      tryGit(git, ["log", "-1", "--format=%cI", `${b.base}..${b.end}`, "--", ...(f.own ? [`supabase/functions/${f.slug}`] : []), ...f.via]) || null;
    const migs = addedMigrations(changes);
    const flags = migs.flatMap((file) => extractFlags(tryGit(git, ["show", `${b.end}:supabase/migrations/${file}`]) ?? "").map((f) => ({ ...f, file })));
    const title =
      b.kind === "deploy"
        ? `${b.branch}`
        : `${opts.tanda ?? (tryGit(git, ["branch", "--show-current"]) || "pendiente")} (este deploy)`;
    return {
      ...b,
      title,
      prs: b.commits.map((c) => ({ sha: c.sha, ...parseCommitSubject(c.subject) })),
      migrations: migs.map((file) => ({ file, status: migrationStatus(file, { applied, inProd }) })),
      functions: affectedFunctions(files, changed).map((f) => ({ ...f, status: functionStatus(f.slug, { deployed, inProd, since: deployed ? sinceOf(f) : null }) })),
      removed: removedFunctions(files, changed),
      flags,
      configChanged: changed.includes("supabase/config.toml"),
    };
  });
  const origin = tryGit(git, ["remote", "get-url", "origin"]) ?? "";
  const gh = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin);
  return { from, to, blocks, repoUrl: gh ? `https://github.com/${gh[1]}` : null, sources: sources.join("; ") + "." };
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) opts[key] = a.slice(eq + 1);
    else if (rest[i + 1] && !String(rest[i + 1]).startsWith("--")) opts[key] = rest[++i];
    else opts[key] = true;
  }
  return { cmd, opts };
}

const today = () => new Date().toISOString().slice(0, 10);

export async function main(argv, root) {
  const { cmd, opts } = parseArgs(argv);
  const changelogPath = path.join(root, "CHANGELOG.md");
  if (cmd === "notes") {
    if (!opts.version) throw new Error("uso: release.mjs notes --version X.Y.Z");
    const body = changelogSection(readFileSync(changelogPath, "utf8"), String(opts.version));
    if (body == null) throw new Error(`el CHANGELOG no tiene la sección [${opts.version}]`);
    const record = `docs/releases/v${opts.version}.md`;
    const md = readFileSync(changelogPath, "utf8");
    const date = new RegExp(`^## \\[${String(opts.version).replace(/\./g, "\\.")}\\] - (\\S+)`, "m").exec(md)?.[1];
    const origin = tryGit(gitIn(root), ["remote", "get-url", "origin"]) ?? "";
    const gh = /github\.com[:/](.+?)(?:\.git)?$/.exec(origin);
    const changelogUrl = gh && date ? `https://github.com/${gh[1]}/blob/v${opts.version}/CHANGELOG.md${changelogAnchor(String(opts.version), date)}` : null;
    process.stdout.write(releaseNotes(body, { record: existsSync(path.join(root, record)) ? record : null, changelogUrl }));
    return;
  }
  const usage = "uso: release.mjs prepare --version X.Y.Z [--date AAAA-MM-DD] [--from ref] [--to ref] | record --version X.Y.Z [--from ref] [--to ref] | notes --version X.Y.Z";
  if (cmd !== "prepare" && cmd !== "record") throw new Error(usage);
  const version = String(opts.version ?? "");
  if (!parseSemver(version)) throw new Error(`versión inválida: "${version}" (formato X.Y.Z)`);
  const recordPath = path.join(root, "docs", "releases", `v${version}.md`);
  const recordRel = path.relative(root, recordPath).split(path.sep).join("/");
  const changelog = readFileSync(changelogPath, "utf8");
  let date = String(opts.date ?? today());
  let nextPkg = null;
  let nextChangelog = null;
  if (cmd === "prepare") {
    nextPkg = bumpPackageJson(readFileSync(path.join(root, "package.json"), "utf8"), version);
    nextChangelog = cutChangelog(changelog, version, date);
    if (existsSync(recordPath) && !opts.force) throw new Error(`ya existe ${recordRel} (--force para regenerarlo)`);
  } else {
    // record: regenera sólo el registro (p. ej. después del deploy con --remote
    // para completar "aplicada"/"desplegada"). La fecha sale del CHANGELOG.
    const h = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})`, "m").exec(changelog);
    if (!h) throw new Error(`el CHANGELOG no tiene la sección [${version}]: corré prepare primero`);
    if (!opts.date) date = h[1] ?? date;
  }
  const rel = await collectRelease(root, opts);
  const record = renderRecord({ version, date, ...rel });
  if (opts.dryRun) {
    process.stdout.write(record);
    return;
  }
  if (nextPkg) writeFileSync(path.join(root, "package.json"), nextPkg);
  if (nextChangelog) writeFileSync(changelogPath, nextChangelog);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, record);
  const n = (k) => rel.blocks.reduce((s, b) => s + b[k].length, 0);
  console.log(`v${version} (${date}): ${cmd === "prepare" ? "package.json, CHANGELOG.md y " : ""}${recordRel}`);
  console.log(`  ${rel.blocks.length} bloques · ${n("prs")} PRs · ${n("migrations")} migraciones · ${n("functions")} Edge Functions`);
}

// realpath de ambos lados (como roadmap-progress): un symlink o la
// capitalización de Windows no dejan el CLI sin correr.
const isMain = (() => {
  try {
    const a = realpathSync(process.argv[1] ?? "");
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  main(process.argv.slice(2), root).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
