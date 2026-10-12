import { describe, expect, it } from "vitest";
import {
  TENDERS,
  TENDER_BY_ID,
  brandRuns,
  checkoutSections,
  groupTenders,
  normalizeTenderId,
  pinnedTenders,
  resolveTenders,
  type ProviderStatus,
  type TenderContext,
} from "@/lib/pos/tenders";
import { PROVIDER_FEATURE } from "@/lib/payments/providerFeature";
import { availableCardBrands, cardBrandByKey, cardBrandLogo, cardLogoKey, plansForCard } from "@/lib/pos/cardBrands";
import { tenderLogoSrc } from "@/lib/pos/tenderLogo";

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
    expect(ids(ctx())).toEqual(["cash", "transfer", "card"]);
  });

  it("efectivo y transferencia sin fila siguen disponibles aunque haya otros medios", () => {
    const providers = [row("mercadopago")];
    expect(ids(ctx({ providers }))).toEqual(expect.arrayContaining(["cash", "transfer"]));
    // Con fila explícita apagada, no.
    const off = [row("mercadopago"), row("cash", false, false)];
    expect(ids(ctx({ providers: off }))).not.toContain("cash");
    expect(ids(ctx({ providers: off }))).toContain("transfer");
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
    expect(ids(ctx({ providers }))).toContain("card");
    expect(ids(ctx({ providers, features: { fiserv: false } }))).not.toContain("card");
    expect(ids(ctx({ providers: [row("cash")] }))).not.toContain("card");
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

  it("GO Cuotas va con su conexión y Directo sólo si está habilitado", () => {
    const providers = [row("cash"), row("gocuotas"), row("directo", false)];
    expect(ids(ctx({ providers }))).toEqual(
      expect.arrayContaining(["gocuotas:qr", "gocuotas:link", "directo"]),
    );
    expect(TENDER_BY_ID["gocuotas:qr"]?.minAmount).toBe(1500);
    expect(TENDER_BY_ID.directo?.requiresReference).toBe(true);
    expect(ids(ctx({ providers, features: { directo: false, gocuotas: false } }))).not.toEqual(
      expect.arrayContaining(["directo"]),
    );
    expect(ids(ctx())).not.toContain("directo");
  });

  it("Directo con API conectada cobra por QR + link y oculta el registro manual", () => {
    const sinApi = ids(ctx({ providers: [row("cash"), row("directo", false)] }));
    expect(sinApi).toContain("directo");
    expect(sinApi).not.toContain("directo:qr");

    const conApi = ids(ctx({ providers: [row("cash"), row("directo", true)] }));
    expect(conApi).toEqual(expect.arrayContaining(["directo:qr", "directo:link"]));
    expect(conApi).not.toContain("directo");
    expect(TENDER_BY_ID["directo:qr"]?.qrProvider).toBe("directo");
    expect(TENDER_BY_ID["directo:link"]?.featureKey).toBe("directo");
    expect(TENDER_BY_ID.directo?.manualFallback).toBe(true);
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
    expect(pinnedTenders(all).map((t) => t.id)).toEqual(["cash", "mercadopago:qr", "card"]);
    expect(pinnedTenders(all, { pinned: ["nave:qr", "payway:qr", "cash"] }).map((t) => t.id)).toEqual(
      ["nave:qr", "cash"],
    );
  });

  it("traduce los ids viejos de la tarjeta manual (débito/crédito) a Tarjeta en posnet", () => {
    expect(normalizeTenderId("card:debit")).toBe("card");
    expect(normalizeTenderId("card:credit")).toBe("card");
    expect(normalizeTenderId("cash")).toBe("cash");
    expect(pinnedTenders(all, { pinned: ["card:debit", "card:credit"] }).map((t) => t.id)).toEqual(["card"]);
    expect(groupTenders(all, { hidden: ["card:credit"] }).map((g) => g.key)).not.toContain("card");
  });
});

describe("selector de la hoja de cobro", () => {
  const all = resolveTenders(
    ctx({ providers: [row("cash"), row("transfer"), row("mercadopago"), row("fiserv"), row("nave")] }),
  );

  it("sin preferencias es igual al agrupado por medio", () => {
    expect(checkoutSections(all).map((s) => s.key)).toEqual(groupTenders(all).map((s) => s.key));
  });

  it("los favoritos van primero, en su orden, y no se repiten en su grupo", () => {
    const s = checkoutSections(all, {}, { favorites: ["mercadopago:qr", "cash", "inexistente"] });
    expect(s[0]?.key).toBe("favorites");
    expect(s[0]?.tenders.map((t) => t.id)).toEqual(["mercadopago:qr", "cash"]);
    expect(s.map((x) => x.key)).not.toContain("cash");
    expect(s.find((x) => x.key === "mercadopago")?.tenders.map((t) => t.id)).not.toContain("mercadopago:qr");
  });

  it("un favorito oculto en el negocio no aparece", () => {
    const s = checkoutSections(all, { hidden: ["cash"] }, { favorites: ["cash"] });
    expect(s.map((x) => x.key)).not.toContain("favorites");
  });

  it("oculta grupos pero nunca deja la hoja vacía", () => {
    const keys = checkoutSections(all, {}, { hiddenGroups: ["transfer", "nave"] }).map((s) => s.key);
    expect(keys).toEqual(["cash", "card", "mercadopago"]);
    const everything = ["cash", "transfer", "card", "mercadopago", "nave"];
    expect(checkoutSections(all, {}, { hiddenGroups: everything }).length).toBeGreaterThan(0);
  });
});

