// ADR-156: complemento "Email con dominio NinjaSoft". Lógica pura (espejo de
// email_addon_local_part, email_addon_consume y email_addon_bill_overage de
// la migración 20261224100000_addon_email_cobro; los mismos casos se
// verificaron contra el SQL en PGlite) y textos de confirmación del monto.
import { describe, expect, it } from "vitest";
import {
  dnsHostLabel,
  emailAddonErrorMessage,
  emailLocalPart,
  findDomain,
  isPlausibleResendKey,
  isValidDomain,
  isValidFixedLocal,
  keyHint,
  ninjaEmailErrorMessage,
  overageBlocks,
  parseResendDomain,
  quotaCheck,
  quoteSummary,
  senderAddress,
  usageLevel,
  type EmailAddonQuote,
} from "@/lib/billing/emailAddon";
import { formatCurrency } from "@/lib/utils/format";
import { formatDay } from "@/lib/billing/ledger";

describe("remitente", () => {
  it("parte local desde el slug, igual que el SQL", () => {
    expect(emailLocalPart("Kiosco Don Pepe!!")).toBe("kiosco-don-pepe");
    expect(emailLocalPart("--a..b--")).toBe("a-b");
    expect(emailLocalPart("")).toBe("negocio");
    expect(emailLocalPart(null)).toBe("negocio");
    expect(emailLocalPart("ÑANDÚ café")).toBe("nandu-cafe");
    expect(emailLocalPart("x".repeat(60))).toHaveLength(40);
  });

  it("uno por negocio o casilla fija, siempre en el dominio", () => {
    expect(senderAddress({ mode: "business", slug: "la-jamonera", domain: "soft.ninja" })).toBe("la-jamonera@soft.ninja");
    expect(senderAddress({ mode: "fixed", fixedLocal: "notificaciones", slug: "x", domain: "Soft.Ninja" })).toBe(
      "notificaciones@soft.ninja",
    );
    expect(senderAddress({ mode: "fixed", fixedLocal: "", slug: "kiosco" })).toBe("kiosco@soft.ninja");
  });

  it("valida dominio, casilla y key", () => {
    expect(isValidDomain("soft.ninja")).toBe(true);
    expect(isValidDomain("mail.soft.ninja")).toBe(true);
    expect(isValidDomain("softninja")).toBe(false);
    expect(isValidDomain("Soft.Ninja")).toBe(false);
    expect(isValidFixedLocal("notificaciones")).toBe(true);
    expect(isValidFixedLocal("no reply")).toBe(false);
    expect(isPlausibleResendKey("re_123456789abc")).toBe(true);
    expect(isPlausibleResendKey("sk_123456789abc")).toBe(false);
    expect(keyHint("re_123456789abcd")).toBe("…abcd");
  });
});

describe("cupo del mes", () => {
  it("bloquear: no sale nada que pase el cupo y avisa una vez al 100 %", () => {
    expect(quotaCheck({ sent: 9, quota: 10, policy: "block" })).toEqual({ allowed: true, over: 0, warn: 100 });
    expect(quotaCheck({ sent: 10, quota: 10, policy: "block", warned100: true })).toEqual({ allowed: false, over: 1, warn: null });
    expect(quotaCheck({ sent: 10, quota: 10, policy: "block" })).toEqual({ allowed: false, over: 1, warn: 100 });
  });

  it("avisar y cobrar: sale igual y cuenta el excedente", () => {
    expect(quotaCheck({ sent: 10, quota: 10, policy: "warn", warned80: true, warned100: true })).toEqual({ allowed: true, over: 1, warn: null });
    expect(quotaCheck({ sent: 12, quota: 10, count: 3, policy: "charge", warned80: true, warned100: true })).toEqual({
      allowed: true,
      over: 3,
      warn: null,
    });
    // Cruza el cupo con un lote: sólo cuenta lo que pasa.
    expect(quotaCheck({ sent: 8, quota: 10, count: 5, policy: "charge", warned80: true }).over).toBe(3);
  });

  it("aviso al 80 % una sola vez, y el 100 % gana si cruza los dos", () => {
    expect(quotaCheck({ sent: 7, quota: 10, policy: "block" }).warn).toBe(80);
    expect(quotaCheck({ sent: 8, quota: 10, policy: "block", warned80: true }).warn).toBeNull();
    expect(quotaCheck({ sent: 6, quota: 10, count: 4, policy: "warn" }).warn).toBe(100);
    expect(quotaCheck({ sent: 1, quota: 10, policy: "block" }).warn).toBeNull();
  });

  it("bloques de excedente para arriba", () => {
    expect(overageBlocks(0, 1000)).toBe(0);
    expect(overageBlocks(1, 1000)).toBe(1);
    expect(overageBlocks(1000, 1000)).toBe(1);
    expect(overageBlocks(1001, 1000)).toBe(2);
    expect(overageBlocks(3, 5)).toBe(1);
  });

  it("nivel de uso para la barra", () => {
    expect(usageLevel(0, 0)).toEqual({ pct: 0, level: "ok" });
    expect(usageLevel(8, 10)).toEqual({ pct: 80, level: "warn" });
    expect(usageLevel(12, 10)).toEqual({ pct: 100, level: "full" });
  });
});

