import { describe, expect, it } from "vitest";
import {
  bankBlockHtml,
  bankAccountUsable,
  escapeHtml,
  formatArsCents,
  groupCbu,
  modeChangePlan,
  noticeKey,
  paymentReference,
  proofContactHtml,
  proofExtension,
  statementKey,
  validateTransferReport,
  type NoticeRule,
} from "@/lib/billing/paymentNotice";
import { EMAIL_TEMPLATES, renderTemplate } from "@/lib/email/templates";
import { noticePreviewHtml } from "@/components/internal/billing/CollectionConfig";

// CBU válido a partir de 7 + 13 dígitos (calcula los verificadores).
function cbu(a7: string, b13: string) {
  const w1 = [7, 1, 3, 9, 7, 1, 3];
  const w2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
  const s1 = [...a7].reduce((s, d, i) => s + Number(d) * w1[i]!, 0);
  const s2 = [...b13].reduce((s, d, i) => s + Number(d) * w2[i]!, 0);
  return `${a7}${(10 - (s1 % 10)) % 10}${b13}${(10 - (s2 % 10)) % 10}`;
}

const rule = (r: Partial<NoticeRule> = {}): NoticeRule => ({
  frequency: "per_period",
  leadDays: 5,
  everyDays: 7,
  statementDay: 1,
  ...r,
});
const charge = { id: "c1", due_date: "2026-11-10" };

describe("noticeKey (espejo de platform_notice_key)", () => {
  it("per_period: nada antes de la ventana, una clave fija después", () => {
    expect(noticeKey(rule(), charge, "2026-11-04")).toBeNull();
    expect(noticeKey(rule(), charge, "2026-11-05")).toBe("notice:c1");
    expect(noticeKey(rule(), charge, "2026-11-20")).toBe("notice:c1");
  });

  it("every_n_days: un tramo por cada N días desde el primer aviso", () => {
    const r = rule({ frequency: "every_n_days", everyDays: 3 });
    expect(noticeKey(r, charge, "2026-11-05")).toBe("notice:c1:0");
    expect(noticeKey(r, charge, "2026-11-07")).toBe("notice:c1:0");
    expect(noticeKey(r, charge, "2026-11-08")).toBe("notice:c1:1");
    expect(noticeKey(r, charge, "2026-11-11")).toBe("notice:c1:2");
  });

  it("monthly_day no usa claves por cuota", () => {
    expect(noticeKey(rule({ frequency: "monthly_day" }), charge, "2026-11-20")).toBeNull();
  });

  it("lead 0: el aviso sale el día del vencimiento", () => {
    expect(noticeKey(rule({ leadDays: 0 }), charge, "2026-11-09")).toBeNull();
    expect(noticeKey(rule({ leadDays: 0 }), charge, "2026-11-10")).toBe("notice:c1");
  });
});

describe("statementKey", () => {
  const r = rule({ frequency: "monthly_day", statementDay: 31 });
  it("sale el día elegido o el último del mes si no existe", () => {
    expect(statementKey(r, "t1", "2026-02-27", 100)).toBeNull();
    expect(statementKey(r, "t1", "2026-02-28", 100)).toBe("statement:t1:2026-02");
  });
  it("sin deuda no hay resumen", () => {
    expect(statementKey(r, "t1", "2026-03-31", 0)).toBeNull();
  });
});

