// ADR-155: modo Prueba / Real con verificación de puntos de venta, respaldo
// CAEA y factura o sólo ticket en cada venta.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fiscalChoiceBlocker,
  initialFiscalChoice,
  isTicketMode,
  ticketOnlyErrorMessage,
  ticketOnlyWarnings,
  toggleFiscalChoice,
} from "@/lib/billing/ticketMode";
import { caeaPosWarning, goLivePrereqs, padPos, reconcilePos, webServicePos } from "@/lib/arca/envSwitch";
import { matchPosShortcut } from "@/lib/pos/shortcuts";

describe("factura o sólo ticket", () => {
  it("la hoja arranca con el modo del negocio", () => {
    expect(initialFiscalChoice("factura")).toBe("factura");
    expect(initialFiscalChoice("ticket")).toBe("ticket");
    expect(initialFiscalChoice("preguntar")).toBeNull();
    // Sin dato (base sin la migración): factura, como siempre.
    expect(initialFiscalChoice(null)).toBe("factura");
    expect(initialFiscalChoice(undefined)).toBe("factura");
  });

  it("el atajo alterna y desde Preguntar elige factura primero", () => {
    expect(toggleFiscalChoice("factura")).toBe("ticket");
    expect(toggleFiscalChoice("ticket")).toBe("factura");
    expect(toggleFiscalChoice(null)).toBe("factura");
    expect(matchPosShortcut({ key: "F9", shiftKey: true })).toBe("fiscal");
    expect(matchPosShortcut({ key: "F9" })).toBe("checkout");
  });

  it("sólo bloquea el cobro en Preguntar sin elegir", () => {
    expect(fiscalChoiceBlocker(true, null)).toBe("Elegí Factura o Sólo ticket");
    expect(fiscalChoiceBlocker(true, "ticket")).toBeNull();
    expect(fiscalChoiceBlocker(true, "factura")).toBeNull();
    expect(fiscalChoiceBlocker(false, null)).toBeNull();
  });

  it("avisa (sin bloquear) cuando la venta seguramente necesita factura", () => {
    const base = { letter: "B", hasCuit: false, total: 1000, cfThreshold: 10_000_000, hasCustomer: false };
    expect(ticketOnlyWarnings(base)).toEqual([]);
    expect(ticketOnlyWarnings({ ...base, letter: "A", hasCuit: true, hasCustomer: true }).map((w) => w.code)).toEqual(["factura_a"]);
    expect(ticketOnlyWarnings({ ...base, letter: "M", hasCustomer: true }).map((w) => w.code)).toEqual(["factura_m"]);
    expect(ticketOnlyWarnings({ ...base, hasCuit: true, hasCustomer: true }).map((w) => w.code)).toEqual(["cliente_con_cuit"]);
    expect(ticketOnlyWarnings({ ...base, total: 10_000_000 }).map((w) => w.code)).toEqual(["monto_alto"]);
    // Con cliente identificado el tope de consumidor final no aplica.
    expect(ticketOnlyWarnings({ ...base, total: 20_000_000, hasCustomer: true })).toEqual([]);
    expect(ticketOnlyWarnings({ ...base, total: 20_000_000, cfThreshold: null })).toEqual([]);
    for (const w of ticketOnlyWarnings({ ...base, letter: "A", total: 20_000_000 })) expect(w.text).not.toMatch(/—/);
  });

  it("valida el modo y traduce los errores", () => {
    expect(isTicketMode("preguntar")).toBe(true);
    expect(isTicketMode("otro")).toBe(false);
    expect(isTicketMode(undefined)).toBe(false);
    expect(ticketOnlyErrorMessage("not_enabled")).toMatch(/apagada/);
    expect(ticketOnlyErrorMessage("feature_not_in_plan: facturacion_afip")).toMatch(/plan/);
    expect(ticketOnlyErrorMessage("x")).toMatch(/sólo ticket/);
  });
});