describe("Resend", () => {
  const raw = {
    id: "d_1",
    name: "soft.ninja",
    status: "pending",
    region: "us-east-1",
    records: [
      { record: "SPF", name: "send", type: "MX", ttl: "Auto", status: "pending", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
      { record: "DKIM", name: "resend._domainkey", type: "txt", ttl: "Auto", status: "verified", value: "p=MIGf" },
    ],
  };

  it("normaliza el dominio y sus registros", () => {
    const d = parseResendDomain(raw)!;
    expect(d.status).toBe("pending");
    expect(d.records).toHaveLength(2);
    expect(d.records[0]).toMatchObject({ type: "MX", priority: 10 });
    expect(d.records[1]).toMatchObject({ type: "TXT", priority: null, status: "verified" });
    expect(parseResendDomain({})).toBeNull();
  });

  it("encuentra el dominio en la lista", () => {
    expect(findDomain({ data: [{ id: "a", name: "otro.com", status: "verified" }, { id: "d_1", name: "Soft.Ninja", status: "pending" }] }, "soft.ninja")).toEqual({
      id: "d_1",
      status: "pending",
    });
    expect(findDomain({ data: [] }, "soft.ninja")).toBeNull();
    expect(findDomain(null, "soft.ninja")).toBeNull();
  });

  it("nombre del registro sin el dominio para cargarlo en el DNS", () => {
    expect(dnsHostLabel("send.soft.ninja", "soft.ninja")).toBe("send");
    expect(dnsHostLabel("soft.ninja", "soft.ninja")).toBe("@");
    expect(dnsHostLabel("resend._domainkey", "soft.ninja")).toBe("resend._domainkey");
  });
});

describe("confirmación del monto", () => {
  const base: EmailAddonQuote = {
    kind: "new",
    tier: { id: "t1", label: "Inicial", quota: 1000, price: 5000 },
    old_price: 0,
    charge_now_cents: 333333,
    when: "next_debit",
    mode: "mp_subscription",
    cycle: "monthly",
    next_charge_date: "2026-11-04",
    cycle_total_after: 95000,
    next_debit_amount: 98333.33,
    effective_from: "2026-10-15",
  };
  const fmt = (n: number) => formatCurrency(n);

  it("débito de MP: hoy nada, el próximo débito con el prorrateo y después el total", () => {
    const s = quoteSummary(base, fmt, formatDay);
    expect(s.headline).toContain("Inicial");
    expect(s.lines.join(" ")).toContain("04/11/2026");
    expect(s.lines.join(" ")).toContain(fmt(3333.33));
    expect(s.lines.join(" ")).toContain(fmt(98333.33));
    expect(s.lines.join(" ")).toContain(fmt(95000));
  });

  it("prueba gratis: no se cobra hasta que termine", () => {
    const s = quoteSummary({ ...base, when: "trial", charge_now_cents: 0 }, fmt, formatDay);
    expect(s.lines[0]).toMatch(/no pagás nada/);
  });

  it("cuenta corriente y bajada de escalón", () => {
    expect(quoteSummary({ ...base, when: "account" }, fmt, formatDay).lines[0]).toMatch(/cuenta corriente/);
    const d = quoteSummary({ ...base, kind: "downgrade", effective_from: "2026-11-04" }, fmt, formatDay);
    expect(d.headline).toContain("04/11/2026");
    expect(d.lines.join(" ")).toMatch(/No se devuelve/);
  });

  it("sin em dash en los textos al usuario", () => {
    const all = [
      ...(["new", "upgrade", "downgrade", "same"] as const).flatMap((kind) =>
        (["trial", "next_debit", "account", "next_period", "none"] as const).flatMap((when) => {
          const s = quoteSummary({ ...base, kind, when }, fmt, formatDay);
          return [s.headline, ...s.lines];
        }),
      ),
      ...["price_changed", "subscription_inactive", "addon_granted", "x"].map(emailAddonErrorMessage),
      ...["addon_inactive", "quota_exceeded", "domain_not_verified", "subscription_inactive", "x"].map(ninjaEmailErrorMessage),
    ];
    for (const t of all) expect(t).not.toMatch(/—/);
  });
});
