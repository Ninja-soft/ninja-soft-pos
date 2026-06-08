#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Tiendita — Import batcheado de catálogos precargados.
 *
 * El Excel es ENORME (cientos de miles de filas) y NO entra en memoria: el
 * `wb.xlsx.readFile()` normal hace OOM. Por eso usamos el lector STREAMING de
 * exceljs (ExcelJS.stream.xlsx.WorkbookReader), recorremos cada hoja de tienda
 * fila por fila y hacemos UPSERT batcheado (1000 filas) en `catalog_products`
 * con on conflict (store_key, ean).
 *
 * Cada HOJA del Excel es una tienda de origen (CARREFOUR, COTO, DIA, EASY,
 * JUMBO). La hoja "Resumen" se ignora. Las columnas esperadas (header en la
 * fila 1) son:
 *   SUPER, EAN, TITULO, PRECIO, PRECIO_LISTA, MARCA, CATEGORIA, DISPONIBLE,
 *   ESTADO, FOTO_FIREBASE, URL_FOTO_ORIGEN, URL_PRODUCTO, ID_ORIGEN,
 *   FIRST_SEEN, LAST_SEEN, MISSING_SINCE
 *
 * Al terminar cada tienda actualiza catalog_stores.product_count /
 * last_import_at, y al final llama notify_catalog_update(catalog_id) para cada
 * catálogo afectado (avisa a los tenants "+N productos nuevos").
 *
 * USO:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  \
 *     node scripts/import_catalog.cjs <archivo.xlsx>
 *
 * Variables de entorno (se leen de process.env; podés exportarlas o usar un
 * .env cargado por tu shell):
 *   - SUPABASE_URL                (o NEXT_PUBLIC_SUPABASE_URL)
 *   - SUPABASE_SERVICE_ROLE_KEY   (service_role — NUNCA en frontend)
 *
 * El service_role saltea RLS, así que el upsert masivo entra directo. Este
 * script corre SERVER-SIDE únicamente (regla del proyecto).
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { createClient } = require("@supabase/supabase-js");

