#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Sonda de muestra para Tiendita (DEMO, no es el import productivo).
 *
 * Lee ~N filas reales por tienda del Excel (streaming) y emite sentencias
 * INSERT multi-fila para `catalog_products` por stdout. Se usa para cargar un
 * SAMPLE vía mcp__supabase__execute_sql cuando no se tiene el service_role key
 * para correr el import completo (scripts/import_catalog.cjs).
 *
 * USO:
 *   node scripts/sample_catalog_sql.cjs <archivo.xlsx> [filasPorTienda=250] [SOLO_TIENDA] > sample.sql
 *
 * Si se pasa SOLO_TIENDA (ej. CARREFOUR), emite sólo esa hoja sin begin/commit
 * (útil para cargar de a una por mcp__supabase__execute_sql).
 */
const path = require("path");
const ExcelJS = require("exceljs");

const SUMMARY_SHEET = "resumen";

function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if ("text" in v && v.text != null) return String(v.text);
    if ("result" in v && v.result != null) return String(v.result);
    if ("richText" in v && Array.isArray(v.richText))
      return v.richText.map((t) => t.text).join("");
    if ("hyperlink" in v && v.hyperlink) return String(v.hyperlink);
    return "";
  }
  return String(v);
}
function buildHeaderMap(values) {
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (raw == null) continue;
    const key = String(cellText(raw)).trim().toUpperCase();
    if (key) map[key] = i;
  }
  return map;
}
function num(v) {
  const t = cellText(v).replace(",", ".").trim();
  if (t === "") return "null";
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : "null";
}
function txt(v) {
  const t = cellText(v).trim();
  if (t === "") return "null";
  return "'" + t.replace(/'/g, "''") + "'";
}
function boolSiNo(v) {
  return cellText(v).trim().toUpperCase() === "SI" ? "true" : "false";
}

async function main() {
  const file = process.argv[2];
  const perStore = Number(process.argv[3] || 250);
  const onlyStore = (process.argv[4] || "").trim().toUpperCase() || null;
  if (!file) {
    console.error("Uso: node scripts/sample_catalog_sql.cjs <archivo.xlsx> [filasPorTienda] [SOLO_TIENDA]");
    process.exit(1);
  }
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path.resolve(file), {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
  });

  console.log("-- SAMPLE Tiendita (demo). Generado por scripts/sample_catalog_sql.cjs");
  if (!onlyStore) console.log("begin;");

  for await (const ws of reader) {
    const storeKey = (ws.name || "").trim().toUpperCase();
    if (storeKey.toLowerCase() === SUMMARY_SHEET) continue;
    if (onlyStore && storeKey !== onlyStore) continue;

    let header = null;
    let n = 0;
    let rowNum = 0;
    const seen = new Set();
    const rows = [];

    for await (const row of ws) {
      rowNum++;
      const values = row.values;
      if (rowNum === 1) {
        header = buildHeaderMap(values);
        continue;
      }
      if (n >= perStore) break;
      const get = (c) => values[header[c]];
      const eanRaw = cellText(get("EAN")).trim();
      const titRaw = cellText(get("TITULO")).trim();
      if (!eanRaw || !titRaw) continue;
      if (seen.has(eanRaw)) continue; // dedupe dentro de la hoja (clave de upsert)
      seen.add(eanRaw);
      n++;
      rows.push(
        "(" +
          [
            "'" + storeKey + "'",
            txt(get("EAN")),
            txt(get("TITULO")),
            num(get("PRECIO")),
            num(get("PRECIO_LISTA")),
            txt(get("MARCA")),
            txt(get("CATEGORIA")),
            txt(get("FOTO_FIREBASE")),
            boolSiNo(get("DISPONIBLE")),
            txt(get("ESTADO")),
            txt(get("ID_ORIGEN")),
          ].join(", ") +
          ")",
      );
    }

    if (rows.length > 0) {
      console.log(
        "insert into catalog_products " +
          "(store_key, ean, titulo, precio, precio_lista, marca, categoria_path, foto_url, disponible, estado, id_origen) values",
      );
      console.log(rows.join(",\n"));
      console.log("on conflict (store_key, ean) do nothing;");
      console.error(`[sample] ${storeKey}: ${rows.length} filas`);
    }
  }

  if (!onlyStore) console.log("commit;");
}
main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
