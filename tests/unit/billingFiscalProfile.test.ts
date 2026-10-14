// @vitest-environment node
// Datos fiscales del cliente para la factura de NinjaSoft (F20-3 · ADR-117):
// dígito verificador del CUIT, regla de la letra (espejo de
// platform_cbte_letter) y resolución del perfil con el fallback a los datos
// de la empresa (espejo de _tenant_billing_profile_eff).
import { describe, expect, it } from "vitest";
import { isValidCuit } from "@/lib/tax/catalog";
import { cuitIsValid } from "@/supabase/functions/_shared/arca/padron";
import { platformLetter, letterTitle, conditionLabel } from "@/lib/billing/letter";
import {
  checkCuit,
  formatCuit,
  resolveBillingProfile,
  billingProfileError,
  type BillingProfileRow,
  type CompanyFiscal,
} from "@/lib/billing/fiscalProfile";
import { formPreview, formProblem, formToInput, initialFormState, type BillingFormState } from "@/components/billing/BillingProfileForm";

/** CUIT con el dígito verificador calculado. */
function cuit(prefix: string, body: string): string {
  const d = `${prefix}${body}`;
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(d[i]) * w[i]!;
  let c = 11 - (s % 11);
  if (c === 11) c = 0;
  if (c === 10) c = 9;
  return d + c;
}
const CUIT_EMPRESA = cuit("30", "71234567");
const CUIT_OTRO = cuit("20", "28765432");

describe("dígito verificador del CUIT", () => {
  it("acepta CUIT válidos con o sin guiones", () => {
    expect(isValidCuit("20-12345678-6")).toBe(true);
    expect(isValidCuit(CUIT_EMPRESA)).toBe(true);
    expect(isValidCuit(formatCuit(CUIT_OTRO))).toBe(true);
  });
  it("rechaza dígito verificador equivocado y largos incorrectos", () => {
    const bad = CUIT_EMPRESA.slice(0, 10) + String((Number(CUIT_EMPRESA[10]) + 1) % 10);
    expect(isValidCuit(bad)).toBe(false);
    expect(isValidCuit("2012345678")).toBe(false);
    expect(isValidCuit("201234567861")).toBe(false);
    expect(isValidCuit("")).toBe(false);
  });
  it("resto 1 (11 - 1 = 10) da dígito 9, como el SQL cuit_is_valid", () => {
    for (let n = 0; n < 2000; n++) {
      const base = `20${String(n).padStart(8, "0")}`;
      const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
      const s = base.split("").reduce((a, c, i) => a + Number(c) * w[i]!, 0);
      if (s % 11 === 1) {
        expect(isValidCuit(base + "9")).toBe(true);
        return;
      }
    }
    throw new Error("sin caso de resto 1");
  });
  it("el espejo de la Edge coincide con lib/tax/catalog", () => {
    for (let i = 0; i < 300; i++) {
      const v = `${20 + (i % 15)}${String(10_000_000 + i * 7919).slice(0, 8)}${i % 10}`;
      expect(cuitIsValid(v)).toBe(isValidCuit(v));
    }
  });
  it("checkCuit acompaña la escritura", () => {
    expect(checkCuit("")).toBe("empty");
    expect(checkCuit("30-7123")).toBe("incomplete");
    expect(checkCuit(CUIT_EMPRESA)).toBe("ok");
    expect(checkCuit("123456789012")).toBe("invalid");
  });
  it("formatCuit", () => {
    expect(formatCuit("20123456786")).toBe("20-12345678-6");
    expect(formatCuit("123")).toBe("123");
  });
});

describe("regla de la letra (spec §7.2)", () => {
  it("emisor sin condición (NinjaSoft sin CUIT): pendiente", () => {
    expect(platformLetter(null, "responsable_inscripto")).toEqual({ status: "pending_issuer", letter: null });
    expect(platformLetter("", "consumidor_final").status).toBe("pending_issuer");
  });
  it("receptor sin condición: pendiente (RG 5616)", () => {
    expect(platformLetter("responsable_inscripto", null)).toEqual({ status: "pending_receptor", letter: null });
  });
  it.each([
    ["responsable_inscripto", "responsable_inscripto", "A"],
    ["responsable_inscripto", "monotributo", "A"],
    ["responsable_inscripto", "monotributo_social", "A"],
    ["responsable_inscripto", "exento", "B"],
    ["responsable_inscripto", "consumidor_final", "B"],
    ["responsable_inscripto", "no_categorizado", "B"],
    ["responsable_inscripto", "exterior", "E"],
    ["monotributo", "responsable_inscripto", "C"],
    ["monotributo", "consumidor_final", "C"],
    ["exento", "responsable_inscripto", "C"],
    ["no_alcanzado", "monotributo", "C"],
  ])("%s → %s = %s", (issuer, receptor, letter) => {
    expect(platformLetter(issuer, receptor)).toEqual({ status: "ok", letter });
  });
  it("títulos y etiquetas", () => {
    expect(letterTitle({ status: "ok", letter: "A" })).toBe("Factura A");
    expect(letterTitle({ status: "pending_issuer", letter: null })).toBe("Comprobante pendiente");
    expect(conditionLabel(null)).toBe("Sin definir");
    expect(conditionLabel("monotributo")).toBe("Monotributo");
  });
});

const company: CompanyFiscal = {
  razon_social: "Kiosco A SRL",
  cuit: CUIT_EMPRESA,
  iva_condition: "responsable_inscripto",
  domicilio: "Mitre 123",
};
const row = (p: Partial<BillingProfileRow>): BillingProfileRow => ({
  use_company_data: true,
  holder_type: null,
  doc_tipo: null,
  doc_nro: null,
  razon_social: null,
  iva_condition: null,
  domicilio: null,
  email_facturacion: null,
  verification: "none",
  ...p,
});

