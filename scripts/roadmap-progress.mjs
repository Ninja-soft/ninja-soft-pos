#!/usr/bin/env node
// =============================================================================
// Avance del roadmap por fase (docs/02-roadmap.md).
//
// Cuenta los checkboxes de cada fase (F0 a F18 y TX): `- [x]` hecho,
// `- [~]` parcial, `- [ ]` pendiente, a cualquier nivel de sangría.
// Una sección de fase empieza en un título `## Fx` o `### Fx` (o `TX`) y
// termina en el próximo título de fase o en otro título del mismo nivel o
// superior (subtítulos como "### Entregables" dentro de "## F0" no la cortan). Las
// secciones que repiten una fase (p. ej. "F3 robustecida") suman a esa fase.
// No cuentan los gates de "Cortes de control" (son plantillas por hito) ni el
// backlog.
//
// Uso:
//   node scripts/roadmap-progress.mjs           imprime la tabla
//   node scripts/roadmap-progress.mjs --write   la reescribe en el roadmap,
//                                               entre los marcadores
//                                               <!-- roadmap-progress:start/end -->
// Puro Node, sin dependencias.
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "docs", "02-roadmap.md");
const START = "<!-- roadmap-progress:start -->";
const END = "<!-- roadmap-progress:end -->";

const PHASE_HEADING = /^(#{2,3})\s+(F\d+(?:\.\d+)?|TX)\b/;
const ANY_HEADING = /^(#{2,3})\s+/;
const CHECKBOX = /^\s*[-*]\s+\[( |x|X|~)\]/;

export function countByPhase(markdown) {
  const phases = new Map();
  let current = null;
  let level = 0;
  let inBlock = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.includes(START)) inBlock = true;
    if (inBlock) {
      if (line.includes(END)) inBlock = false;
      continue;
    }
    const ph = line.match(PHASE_HEADING);
    if (ph) {
      current = ph[2];
      level = ph[1].length;
      if (!phases.has(current)) phases.set(current, { done: 0, partial: 0, pending: 0 });
      continue;
    }
    const h = line.match(ANY_HEADING);
    if (h) {
      // Un subtítulo ("### Entregables" dentro de "## F0") no corta la fase.
      if (h[1].length <= level) current = null;
      continue;
    }
    if (!current) continue;
    const cb = line.match(CHECKBOX);
    if (!cb) continue;
    const c = phases.get(current);
    if (cb[1] === "~") c.partial++;
    else if (cb[1] === " ") c.pending++;
    else c.done++;
  }
  return phases;
}

function phaseOrder(a, b) {
  const n = (k) => (k === "TX" ? Number.POSITIVE_INFINITY : Number(k.slice(1)));
  return n(a) - n(b);
}

const pct = (num, den) => (den === 0 ? "0%" : `${Math.round((num / den) * 100)}%`);

export function renderTable(phases) {
  const rows = [...phases.keys()].sort(phaseOrder).map((k) => {
    const { done, partial, pending } = phases.get(k);
    const total = done + partial + pending;
    return { k, done, partial, pending, total };
  }).filter((r) => r.total > 0); // F1 se sigue en 01-mvp.md, sin checkboxes acá.
  const sum = rows.reduce(
    (a, r) => ({
      done: a.done + r.done,
      partial: a.partial + r.partial,
      pending: a.pending + r.pending,
      total: a.total + r.total,
    }),
    { done: 0, partial: 0, pending: 0, total: 0 },
  );
  const line = (label, r) =>
    `| ${label} | ${r.done}/${r.total} | ${r.partial} | ${r.pending} | ${pct(r.done, r.total)} | ${pct(r.done + r.partial / 2, r.total)} |`;
  return [
    "| Fase | Hechos/total | Parciales | Pendientes | % hecho | % con parciales a la mitad |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => line(`**${r.k}**`, r)),
    line("**Total**", sum),
  ].join("\n");
}

function main() {
  const md = readFileSync(FILE, "utf8");
  const table = renderTable(countByPhase(md));
  if (!process.argv.includes("--write")) {
    process.stdout.write(table + "\n");
    return;
  }
  const s = md.indexOf(START);
  const e = md.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    console.error(`No encuentro los marcadores ${START} / ${END} en ${FILE}`);
    process.exit(1);
  }
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const out = md.slice(0, s + START.length) + eol + table.replace(/\n/g, eol) + eol + md.slice(e);
  writeFileSync(FILE, out);
  process.stdout.write(table + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
