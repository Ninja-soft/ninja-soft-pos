// PRD-02: linaje de create_sale. Cada migración que la recrea tiene que partir
// de la definición anterior (copia de producción + bloques marcados). Si alguien
// copia una versión vieja, se pierden en silencio los bloques posteriores (por
// ejemplo, precio libre de ADR-151 o la clave de SEC-43). Estos helpers comparan
// cada definición con la anterior; los usa tests/unit/createSalePromoIntegrity.test.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CreateSaleDef {
  file: string;
  body: string;
}

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
export const CREATE_SALE_RE = /create or replace function (public\.)?create_sale\(/;
/** Desde acá create_sale tiene el motor de promociones (ADR-074). */
export const LINEAGE_FROM = "20261102100300_promociones_venta.sql";

export const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/** Cuerpo de create_sale (de `create or replace` al cierre del $$), o null. */
export function createSaleBody(sql: string): string | null {
  const text = sql.replace(/\r\n/g, "\n");
  const i = text.search(CREATE_SALE_RE);
  if (i < 0) return null;
  const rest = text.slice(i);
  const end = rest.search(/\n\$(function)?\$;/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Todas las definiciones de create_sale, en orden de migración. */
export function createSaleDefs(dir = MIGRATIONS_DIR): CreateSaleDef[] {
  const out: CreateSaleDef[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const body = createSaleBody(readFileSync(join(dir, file), "utf8"));
    if (body) out.push({ file, body });
  }
  return out;
}

/**
 * Huellas de cada ADR en create_sale. Una huella que estaba en la definición
 * anterior tiene que seguir en la nueva (se comparan sin espacios de más).
 */
export const FINGERPRINTS: Record<string, string[]> = {
  "ADR-074 (promociones)": [
    "v_promo_eval := _promo_evaluate(v_tenant, v_promo_lines, v_promo_ctx);",
    "'excluded', (nullif(x.v ->> 'gift_promo_id', '') is not null or nullif(x.v ->> 'pack_credit_id', '') is not null)",
    "perform pg_advisory_xact_lock(hashtext('promo_use:' || pr.id::text))",
    "if p_coupon_id is not null then v_promo_eval := v_promo_eval || jsonb_build_object('discount', 0, 'applied', '[]'::jsonb); end if;",
    "if coalesce(p_promo_discount, 0) > 0 and not tenant_has_feature_for(v_tenant, 'promociones') then",
    "message = 'promo_mismatch:'",
    "raise exception 'promo_gift_invalid';",
    "insert into sale_promotions",
  ],
  "F9 · H54 (cupón con tope)": [
    "raise exception 'coupon_usage_exceeded';",
    "raise exception 'coupon_customer_exceeded';",
    "greatest(v_subtotal - coalesce(p_discount_total, 0) - v_promo_disc, 0)",
    "update coupons set used_count = used_count + 1",
  ],
  "ADR-077 (offline)": ["ninja.offline_sold_at", "'kind', 'promo_changed'"],
  "ADR-088 (seña y promo por línea)": [
    "v_sena_exp := round(least(v_sena_avail, v_total), 2);",
    "'deposit_mismatch:'",
    "raise exception 'deposit_needs_appointment';",
    "coalesce(v_promo_line[v_n + 1], 0)",
  ],
  "ADR-096 (reservas)": [
    "raise exception 'reservation_items_mismatch';",
    "raise exception 'reservation_not_verified';",
    "'stock_reservation_delivered'",
  ],
  "ADR-116 (servicios)": ["_sale_apply_service(v_tenant, v_sale_id, p_items, v_line_ids, p_service, v_now_ar::date)"],
  "ADR-151 (precio libre)": [
    "select * into v_or from _open_price_range(v_tenant, v_pid);",
    "'open_price_out_of_range:'",
    "'sale_open_price'",
  ],
  "SEC-43 (idempotencia)": [
    "v_replay := _sale_request_replay(v_tenant, p_client_request_id, v_req_hash);",
    "on conflict (tenant_id, client_request_id) where client_request_id is not null do nothing",
  ],
};

/** Renglones con marca de ADR / SEC / hito (comentario propio o al final del código). */
function taggedLines(body: string): string[] {
  return [
    ...new Set(
      body
        .split("\n")
        .filter((l) => /--\s*(ADR-\d+|SEC-\d+|F\d+\b)/.test(l) || /--\s*(<<<|[A-Z]+-\d+\s*>>>)/.test(l))
        .map(ws),
    ),
  ];
}

/** Bloques `-- X >>>` … `-- <<< X`, renglón por renglón. */
function markedBlocks(body: string): { tag: string; lines: string[] }[] {
  const out: { tag: string; lines: string[] }[] = [];
  for (const m of body.matchAll(/--\s*([A-Z]+-\d+)\s*>>>[\s\S]*?--\s*<<<\s*\1\b/g)) {
    out.push({ tag: m[1] ?? "?", lines: m[0].split("\n").map(ws).filter(Boolean) });
  }
  return out;
}

/**
 * ¿Los renglones del bloque siguen, en el mismo orden, en `next`? Una ADR
 * posterior puede intercalar renglones propios dentro de un bloque ajeno (por
 * ejemplo, ADR-116 declara v_service dentro del bloque de ADR-096).
 */
function blockKept(lines: string[], next: string): boolean {
  let pos = 0;
  for (const l of lines) {
    const i = next.indexOf(l, pos);
    if (i < 0) return false;
    pos = i + l.length;
  }
  return true;
}

/**
 * Lo que la definición `next` perdió de `prev`: renglones marcados, bloques
 * marcados y huellas de cada ADR. Vacío = `next` parte de `prev`.
 */
export function lineageProblems(prev: CreateSaleDef, next: CreateSaleDef): string[] {
  const n = ws(next.body);
  const p = ws(prev.body);
  const problems: string[] = [];
  for (const l of taggedLines(prev.body)) {
    if (!n.includes(l)) problems.push(`renglón marcado de ${prev.file}: ${l.slice(0, 120)}`);
  }
  for (const b of markedBlocks(prev.body)) {
    if (!blockKept(b.lines, n)) problems.push(`bloque ${b.tag} de ${prev.file}`);
  }
  for (const [adr, prints] of Object.entries(FINGERPRINTS)) {
    for (const f of prints) {
      if (p.includes(ws(f)) && !n.includes(ws(f))) problems.push(`huella ${adr}: ${f.slice(0, 80)}`);
    }
  }
  return problems;
}

/**
 * Fixture: una migración nueva que recrea create_sale copiando la de ADR-116
 * (20261114100000), o sea anterior a precio libre (ADR-151) y a la clave de
 * idempotencia (SEC-43). Es el error que el guard tiene que atrapar.
 */
export function oldCopyFixture(defs: CreateSaleDef[]): CreateSaleDef {
  const src = defs.find((d) => d.file === "20261114100000_servicios_profesionales.sql");
  if (!src) throw new Error("falta la definición de ADR-116");
  return { file: "20991231000000_copia_vieja_create_sale.sql", body: src.body };
}
