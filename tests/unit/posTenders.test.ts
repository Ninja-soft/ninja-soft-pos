import { describe, expect, it } from "vitest";
import {
  TENDERS,
  TENDER_BY_ID,
  groupTenders,
  pinnedTenders,
  resolveTenders,
  type ProviderStatus,
  type TenderContext,
} from "@/lib/pos/tenders";
import { PROVIDER_FEATURE } from "@/lib/payments/providerFeature";

const row = (provider_key: string, connected = true, enabled = true): ProviderStatus => ({
  provider_key,
  enabled,
  connected,
});

const ctx = (over: Partial<TenderContext> = {}): TenderContext => ({
  providers: [],
  features: undefined,
  hasCustomer: false,
  storeCreditBalance: 0,
  ...over,
});

const ids = (c: TenderContext) => resolveTenders(c).map((t) => t.id);

describe("registro de tenders", () => {
  it("cada id es único y estable marca:canal", () => {
    const all = TENDERS.map((t) => t.id);
    expect(new Set(all).size).toBe(all.length);
    expect(TENDER_BY_ID["mercadopago:point"]?.pointProvider).toBe("mercadopago_point");
  });

  it("la feature de cada proveedor sale de providerFeature (espejo del server)", () => {
    for (const t of TENDERS) {
      if (t.flow === "qr" || t.flow === "point" || t.flow === "terminal") {
        expect(t.featureKey, t.id).toBe(PROVIDER_FEATURE[t.provider ?? ""] ?? null);
      }
    }
  });

  it("cubre QR, link y Point de las marcas pedidas", () => {
    for (const id of [
      "mercadopago:qr",
      "mercadopago:link",
      "mercadopago:point",
      "payway:qr",
      "payway:link",
      "payway:point",
      "getnet:qr",
      "getnet:link",
      "nave:qr",
      "nave:link",
      "nave:point",
      "modo:qr",
      "mobbex:qr",
      "pagos360:link",
    ]) {
      expect(TENDER_BY_ID[id], id).toBeDefined();
    }
  });
});

describe("disponibilidad", () => {
  it("sin configuración ofrece sólo los medios manuales", () => {
    expect(ids(ctx())).toEqual(["cash", "transfer", "card:debit", "card:credit"]);
  });

  it("un proveedor QR necesita estar habilitado, conectado y en el plan", () => {
    expect(ids(ctx({ providers: [row("cash"), row("mercadopago", false)] }))).not.toContain(
      "mercadopago:qr",
    );
    expect(ids(ctx({ providers: [row("cash"), row("mercadopago")] }))).toContain("mercadopago:qr");
    expect(
      ids(
        ctx({
          providers: [row("cash"), row("mercadopago")],
          features: { mercado_pago: false },
        }),
      ),
    ).not.toContain("mercadopago:qr");
  });

  it("Point usa la conexión de su marca aunque el QR esté apagado", () => {
    const providers = [row("cash"), row("mercadopago", true, false), row("mercadopago_point", false)];
    expect(ids(ctx({ providers }))).toContain("mercadopago:point");
    expect(ids(ctx({ providers, features: { mercadopago_point: false } }))).not.toContain(
      "mercadopago:point",
    );
  });

  it("la tarjeta manual aparece si algún proveedor de tarjeta está habilitado y permitido", () => {
    const providers = [row("cash"), row("fiserv", false)];
    expect(ids(ctx({ providers }))).toContain("card:credit");
    expect(ids(ctx({ providers, features: { fiserv: false } }))).not.toContain("card:credit");
    expect(ids(ctx({ providers: [row("cash")] }))).not.toContain("card:debit");
  });

  it("vale y cuenta corriente dependen del cliente, el saldo y el plan", () => {
    expect(ids(ctx({ hasCustomer: true, storeCreditBalance: 500 }))).toEqual(
      expect.arrayContaining(["store_credit", "account"]),
    );
    expect(ids(ctx({ hasCustomer: true, features: { cuenta_corriente: false } }))).not.toContain(
      "account",
    );
    expect(ids(ctx({ storeCreditBalance: 500 }))).not.toContain("store_credit");
  });

  it("toma el recargo del medio sólo para efectivo y transferencia", () => {
    const tenders = resolveTenders(
      ctx({
        providers: [
          { ...row("cash"), surcharge_pct: 5 },
          { ...row("mercadopago"), surcharge_pct: 9 },
        ],
      }),
    );
    expect(tenders.find((t) => t.id === "cash")?.surchargePct).toBe(5);
    expect(tenders.find((t) => t.id === "mercadopago:qr")?.surchargePct).toBe(0);
  });
});

describe("preferencias del negocio", () => {
  const all = resolveTenders(
    ctx({ providers: [row("cash"), row("transfer"), row("mercadopago"), row("fiserv"), row("nave")] }),
  );

  it("agrupa por medio y marca, en el orden por defecto", () => {
    expect(groupTenders(all).map((g) => g.key)).toEqual([
      "cash",
      "transfer",
      "card",
      "mercadopago",
      "nave",
    ]);
  });

  it("ordenar u ocultar nunca habilita un medio", () => {
    const groups = groupTenders(all, {
      order: ["nave", "payway", "cash"],
      hidden: ["transfer", "mercadopago:link"],
    });
    expect(groups.map((g) => g.key)).toEqual(["nave", "cash", "card", "mercadopago"]);
    expect(groups.find((g) => g.key === "mercadopago")?.tenders.map((t) => t.id)).toEqual([
      "mercadopago:qr",
    ]);
  });

  it("fija efectivo y el primer cobro electrónico por defecto", () => {
    expect(pinnedTenders(all).map((t) => t.id)).toEqual(["cash", "mercadopago:qr", "card:debit"]);
    expect(pinnedTenders(all, { pinned: ["nave:qr", "payway:qr", "cash"] }).map((t) => t.id)).toEqual(
      ["nave:qr", "cash"],
    );
  });
});
