import { describe, expect, it } from "vitest";
import { kindForProvider, lastSeenLabel, pickTerminal, terminalExternalIdError, type PaymentTerminal } from "@/lib/payments/terminals";
import { kindsFor, paperOf, resolvePrintTarget, type Printer } from "@/lib/print/printers";
import { defaultProfile, normalizePrintProfiles } from "@/lib/print/profiles";
import { effectiveTicketBrand } from "@/lib/tickets/branchBrand";
import { mpExternalIds, mpExternalIdsFor } from "@/supabase/functions/_shared/mpOrders";

function t(p: Partial<PaymentTerminal> & { id: string }): PaymentTerminal {
  return {
    store_id: "s1",
    cash_register_id: null,
    provider_key: "mercadopago_point",
    kind: "point",
    external_id: `ext-${p.id}`,
    environment: null,
    label: p.id,
    merchant_number: null,
    acquirer: null,
    is_default: false,
    active: true,
    last_seen_at: null,
    ...p,
  };
}

describe("pickTerminal", () => {
  const base = { providerKey: "mercadopago_point", storeId: "s1", registerId: "r1" };

  it("prefiere la default de la caja", () => {
    const r = pickTerminal({
      ...base,
      terminals: [t({ id: "a", cash_register_id: "r1" }), t({ id: "b", cash_register_id: "r1", is_default: true }), t({ id: "c" })],
    });
    expect(r.terminal?.id).toBe("b");
    expect(r.reason).toBe("register_default");
  });

  it("única de la caja, después flotante de la sucursal", () => {
    expect(pickTerminal({ ...base, terminals: [t({ id: "a", cash_register_id: "r1" }), t({ id: "c" })] }).terminal?.id).toBe("a");
    expect(pickTerminal({ ...base, terminals: [t({ id: "c" })] }).reason).toBe("store");
  });

  it("no ofrece terminales de otra caja, de otra sucursal, inactivas ni de otro proveedor", () => {
    const r = pickTerminal({
      ...base,
      terminals: [
        t({ id: "x", cash_register_id: "r2" }),
        t({ id: "y", store_id: "s2" }),
        t({ id: "z", active: false }),
        t({ id: "w", provider_key: "nave_point" }),
        t({ id: "v", deleted_at: "2026-01-01" }),
      ],
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.reason).toBe("none");
  });

  it("varias flotantes: ambiguo salvo la recordada por el dispositivo", () => {
    const terminals = [t({ id: "a" }), t({ id: "b" })];
    expect(pickTerminal({ ...base, terminals }).reason).toBe("ambiguous");
    const r = pickTerminal({ ...base, terminals, rememberedExternalId: "ext-b" });
    expect(r.terminal?.id).toBe("b");
    expect(r.reason).toBe("remembered");
  });

  it("filtra por ambiente cuando se pide", () => {
    const terminals = [t({ id: "p", provider_key: "mercadopago", kind: "qr_caja", environment: "prod" })];
    expect(pickTerminal({ ...base, providerKey: "mercadopago", env: "test", terminals }).terminal).toBeNull();
    expect(pickTerminal({ ...base, providerKey: "mercadopago", env: "prod", terminals }).terminal?.id).toBe("p");
  });

  it("helpers", () => {
    expect(kindForProvider("mercadopago")).toBe("qr_caja");
    expect(kindForProvider("fiserv_point")).toBe("clover");
    expect(kindForProvider("nave_point")).toBe("point");
    expect(kindForProvider("payway")).toBe("posnet_manual");
    expect(terminalExternalIdError("point", "")).not.toBeNull();
    expect(terminalExternalIdError("posnet_manual", "")).toBeNull();
    expect(terminalExternalIdError("point", "PAX A910")).not.toBeNull();
    expect(lastSeenLabel(null)).toBe("Sin uso");
    expect(lastSeenLabel("2026-10-12T10:00:00Z", new Date("2026-10-12T10:05:00Z"))).toBe("Hace 5 min");
  });
});

function pr(p: Partial<Printer> & { id: string }): Printer {
  return {
    store_id: "s1",
    cash_register_id: null,
    name: p.id,
    kind: "thermal_80",
    connection: "browser",
    address: null,
    active: true,
    notes: null,
    last_test_at: null,
    last_test_ok: null,
    ...p,
  };
}

describe("impresoras por sucursal y caja", () => {
  const loc = { storeId: "s1", registerId: "r1" };

  it("usa la asignada y toma su papel", () => {
    const profile = { ...defaultProfile("sale"), printer_id: "a" };
    const r = resolvePrintTarget("sale", profile, [pr({ id: "a", kind: "thermal_58" })], loc);
    expect(r.reason).toBe("assigned");
    expect(r.profile.paper).toBe("58");
  });

  it("asignada archivada o de otra sucursal → respaldo, marcado como degradado", () => {
    const profile = { ...defaultProfile("sale"), printer_id: "a", fallback_printer_id: "b" };
    const r = resolvePrintTarget("sale", profile, [pr({ id: "a", store_id: "s2" }), pr({ id: "b", kind: "a4" })], loc);
    expect(r.reason).toBe("fallback");
    expect(r.degraded).toBe(true);
    expect(r.profile.paper).toBe("a4");
  });

  it("sin asignación elige una compatible: primero la de la caja", () => {
    const r = resolvePrintTarget(
      "sale",
      defaultProfile("sale"),
      [pr({ id: "store" }), pr({ id: "reg", cash_register_id: "r1" }), pr({ id: "other", cash_register_id: "r2" })],
      loc,
    );
    expect(r.printer?.id).toBe("reg");
    expect(r.reason).toBe("auto_register");
    expect(r.degraded).toBe(false);
  });

  it("comanda prefiere la comandera; etiquetas no salen en A4", () => {
    expect(kindsFor("kitchen")[0]).toBe("kitchen");
    expect(kindsFor("product_label")).not.toContain("a4");
    const r = resolvePrintTarget("kitchen", defaultProfile("kitchen"), [pr({ id: "a4", kind: "a4" })], loc);
    expect(r.reason).toBe("browser");
    expect(paperOf("label")).toBe("58");
  });

  it("los perfiles normalizan printer_id y los tipos nuevos", () => {
    const p = normalizePrintProfiles({
      sale: { printer_id: "11111111-1111-1111-1111-111111111111", fallback_printer_id: "nope" },
    });
    expect(p.sale.printer_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(p.sale.fallback_printer_id).toBeUndefined();
    expect(p.kitchen.paper).toBe("80");
    expect(p.transfer.paper).toBe("a4");
  });
});

describe("marca del ticket por sucursal", () => {
  const brand = {
    logo_url: "https://x/negocio.png",
    legal_name: "Negocio SA",
    cuit: "20-1",
    phone: "111",
    address: "Calle 1",
    ticket_footer: "Gracias",
    ticket_width: "80",
    ticket_title: null,
    ticket_legend: null,
    ticket_show_qr: true,
    ticket_show_logo: true,
  };
  const target = { storeId: "s1", registerId: null, groupId: null, multiStore: true, multiRegister: false };

  it("pisa datos por sucursal, usa contacto y logo de la sucursal", () => {
    const out = effectiveTicketBrand(
      brand,
      [{ scope: "store", scope_id: "s1", domain: "ticket", domain_key: "", patch: { ticket_footer: "Norte", use_store_contact: true } }],
      target,
      { address: "Av. Norte 10", city: "Rosario", province: null, phone: "222", logo_url: "https://x/norte.png" },
    )!;
    expect(out.ticket_footer).toBe("Norte");
    expect(out.address).toBe("Av. Norte 10, Rosario");
    expect(out.phone).toBe("222");
    expect(out.logo_url).toBe("https://x/norte.png");
    expect(out.legal_name).toBe("Negocio SA");
  });

  it("sin logo propio ni multi-sucursal hereda el del negocio", () => {
    const out = effectiveTicketBrand(brand, [], { ...target, multiStore: false }, { logo_url: "https://x/norte.png" })!;
    expect(out.logo_url).toBe("https://x/negocio.png");
  });
});

describe("caja QR de MP por caja", () => {
  it("ids externos cortos, alfanuméricos y distintos de la caja única", () => {
    const t1 = "6f1c2a3b-0000-4000-8000-123456789abc";
    const ids = mpExternalIdsFor(t1, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "12345678-1234-4234-8234-123456789012");
    expect(ids.posExternalId.length).toBeLessThanOrEqual(40);
    expect(ids.posExternalId).toMatch(/^[A-Z0-9]+$/);
    expect(ids.storeExternalId).toMatch(/^[A-Z0-9]+$/);
    expect(ids.posExternalId).not.toBe(mpExternalIds(t1).posExternalId);
    const other = mpExternalIdsFor(t1, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "99999999-1234-4234-8234-123456789012");
    expect(other.posExternalId).not.toBe(ids.posExternalId);
  });
});