describe("formato y bloques del email", () => {
  it("formatArsCents igual que platform_format_ars", () => {
    expect(formatArsCents(1234567890)).toBe("$ 12.345.678,90");
    expect(formatArsCents(5)).toBe("$ 0,05");
    expect(formatArsCents(-150000)).toBe("-$ 1.500,00");
  });

  it("referencia y CBU agrupado", () => {
    expect(paymentReference("almacen-don.pepe")).toBe("NS-ALMACEN-DONPEPE");
    expect(paymentReference("")).toBe("NS");
    expect(groupCbu("0070999030004000000011")).toBe("0070 9990 3000 4000 0000 11");
  });

  it("bloque bancario escapado, con CVU y sin filas vacías", () => {
    const html = bankBlockHtml([
      { bank_name: "Mercado <Pago>", holder_name: "Ninja & Soft", cuit: null, cbu: "0000003100012345678901", alias: null },
    ]);
    expect(html).toContain("Datos para transferir");
    expect(html).toContain("Mercado &lt;Pago&gt;");
    expect(html).toContain("Ninja &amp; Soft");
    expect(html).toContain(">CVU<");
    expect(html).not.toContain(">Alias<");
    expect(bankBlockHtml([])).toBe("");
  });

  it("contacto del comprobante con email y WhatsApp", () => {
    const html = proofContactHtml("cobranzas@soft.ninja", "+54 341 555-1234");
    expect(html).toContain("mailto:cobranzas@soft.ninja");
    expect(html).toContain("https://wa.me/543415551234");
    expect(proofContactHtml(null, "")).toBe("");
    expect(escapeHtml('"><x>')).toBe("&quot;&gt;&lt;x&gt;");
  });

  it("la plantilla del aviso se renderiza sin variables sueltas y con los datos", () => {
    const { subject, html } = noticePreviewHtml(
      { payment_proof_email: "cobranzas@soft.ninja", payment_proof_whatsapp: null },
      [
        {
          id: "a",
          bank_slug: "galicia",
          bank_name: "Banco Galicia",
          holder_name: "Ninja Soft SRL",
          cuit: "30712345679",
          cbu: cbu("0070999", "0000000123456"),
          alias: "NINJASOFT.COBROS",
          account_type: "cuenta_corriente",
          currency: "ARS",
          note: null,
          is_default: true,
        },
      ],
    );
    expect(subject).toContain("10/11/2026");
    expect(html).toContain("NINJASOFT.COBROS");
    expect(html).toContain("cobranzas@soft.ninja");
    expect(html).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });

  it("las cuatro plantillas nuevas están en el catálogo", () => {
    const keys = EMAIL_TEMPLATES.map((t) => t.key);
    for (const k of ["platform_payment_notice", "platform_transfer_reported", "platform_transfer_approved", "platform_transfer_rejected"]) {
      expect(keys).toContain(k);
    }
    const t = EMAIL_TEMPLATES.find((x) => x.key === "platform_transfer_rejected")!;
    expect(renderTemplate(t.defaultHtml, { motivo: "Importe distinto" })).toContain("Importe distinto");
  });
});

describe("Ya transferí", () => {
  const ok = { amountCents: 5000, paidOn: "2026-10-10", today: "2026-10-14", file: { size: 1000, type: "application/pdf" } };
  it("valida importe, fecha y archivo", () => {
    expect(validateTransferReport(ok)).toEqual({});
    expect(validateTransferReport({ ...ok, amountCents: null }).amount).toBeTruthy();
    expect(validateTransferReport({ ...ok, paidOn: "2026-10-15" }).paidOn).toMatch(/futura/);
    expect(validateTransferReport({ ...ok, paidOn: "2026-01-01" }).paidOn).toMatch(/120/);
    expect(validateTransferReport({ ...ok, file: null }).file).toBeTruthy();
    expect(validateTransferReport({ ...ok, file: { size: 11 * 1024 * 1024, type: "image/png" } }).file).toMatch(/10 MB/);
    expect(validateTransferReport({ ...ok, file: { size: 10, type: "text/plain" } }).file).toMatch(/PDF/);
  });
  it("extensión del archivo", () => {
    expect(proofExtension("application/pdf")).toBe("pdf");
    expect(proofExtension("image/webp")).toBe("webp");
    expect(proofExtension("image/jpeg")).toBe("jpg");
  });
});

describe("cuentas y modalidad", () => {
  it("una cuenta sirve con CBU válido o alias válido", () => {
    expect(bankAccountUsable({ holder_name: "Ninja", cbu: cbu("0070999", "0000000123456"), alias: null })).toBe(true);
    expect(bankAccountUsable({ holder_name: "Ninja", cbu: "0070999000000000123450", alias: null })).toBe(false);
    expect(bankAccountUsable({ holder_name: "Ninja", cbu: null, alias: "ninja.cobros" })).toBe(true);
    expect(bankAccountUsable({ holder_name: " ", cbu: null, alias: "ninja.cobros" })).toBe(false);
  });

  it("qué implica cada cambio de modalidad", () => {
    expect(modeChangePlan("account", true)).toEqual({ cancelsPreapproval: true, needsCheckout: false, effective: "now" });
    expect(modeChangePlan("manual", false).cancelsPreapproval).toBe(false);
    expect(modeChangePlan("mp_subscription", true)).toEqual({ cancelsPreapproval: false, needsCheckout: true, effective: "after_first_debit" });
  });
});
