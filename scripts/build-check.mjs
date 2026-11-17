#!/usr/bin/env node
// =============================================================================
// Chequeo post-build (OPS-55): falla si `next build` no dejó `.next/BUILD_ID`.
//
// Por qué existe: en Linux, si el worker del chequeo de tipos de `next build`
// (Next 14.2) muere por falta de memoria, V8 aborta con SIGABRT y el proceso
// hijo sale con código `null`. El jest-worker que trae Next trata `null` como
// un cierre normal: no rechaza la llamada pendiente, el proceso padre se queda
// sin nada en el event loop y termina con código 0 sin haber escrito el build.
// En CI eso pasaba como verde (OPS-15). Este script corre encadenado al build
// (`"build": "next build && node scripts/build-check.mjs"`), así protege al
// CI, a Vercel y a cualquier `pnpm build` local.
//
// Uso:
//   node scripts/build-check.mjs              chequea ./.next
//   node scripts/build-check.mjs --dist=out   chequea otro distDir
// Puro Node, sin dependencias.
// =============================================================================

import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Devuelve `{ ok: true, buildId }` si `<distDir>/BUILD_ID` existe y no está
 * vacío; si no, `{ ok: false, reason }`.
 * @param {string} distDir
 * @returns {{ ok: true, buildId: string } | { ok: false, reason: string }}
 */
export function checkBuild(distDir) {
  const file = join(distDir, "BUILD_ID");
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: `no existe ${file}` };
  }
  const buildId = content.trim();
  if (!buildId) return { ok: false, reason: `${file} está vacío` };
  return { ok: true, buildId };
}

function main() {
  const distArg = process.argv.slice(2).find((a) => a.startsWith("--dist="));
  const distDir = resolve(distArg ? distArg.slice("--dist=".length) : ".next");
  const result = checkBuild(distDir);
  if (!result.ok) {
    console.error(
      `build-check: next build terminó sin generar el build (${result.reason}). ` +
        "Lo más probable es que el chequeo de tipos se haya quedado sin memoria: " +
        "subí el heap con NODE_OPTIONS=--max-old-space-size=6144 y mirá el log de arriba.",
    );
    process.exit(1);
  }
  console.log(`build-check: ok (BUILD_ID ${result.buildId})`);
}

// realpath de ambos lados: un symlink o la capitalización de Windows no dejan
// el chequeo saliendo 0 sin correr.
const isMain = (() => {
  try {
    const a = realpathSync(process.argv[1] ?? "");
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();
if (isMain) main();