describe("perfil efectivo y fallback a los datos de la empresa", () => {
  it("sin fila: datos de la empresa y email del dueño", () => {
    const e = resolveBillingProfile(null, company, "dueno@x.com", "responsable_inscripto");
    expect(e).toMatchObject({
      source: "company",
      doc_tipo: 80,
      doc_nro: CUIT_EMPRESA,
      razon_social: "Kiosco A SRL",
      iva_condition: "responsable_inscripto",
      email: "dueno@x.com",
      email_is_default: true,
      verified: false,
      letter: "A",
      blocked_a_unverified: true,
    });
  });
  it("empresa sin CUIT (o con CUIT inválido): consumidor final", () => {
    for (const c of [{ ...company, cuit: null }, { ...company, cuit: "30712345670" }]) {
      const e = resolveBillingProfile(null, c, null, "responsable_inscripto");
      expect(e.source).toBe("consumidor_final");
      expect(e.doc_tipo).toBe(99);
      expect(e.letter).toBe("B");
    }
  });
  it("fila con datos de la empresa: sólo cambia el email", () => {
    const e = resolveBillingProfile(row({ email_facturacion: "conta@x.com" }), company, "dueno@x.com", null);
    expect(e.source).toBe("company");
    expect(e.email).toBe("conta@x.com");
    expect(e.email_is_default).toBe(false);
    expect(e.letter_status).toBe("pending_issuer");
  });
  it("copia verificada del CUIT de la empresa: usa los datos de ARCA", () => {
    const r = row({ doc_tipo: 80, doc_nro: CUIT_EMPRESA, razon_social: "KIOSCO A S.R.L.", iva_condition: "monotributo", verification: "padron" });
    const e = resolveBillingProfile(r, company, null, "responsable_inscripto");
    expect(e.razon_social).toBe("KIOSCO A S.R.L.");
    expect(e.verified).toBe(true);
    expect(e.letter).toBe("A");
    expect(e.blocked_a_unverified).toBe(false);
  });
  it("verificación de un CUIT viejo de la empresa no se arrastra", () => {
    const r = row({ doc_tipo: 80, doc_nro: CUIT_OTRO, razon_social: "VIEJA", verification: "padron" });
    const e = resolveBillingProfile(r, company, null, "responsable_inscripto");
    expect(e.razon_social).toBe("Kiosco A SRL");
    expect(e.verified).toBe(false);
  });
  it("otro titular", () => {
    const r = row({ use_company_data: false, holder_type: "empresa", doc_tipo: 80, doc_nro: CUIT_OTRO, razon_social: "Estudio SA", iva_condition: "exento", verification: "manual" });
    const e = resolveBillingProfile(r, company, "dueno@x.com", "responsable_inscripto");
    expect(e).toMatchObject({ source: "other", razon_social: "Estudio SA", letter: "B", verified: false });
  });
});

describe("formulario", () => {
  const base: BillingFormState = initialFormState(null, null);
  it("por defecto: datos del negocio, sin email propio", () => {
    expect(base.mode).toBe("company");
    expect(formToInput(base)).toEqual({ use_company_data: true, email_facturacion: null, use_padron: false });
    expect(formProblem(base)).toBeNull();
  });
  it("otro titular: valida CUIT, razón social y condición", () => {
    const s: BillingFormState = { ...base, mode: "other", docNro: "30-71234567-0" };
    expect(formProblem(s)).toMatch(/CUIT/);
    const ok = { ...s, docNro: formatCuit(CUIT_OTRO), razonSocial: "Estudio", ivaCondition: "monotributo" };
    expect(formProblem(ok)).toBeNull();
    expect(formToInput(ok)).toMatchObject({ use_company_data: false, holder_type: "empresa", doc_tipo: 80, doc_nro: CUIT_OTRO });
  });
  it("persona con DNI: consumidor final", () => {
    const s: BillingFormState = { ...base, mode: "other", holderType: "persona", docTipo: 96, docNro: "28765432", razonSocial: "Juan" };
    expect(formProblem(s)).toBeNull();
    expect(formToInput(s).iva_condition).toBe("consumidor_final");
    expect(formPreview(s, company, "responsable_inscripto")).toMatchObject({ letter: "B", doc: "DNI 28765432" });
  });
  it("vista previa: sin CUIT del negocio avisa consumidor final", () => {
    const p = formPreview(base, { ...company, cuit: null }, "monotributo");
    expect(p).toMatchObject({ fallbackCf: true, letter: "C" });
  });
  it("con datos de ARCA se usan y se pide use_padron", () => {
    const s: BillingFormState = {
      ...base,
      mode: "other",
      docNro: CUIT_OTRO,
      padron: {
        cuit: CUIT_OTRO, tipo_persona: "JURIDICA", razon_social: "ESTUDIO SA", estado_clave: "ACTIVO", activa: true,
        domicilio: "X", provincia: null, iva_condition: "responsable_inscripto", iva_source: "regimen_general",
        impuestos: [30], monotributo_categoria: null, avisos: [],
      },
    };
    expect(formProblem(s)).toBeNull();
    expect(formToInput(s)).toMatchObject({ use_padron: true, razon_social: "ESTUDIO SA", iva_condition: "responsable_inscripto" });
    expect(formPreview(s, company, "responsable_inscripto").letter).toBe("A");
  });
  it("email inválido bloquea", () => {
    expect(formProblem({ ...base, email: "no-email" })).toMatch(/email/);
  });
  it("errores de la base en castellano", () => {
    expect(billingProfileError(new Error("invalid_cuit"))).toMatch(/dígito verificador/);
    expect(billingProfileError(new Error("forbidden"))).toMatch(/dueño o el encargado/);
  });
});
