import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  renderTemplate,
  EMAIL_TEMPLATES,
  sampleVars,
} from "@/lib/email/templates";
import { fallbackLayoutTemplate } from "@/lib/email/layout";
import {
  buildReceiptEmailHtml,
  textOn,
  mixHex,
  type BodyTemplateKey,
} from "@/lib/email/receiptTemplates";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const EM_DASH = "—";

// Reglas comunes de cualquier email: sin guion largo, sin WebP, imágenes PNG
// absolutas, dominio propio y documento completo con esquema claro.
function expectEmailRules(html: string) {
  expect(html).not.toContain(EM_DASH);
  expect(html).not.toContain("&mdash;");
  expect(html.toLowerCase()).not.toContain(".webp");
  expect(html).not.toContain("vercel.app");
  expect(html).not.toContain("<style");
  expect(html.startsWith("<!doctype html>")).toBe(true);
  expect(html).toContain('<meta name="color-scheme" content="light only">');
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
  for (const src of imgs) {
    expect(src.startsWith("https://")).toBe(true);
    expect(src.includes("f_png") || src.endsWith(".png")).toBe(true);
  }
}

describe("renderTemplate", () => {
  it("reemplaza variables existentes", () => {
    expect(renderTemplate("Hola {{nombre}} de {{negocio}}", { nombre: "Ana", negocio: "Kiosco" })).toBe(
      "Hola Ana de Kiosco",
    );
  });

  it("deja el placeholder si falta la variable", () => {
    expect(renderTemplate("Hola {{nombre}}", {})).toBe("Hola {{nombre}}");
  });

  it("tolera espacios dentro de las llaves", () => {
    expect(renderTemplate("{{ negocio }}", { negocio: "X" })).toBe("X");
  });
});

describe("catálogo de emails del sistema", () => {
  it("las claves son únicas", () => {
    const keys = EMAIL_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cada template renderiza con sampleVars sin dejar variables", () => {
    const vars = sampleVars("Mi Negocio");
    for (const t of EMAIL_TEMPLATES) {
      const out = renderTemplate(t.defaultSubject + t.defaultHtml, vars);
      expect(out, t.key).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });

  it("cada template usa solo variables declaradas", () => {
    for (const t of EMAIL_TEMPLATES) {
      const used = [...(t.defaultSubject + t.defaultHtml).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
        (m) => m[1]!,
      );
      for (const v of used) expect(t.variables, `${t.key}: ${v}`).toContain(v);
    }
  });

  it("cada template respeta el diseño y las reglas de email", () => {
    for (const t of EMAIL_TEMPLATES) {
      expect(t.defaultSubject).not.toContain(EM_DASH);
      expectEmailRules(t.defaultHtml);
      expect(t.defaultHtml).toContain("https://pos.soft.ninja");
      expect(t.defaultHtml).toContain("ninja-isotipo-flame.png");
      expect(t.defaultHtml).toContain("Ninja_POS_Light_glckmm");
      expect(t.defaultHtml).toContain("Ninja_Soft_Dark_h9aklw");
      expect(t.defaultHtml).toContain("Urquiza 3164");
      // Botón a prueba de Outlook: celda con bgcolor.
      expect(t.defaultHtml).toContain('bgcolor="#ff5a1f"');
    }
  });

  it("el layout de avisos (dunning / webhook) cumple las reglas", () => {
    expectEmailRules(fallbackLayoutTemplate());
  });
});

describe("emails de comprobante", () => {
  const designs: BodyTemplateKey[] = ["brand", "clean", "dark", "warm", "minimal"];

  it("cada diseño renderiza con y sin logo y respeta las reglas", () => {
    for (const d of designs) {
      const withLogo = buildReceiptEmailHtml(d, {
        accent: "#2563eb",
        logoUrl: "https://example.com/logo.png",
        name: "Almacén",
        bodyText: "Gracias",
      });
      expect(withLogo).toContain("https://example.com/logo.png");
      expectEmailRules(withLogo);
      const noLogo = buildReceiptEmailHtml(d, { accent: "", logoUrl: "", name: "", bodyText: "" });
      expect(noLogo).toContain("NinjaSoft POS");
      expectEmailRules(noLogo);
      expect(noLogo).toContain("Enviado con NinjaPos");
    }
  });

  it("escapa el input del negocio", () => {
    const html = buildReceiptEmailHtml("brand", {
      accent: "#000000",
      logoUrl: '"><script>',
      name: "<b>x</b>",
      bodyText: "<img src=x>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<img src=x>");
  });

  it("elige texto legible sobre el acento", () => {
    expect(textOn("#ffffff")).toBe("#09051C");
    expect(textOn("#111827")).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("la Edge Function send_receipt_email tiene el mismo bloque que lib/", () => {
    const block = (src: string) =>
      src
        .slice(src.indexOf("// <receipt-templates>"), src.indexOf("// </receipt-templates>"))
        .replace(/^export /gm, "");
    const lib = block(read("lib/email/receiptTemplates.ts"));
    const fn = block(read("supabase/functions/send_receipt_email/index.ts"));
    expect(lib.length).toBeGreaterThan(1000);
    expect(fn).toBe(lib);
  });
});

describe("artefactos generados", () => {
  it("mp_billing_webhook usa el layout de avisos actual", () => {
    const src = read("supabase/functions/mp_billing_webhook/index.ts");
    expect(src).toContain(JSON.stringify(fallbackLayoutTemplate()));
  });

  it("la migración tiene el HTML actual de cada template", () => {
    const sql = read("supabase/migrations/20261011160000_emails_diseno_ninja_soft.sql");
    expect(sql).not.toContain(EM_DASH);
    // Las plantillas que se suman después de ese rediseño se siembran en su
    // propia migración (p. ej. las de cobranza de 20261116100000, ADR-120):
    // las aplicadas no se reescriben.
    const later = readdirSync(resolve(ROOT, "supabase/migrations"))
      .filter((f) => f > "20261011160000" && f.endsWith(".sql"))
      .map((f) => read(`supabase/migrations/${f}`))
      .join("\n");
    for (const t of EMAIL_TEMPLATES) {
      const where = t.migration ? read(t.migration) : sql.includes(`('${t.key}',`) ? sql : later;
      expect(where, t.key).toContain(`('${t.key}',`);
      expect(where, t.key).toContain(`$tpl$${t.defaultHtml}$tpl$`);
    }
    expect(sql).toContain("create or replace function _dunning_email_html");
  });
});
