import { describe, expect, it } from "vitest";
import {
  GLOSSARY,
  STATUS_INFO,
  WIZARD_STEPS,
  arcaErrorMessage,
  certDaysLeft,
  certExpiry,
  certExpiryText,
  currentWizardStep,
  formatFiscalDate,
  formatFiscalNumber,
  statusInfo,
  wizardProgress,
  wizardStepsDone,
  type WizardConfigLike,
} from "@/lib/arca/labels";
import { FISCAL_PENDING_TEXT, fiscalApproved, ticketFiscal } from "@/lib/arca/ticket";
import { buildHtmlVars } from "@/lib/tickets/htmlVars";
import { sampleTicketData } from "@/lib/tickets/sample";

const NOW = new Date("2026-10-13T12:00:00Z");

const base = (): WizardConfigLike => ({
  settings: null,
  emitter: { cuit: null, iva_condition: null },
  certificates: [],
  platform: {},
  stores: [{ afip_pos_number: null }],
});

describe("arca labels", () => {
  it("formatea el número fiscal", () => {
    expect(formatFiscalNumber(3, 12)).toBe("00003-00000012");
    expect(formatFiscalNumber(null, null)).toBe("00000-00000000");
    expect(formatFiscalDate("2026-10-23")).toBe("23/10/2026");
    expect(formatFiscalDate(null)).toBe("");
  });

  it("vencimiento del certificado: aviso con 30 días o menos", () => {
    expect(certDaysLeft("2026-11-12T12:00:00Z", NOW)).toBe(30);
    expect(certExpiry("2026-11-12T12:00:00Z", NOW).level).toBe("warn");
    expect(certExpiry("2026-12-31T00:00:00Z", NOW).level).toBe("ok");
    expect(certExpiry("2026-10-01T00:00:00Z", NOW).level).toBe("expired");
    expect(certExpiry(null, NOW).level).toBe("none");
    expect(certExpiryText(certExpiry("2026-11-12T12:00:00Z", NOW))).toBe("El certificado vence en 30 días");
    expect(certExpiryText(certExpiry("2026-10-01T00:00:00Z", NOW))).toBe("El certificado venció");
  });

  it("estados con etiqueta y tono; desconocido cae en pendiente", () => {
    expect(STATUS_INFO.aprobado.tone).toBe("success");
    expect(statusInfo("requiere_accion").label).toBe("Requiere acción");
    expect(statusInfo("raro").label).toBe("Pendiente");
  });

  it("glosario sin em dash y con los términos pedidos", () => {
    for (const k of ["homologacion", "produccion", "certificado", "punto_venta", "cae", "caea", "wsass", "csr", "alias", "wsfe"] as const) {
      expect(GLOSSARY[k].text.length).toBeGreaterThan(20);
    }
    const all = JSON.stringify(GLOSSARY) + JSON.stringify(WIZARD_STEPS) + JSON.stringify(STATUS_INFO);
    expect(all).not.toContain("—");
  });

  it("modelo del asistente: pasos hechos, paso actual y progreso", () => {
    const c = base();
    expect(currentWizardStep(c, NOW)).toBe("datos");
    expect(wizardProgress(c, NOW)).toBe(0);

    c.emitter = { cuit: "30500000003", iva_condition: "responsable_inscripto" };
    c.settings = { auth_mode: "propio", environment: "homologacion", enabled: false };
    expect(currentWizardStep(c, NOW)).toBe("certificado");

    c.certificates = [{ environment: "homologacion", status: "active", not_after: "2028-10-12T00:00:00Z" }];
    expect(currentWizardStep(c, NOW)).toBe("autorizar");

    c.settings = { ...c.settings, last_connection_ok: true, last_connection_env: "homologacion" };
    expect(currentWizardStep(c, NOW)).toBe("punto_venta");

    c.stores = [{ afip_pos_number: 1 }];
    expect(currentWizardStep(c, NOW)).toBe("prueba");

    c.settings = { ...c.settings, enabled: true };
    // Contingencia es opcional: el próximo obligatorio es producción.
    expect(currentWizardStep(c, NOW)).toBe("produccion");
    expect(wizardStepsDone(c, NOW).contingencia).toBe(false);
    expect(wizardProgress(c, NOW)).toBe(86);

    c.settings = { ...c.settings, environment: "produccion" };
    // En producción hace falta el certificado real: el de prueba no sirve.
    expect(wizardStepsDone(c, NOW).certificado).toBe(false);
  });

  it("delegado: el certificado es el de la plataforma", () => {
    const c = base();
    c.settings = { auth_mode: "delegado", environment: "homologacion" };
    expect(wizardStepsDone(c, NOW).certificado).toBe(false);
    c.platform = { homologacion: { ready: true } };
    expect(wizardStepsDone(c, NOW).certificado).toBe(true);
  });

  it("errores de las RPC en lenguaje simple", () => {
    expect(arcaErrorMessage(new Error("checklist_incomplete"))).toMatch(/lista/);
    expect(arcaErrorMessage(new Error("feature_not_in_plan: facturacion_afip"))).toMatch(/plan/);
    expect(arcaErrorMessage(new Error("caea_pto_vta_in_use"))).toMatch(/propio/);
    expect(arcaErrorMessage(new Error("otro"))).toBe("otro");
  });
});

describe("arca ticket", () => {
  const doc = {
    status: "aprobado",
    cbte_tipo: 6,
    pto_vta: 3,
    cbte_nro: 12,
    cae: "76123456789012",
    cae_vto: "2026-10-23",
    qr_url: "https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjF9",
    emission_type: "CAE" as const,
    environment: "produccion",
  };

  it("arma los datos fiscales de una factura aprobada", () => {
    const f = ticketFiscal(doc);
    expect(f).toMatchObject({ cbteLabel: "Factura B", letter: "B", codigo: "006", ptoVta: "00003", numero: "00003-00000012", caeVto: "23/10/2026" });
    expect(fiscalApproved(f)).toBe(true);
  });

  it("pendiente: sin CAE ni número", () => {
    const f = ticketFiscal({ ...doc, status: "pendiente", cae: null, cbte_nro: null });
    expect(f?.numero).toBeNull();
    expect(fiscalApproved(f)).toBe(false);
    expect(FISCAL_PENDING_TEXT).toContain("ARCA");
    expect(ticketFiscal({ ...doc, status: "cancelado" })).toBeNull();
  });

  it("las variables HTML usan la factura autorizada", () => {
    const d = sampleTicketData(null);
    d.sale.fiscal = ticketFiscal(doc);
    const v = buildHtmlVars(d);
    expect(v.comprobante_letra).toBe("B");
    expect(v.comprobante_cod).toBe("006");
    expect(v.punto_venta).toBe("00003");
    expect(v.comprobante_nro).toBe("00000012");
    expect(v.cae).toBe("76123456789012");
    expect(v.cae_vto).toBe("23/10/2026");
    const sinFactura = buildHtmlVars(sampleTicketData(null));
    expect(sinFactura.cae).toBe("s/d");
    expect(sinFactura.comprobante_letra).toBe("X");
  });
});