// Carga .env.local / .env sin dependencias: completa process.env con las claves
// que falten. Así alcanza con poner SUPABASE_SERVICE_ROLE_KEY en .env.local
// (gitignored) y correr `node scripts/import_catalog.cjs <archivo.xlsx>` —
// no hace falta exportar variables a mano.
for (const envFile of [".env.local", ".env"]) {
  const p = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (val && process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const BATCH_SIZE = 1000;
const SUMMARY_SHEET = "resumen";

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg) {
  console.error(`\n[import_catalog] ERROR: ${msg}\n`);
  process.exit(1);
}

// Header → índice de columna (exceljs `row.values` es 1-indexado; values[0] es
// null). Normaliza el nombre del header (mayúsculas, sin espacios extra).
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

// exceljs devuelve a veces objetos {text}, {result}, {richText}, hyperlinks…
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

function toNumOrNull(v) {
  const t = cellText(v).replace(",", ".").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function toTextOrNull(v) {
  const t = cellText(v).trim();
  return t === "" ? null : t;
}

function siNo(v) {
  return cellText(v).trim().toUpperCase() === "SI";
}

async function main() {
  const file = process.argv[2];
  if (!file) die("falta el archivo. Uso: node scripts/import_catalog.cjs <archivo.xlsx>");
  if (!SUPABASE_URL) die("falta SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL) en el entorno.");
  if (!SERVICE_ROLE_KEY) die("falta SUPABASE_SERVICE_ROLE_KEY en el entorno.");

  const abs = path.resolve(file);
  console.log(`[import_catalog] Archivo: ${abs}`);
  console.log(`[import_catalog] Supabase: ${SUPABASE_URL}`);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Tiendas conocidas (catalog_stores). Sólo importamos hojas cuya key exista.
  const { data: stores, error: storesErr } = await supabase
    .from("catalog_stores")
    .select("key");
  if (storesErr) die(`no se pudo leer catalog_stores: ${storesErr.message}`);
  const knownStores = new Set((stores ?? []).map((s) => s.key.toUpperCase()));
  console.log(`[import_catalog] Tiendas conocidas: ${[...knownStores].join(", ")}`);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(abs, {
    worksheets: "emit",
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
  });

  const touchedStores = [];
  const t0 = Date.now();

  for await (const ws of reader) {
    const sheetName = (ws.name || "").trim();
    const storeKey = sheetName.toUpperCase();

    if (storeKey.toLowerCase() === SUMMARY_SHEET) {
      console.log(`[import_catalog] (hoja "${sheetName}" ignorada — resumen)`);
      continue;
    }
    if (!knownStores.has(storeKey)) {
      console.log(
        `[import_catalog] (hoja "${sheetName}" ignorada — no es una tienda conocida)`,
      );
      continue;
    }

    console.log(`\n[import_catalog] === Tienda ${storeKey} ===`);
    let header = null;
    let batch = [];
    let imported = 0;
    let rowNum = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      const { error } = await supabase
        .from("catalog_products")
        .upsert(rows, { onConflict: "store_key,ean", ignoreDuplicates: false });
      if (error) {
        die(
          `upsert falló en ${storeKey} (lote de ${rows.length}, ~fila ${rowNum}): ${error.message}`,
        );
      }
      imported += rows.length;
      process.stdout.write(`\r[import_catalog] ${storeKey}: ${imported} filas…`);
    };

    for await (const row of ws) {
      rowNum++;
      const values = row.values; // 1-indexado
      if (rowNum === 1) {
        header = buildHeaderMap(values);
        // Validación mínima de columnas.
        for (const req of ["EAN", "TITULO"]) {
          if (!header[req]) die(`la hoja ${storeKey} no tiene la columna ${req}.`);
        }
        continue;
      }

      const get = (col) => values[header[col]];
      const ean = toTextOrNull(get("EAN"));
      const titulo = toTextOrNull(get("TITULO"));
      // Sin EAN o sin título no hay producto válido (y EAN es la clave de upsert).
      if (!ean || !titulo) continue;

      batch.push({
        store_key: storeKey,
        ean,
        titulo,
        precio: toNumOrNull(get("PRECIO")),
        precio_lista: toNumOrNull(get("PRECIO_LISTA")),
        marca: toTextOrNull(get("MARCA")),
        categoria_path: toTextOrNull(get("CATEGORIA")),
        foto_url: toTextOrNull(get("FOTO_FIREBASE")),
        disponible: siNo(get("DISPONIBLE")),
        estado: toTextOrNull(get("ESTADO")),
        id_origen: toTextOrNull(get("ID_ORIGEN")),
        updated_at: new Date().toISOString(),
      });

      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    process.stdout.write("\n");

    // product_count real (post-upsert) por si el archivo tenía duplicados de EAN.
    const { count } = await supabase
      .from("catalog_products")
      .select("id", { count: "exact", head: true })
      .eq("store_key", storeKey);

    await supabase
      .from("catalog_stores")
      .update({
        product_count: count ?? imported,
        last_import_at: new Date().toISOString(),
      })
      .eq("key", storeKey);

    console.log(
      `[import_catalog] ${storeKey}: ${imported} filas procesadas, ${count ?? "?"} productos en total.`,
    );
    touchedStores.push(storeKey);
  }

  // Notificar a los tenants de cada catálogo que incluye alguna tienda tocada.
  if (touchedStores.length > 0) {
    const { data: maps } = await supabase
      .from("catalog_store_map")
      .select("catalog_id, store_key")
      .in("store_key", touchedStores);
    const catalogIds = [...new Set((maps ?? []).map((m) => m.catalog_id))];
    console.log(
      `\n[import_catalog] Catálogos afectados: ${catalogIds.length}. Refrescando conteos y notificando…`,
    );
    for (const cid of catalogIds) {
      // Conteo PÚBLICO del catálogo (catalogs.product_count, deduplicado por EAN
      // si aplica). Lo escribe el service_role (auth.uid() null) aunque
      // notify_catalog_update falle por no ser is_internal(): así el storefront
      // muestra "Incluye N productos" siempre fresco.
      const { data: cnt, error: cntErr } = await supabase.rpc(
        "catalog_recount_products",
        { p_catalog_id: cid },
      );
      if (cntErr) {
        console.warn(
          `[import_catalog] catalog_recount_products(${cid}) falló: ${cntErr.message}`,
        );
      } else {
        console.log(
          `[import_catalog] catálogo ${cid}: ${cnt} productos (conteo público actualizado).`,
        );
      }

      const { data, error } = await supabase.rpc("notify_catalog_update", {
        p_catalog_id: cid,
      });
      if (error) {
        // No abortamos: la notificación es best-effort. El service_role no es
        // is_internal() por JWT, así que esta RPC puede requerir correrla desde
        // el panel interno. Lo registramos honestamente.
        console.warn(
          `[import_catalog] notify_catalog_update(${cid}) falló: ${error.message} ` +
            `(corré la notificación desde el panel interno si hace falta).`,
        );
      } else {
        console.log(`[import_catalog] catálogo ${cid}: ${data} tenant(s) notificados.`);
      }
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[import_catalog] LISTO en ${secs}s. Tiendas: ${touchedStores.join(", ")}.`);
}

main().catch((e) => die(e?.message || String(e)));