describe("tarjeta en posnet", () => {
  const plans = [
    { id: "v1", base: "credito", brand: "visa", installments: 1 },
    { id: "v6", base: "credito", brand: "visa", installments: 6 },
    { id: "v3", base: "credito", brand: "visa", installments: 3 },
    { id: "m3", base: "credito", brand: "master", installments: 3 },
    { id: "any", base: "credito", brand: null, installments: 12 },
    { id: "vd", base: "debito", brand: "visa", installments: 1 },
  ];

  it("ofrece siempre todas las entidades (con o sin planes) y Otra al final", () => {
    const all = ["visa", "master", "amex", "cabal", "naranja", "maestro", "diners", "other"];
    expect(availableCardBrands(plans).map((b) => b.key)).toEqual(all);
    expect(availableCardBrands([]).map((b) => b.key)).toEqual(all);
  });

  it("filtra los planes por entidad y tipo, ordenados por cuotas", () => {
    expect(plansForCard(plans, "visa", "credit").map((p) => p.id)).toEqual(["v1", "v3", "v6", "any"]);
    expect(plansForCard(plans, "master", "credit").map((p) => p.id)).toEqual(["m3", "any"]);
    expect(plansForCard(plans, "visa", "debit").map((p) => p.id)).toEqual(["vd"]);
    expect(plansForCard(plans, null, "credit").map((p) => p.id)).toEqual(["any"]);
  });

  it("Maestro es sólo débito y Amex sólo crédito", () => {
    expect(cardBrandByKey("maestro")?.kinds).toEqual(["debit"]);
    expect(cardBrandByKey("amex")?.kinds).toEqual(["credit"]);
    expect(cardBrandByKey("nada")).toBeNull();
  });
});

describe("logos del cobro", () => {
  it("las entidades usan los logos oficiales de public/images/cards con variante oscura", () => {
    expect(cardBrandLogo("visa", "credit")).toBe("/images/cards/visa.webp");
    expect(cardBrandLogo("visa", "debit")).toBe("/images/cards/visa-debito.webp");
    expect(cardBrandLogo("visa", "credit", { on: "dark" })).toBe("/images/cards/visa-on-dark.webp");
    expect(cardBrandLogo("master", "debit")).toBe("/images/cards/mastercard.webp");
    expect(cardBrandLogo("other")).toBeNull();
    expect(cardLogoKey("visa", "debit")).toBe("visa_debito");
    expect(cardLogoKey(null)).toBeNull();
  });

  it("el logo del tender elige la variante para fondo oscuro si la marca la tiene", () => {
    const transfer = TENDER_BY_ID.transfer!;
    expect(tenderLogoSrc(transfer, "light")).toBe(transfer.logo);
    expect(tenderLogoSrc(transfer, "dark")).toBe("/images/payments/transferencia-icon-on-dark.webp");
    const cash = TENDER_BY_ID.cash!;
    expect(tenderLogoSrc(cash, "dark")).toBe(cash.logo);
    expect(tenderLogoSrc({ logo: null }, "dark")).toBeNull();
  });
});

describe("marcas con varios canales en billeteras", () => {
  it("GO Cuotas y Directo con API quedan juntos por marca; Directo sin API es un solo canal", () => {
    const withApi = resolveTenders(
      ctx({ providers: [row("cash"), row("gocuotas"), row("directo"), row("modo")] }),
    ).filter((t) => t.group === "wallets");
    const runs = brandRuns(withApi).map((r) => r.map((t) => t.id));
    expect(runs).toContainEqual(["gocuotas:qr", "gocuotas:link"]);
    expect(runs).toContainEqual(["directo:qr", "directo:link"]);
    expect(runs).toContainEqual(["modo:qr"]);

    const noApi = resolveTenders(ctx({ providers: [row("cash"), row("directo", false)] })).filter(
      (t) => t.group === "wallets",
    );
    expect(brandRuns(noApi).map((r) => r.map((t) => t.id))).toEqual([["directo"]]);
  });
});
