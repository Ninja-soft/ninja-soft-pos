// Genera, desde el catálogo TS (lib/email/templates.ts + lib/email/layout.ts):
//   1. La migración supabase/migrations/20261011160000_emails_diseno_ninja_soft.sql
//      (plantillas de system_email_templates + _dunning_email_html).
//   2. El template de fallback de supabase/functions/mp_billing_webhook/index.ts
//      (bloque entre los marcadores <fallback-layout>).
// Así el HTML que se manda nunca se copia a mano.
//
// Uso: npx -y tsx scripts/gen-email-templates-sql.ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMAIL_TEMPLATES } from "../lib/email/templates";
import { FALLBACK_TOKENS, fallbackLayoutTemplate } from "../lib/email/layout";

const ROOT = resolve(__dirname, "..");
const MIGRATION = resolve(
  ROOT,
  "supabase/migrations/20261011160000_emails_diseno_ninja_soft.sql",
);
const WEBHOOK = resolve(ROOT, "supabase/functions/mp_billing_webhook/index.ts");

function dollar(tag: string, text: string): string {
  if (text.includes(`$${tag}$`)) throw new Error(`El texto contiene $${tag}$`);
  return `$${tag}$${text}$${tag}$`;
}

function assertClean(label: string, text: string) {
  if (text.includes("—")) throw new Error(`${label} tiene guion largo`);
}

// --- 1) Plantillas ------------------------------------------------------------
const rows = EMAIL_TEMPLATES.map((t) => {
  assertClean(t.key, t.defaultSubject + t.defaultHtml);
  return `  ('${t.key}',\n   ${dollar("tpl", t.defaultSubject)},\n   ${dollar("tpl", t.defaultHtml)})`;
});

// --- 2) _dunning_email_html -----------------------------------------------------
const esc = (expr: string) =>
  `replace(replace(replace(coalesce(${expr},''),'&','&amp;'),'<','&lt;'),'>','&gt;')`;
const SQL_FOR: Record<string, string> = {
  [FALLBACK_TOKENS.eyebrow]: `coalesce(nullif(${esc("p_tenant")},''),'NinjaPos')`,
  [FALLBACK_TOKENS.title]: esc("p_title"),
  [FALLBACK_TOKENS.body]: esc("p_body"),
};
const layout = fallbackLayoutTemplate();
assertClean("fallback", layout);
const tokenRe = new RegExp(`(${Object.keys(SQL_FOR).join("|")})`);
const parts = layout
  .split(tokenRe)
  .filter((p) => p !== "")
  .map((p) => (p in SQL_FOR ? SQL_FOR[p]! : dollar("p", p)));
const dunningSql = `create or replace function _dunning_email_html(p_tenant text, p_title text, p_body text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $h$
  select
    ${parts.join("\n    || ")};
$h$;`;

const sql = `-- =============================================================================
-- 20261011160000_emails_diseno_ninja_soft
-- Rediseño de TODOS los emails del sistema con el lenguaje visual de Ninja Soft
-- (mismo sistema que ninja-soft-web, plantillas v3): fondo #f3f2f8, header
-- oscuro con brillo de fuego, isotipo de la llama + logo de NinjaPOS, ícono en
-- círculo, eyebrow naranja, título grande, botón pastilla con degradé, footer
-- claro con logos y dirección. Layout de tablas con estilos inline y logos PNG
-- (Gmail / Outlook).
--
-- ARCHIVO GENERADO por scripts/gen-email-templates-sql.ts desde
-- lib/email/templates.ts y lib/email/layout.ts. No editar a mano: cambiar el
-- catálogo TS y volver a generar.
--
-- 1. system_email_templates: guarda los defaults nuevos (asunto + HTML) de cada
--    clave del catálogo. Pisa los overrides de staff a propósito (el dueño pidió
--    el rediseño completo) y siembra las claves que faltaran.
-- 2. _dunning_email_html: el HTML de los avisos armados en SQL (fallback del
--    dunning, IA, catálogo, tarifas) pasa al mismo diseño.
-- =============================================================================

-- 1) Plantillas del sistema.
insert into system_email_templates (key, subject, html) values
${rows.join(",\n")}
on conflict (key) do update
  set subject = excluded.subject,
      html    = excluded.html;

-- 2) Helper del HTML de los avisos armados en SQL (mismo layout, con eyebrow =
--    nombre del negocio, título y texto escapados).
${dunningSql}
`;
writeFileSync(MIGRATION, sql, "utf8");

// --- 3) Fallback del webhook ----------------------------------------------------
const webhook = readFileSync(WEBHOOK, "utf8");
const start = "// <fallback-layout>\n";
const end = "// </fallback-layout>";
const a = webhook.indexOf(start);
const b = webhook.indexOf(end);
if (a < 0 || b < 0) throw new Error("No encontré los marcadores <fallback-layout>");
const next =
  webhook.slice(0, a + start.length) +
  `const FALLBACK_LAYOUT =\n  ${JSON.stringify(layout)};\n` +
  webhook.slice(b);
writeFileSync(WEBHOOK, next, "utf8");

console.log(`OK: ${EMAIL_TEMPLATES.length} plantillas, migración y webhook generados.`);