describe("pasar a real: puntos de venta", () => {
  const listed = [
    { nro: 3, emisionTipo: "RECE para aplicativo y web services" },
    { nro: 100, emisionTipo: "Factura Electronica - Monotributo - Web Services" },
    { nro: 101, emisionTipo: "RECE - CAEA" },
  ];

  it("separa los de Web Services de los de CAEA", () => {
    expect(webServicePos(listed)).toEqual([3, 100]);
    expect(webServicePos(null)).toEqual([]);
  });

  it("marca las sucursales que están y propone primero un número libre para las que no", () => {
    const rows = reconcilePos(
      [
        { id: "s1", name: "Centro", afip_pos_number: 100, registers: [{ id: "r1", name: "Caja 2", afip_pos_number: 7 }] },
        { id: "s2", name: "Norte", afip_pos_number: 1, registers: [] },
        { id: "s3", name: "Sur", afip_pos_number: null },
      ],
      listed,
    );
    expect(rows.map((r) => [r.label, r.ok, r.suggestion])).toEqual([
      ["Centro", true, null],
      ["Centro · Caja 2", false, 3],
      // Sin libres, se repite el último libre (compartir punto de venta vale).
      ["Norte", false, 3],
      ["Sur", false, 3],
    ]);
    expect(rows.find((r) => r.id === "r1")?.kind).toBe("register");
  });

  it("caso real: sucursal con el 1 de prueba y ARCA real con el 100", () => {
    const rows = reconcilePos([{ id: "s", name: "Principal", afip_pos_number: 1 }], [{ nro: 100, emisionTipo: "Web Services" }]);
    expect(rows[0]).toMatchObject({ ok: false, current: 1, suggestion: 100 });
  });

  it("lo que falta antes de probar el modo real (sin conexión ni puntos de venta, que se arreglan acá)", () => {
    const p = goLivePrereqs([
      { key: "fiscal_data", ok: true },
      { key: "certificado", ok: false },
      { key: "homologacion_ok", ok: false, required: false },
      { key: "conexion_produccion", ok: false },
      { key: "puntos_de_venta", ok: false },
    ]);
    expect(p.map((x) => x.key)).toEqual(["certificado"]);
    expect(p[0]?.label).toMatch(/Certificado/);
  });

  it("avisa si el punto de venta de contingencia no es CAEA en ARCA", () => {
    expect(caeaPosWarning(true, 101, listed)).toBeNull();
    expect(caeaPosWarning(true, 3, listed)).toMatch(/00003/);
    expect(caeaPosWarning(false, 3, listed)).toBeNull();
    expect(caeaPosWarning(true, null, listed)).toBeNull();
    expect(padPos(7)).toBe("00007");
    expect(padPos(null)).toBe("Sin número");
  });
});

describe("migración 20261223100000", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261223100000_arca_modos_ticket_no_fiscal.sql"), "utf8");
  const code = sql.replace(/--[^\n]*/g, "");

  it("no recrea create_sale (choca con ADR-151) y sí el encolado y el estado", () => {
    expect(code).not.toMatch(/function\s+(public\.)?create_sale\s*\(/i);
    expect(code).toMatch(/create or replace function arca_enqueue_sale\(p_sale_id uuid, p_manual boolean default false\)/);
    expect(code).toMatch(/if not p_manual and coalesce\(v_sale\.non_fiscal, false\) then\s+return null;/);
    expect(code).toMatch(/'ticket_mode', coalesce\(v_set\.ticket_mode, 'factura'\)/);
  });

  it("la marca la pone sólo el trigger con una elección registrada y no cambia después", () => {
    expect(code).toMatch(/new\.non_fiscal := false;/);
    expect(code).toMatch(/before insert on sales/);
    expect(code).toMatch(/before update of non_fiscal on sales/);
    expect(code).toMatch(/i\.customer_id is not distinct from new\.customer_id/);
    expect(code).toMatch(/interval '15 minutes'/);
  });

  it("audita cada cambio y respeta el gating", () => {
    expect(code).toMatch(/'arca_ticket_mode_changed'/);
    expect(code).toMatch(/'sale_ticket_only'/);
    expect(code).toMatch(/arca_assert\(true\)/);
    expect(code).toMatch(/tenant_has_feature_for\(v_tenant, 'facturacion_afip'\)/);
  });

  it("RLS: sólo lectura para dueño o encargado y staff por internal_scope, nunca is_internal", () => {
    expect(code).toMatch(/alter table sale_fiscal_intents enable row level security/);
    expect(code).toMatch(/revoke all on sale_fiscal_intents from anon, authenticated/);
    expect(code).toMatch(/\(select internal_scope\(\)\)/);
    expect(code).not.toMatch(/is_internal\(\)/);
    for (const fn of ["arca_ticket_mode_set(text)", "sale_ticket_only_set(uuid, text)", "sale_ticket_only_clear()"]) {
      expect(code).toContain(`revoke all on function ${fn} from public, anon;`);
    }
    expect(code).toContain("grant execute on function arca_enqueue_sale(uuid, boolean) to service_role;");
  });
});
