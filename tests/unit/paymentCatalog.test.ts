import { describe, expect, it } from "vitest";
import {
  MANUAL_FALLBACK,
  PLANS_KEY_BY_CHANNEL,
  SANDBOX_PROVIDERS,
  connectionKeyOf,
  groupProvidersByBrand,
  surchargeModeOf,
  type ProviderRow,
} from "@/lib/payments/catalog";
import { paymentIcon, paymentWordmark } from "@/lib/payments/logos";

const row = (key: string, sort: number, extra: Partial<ProviderRow> = {}): ProviderRow => ({
  key,
  name: key,
  kind: key === "cash" || key === "transfer" ? "manual" : "gateway",
  sort,
  ...extra,
});

describe("groupProvidersByBrand", () => {
  it("agrupa por marca con el mapeo local cuando la base no trae brand/channel", () => {
    const groups = groupProvidersByBrand([
      row("cash", 1),
      row("mercadopago_point", 3),
      row("mercadopago", 2),
      row("nave", 9),
      row("nave_point", 10),
    ]);
    expect(groups.map((g) => g.brand.key)).toEqual(["cash", "mercadopago", "nave"]);
    const mp = groups.find((g) => g.brand.key === "mercadopago")!;
    expect(mp.channels.map((c) => [c.key, c.channel])).toEqual([
      ["mercadopago", "qr_link"],
      ["mercadopago_point", "point"],
    ]);
  });

  it("respeta brand/channel de la base", () => {
    const [g] = groupProvidersByBrand([row("getnet", 1, { brand: "getnet", channel: "qr_link" })]);
    expect(g!.brand.key).toBe("getnet");
    // getnet_point no está implementado: aparece como placeholder Próximamente.
    expect(g!.channels.map((c) => [c.key, c.implemented, c.placeholder])).toEqual([
      ["getnet", true, false],
      ["getnet_point", false, true],
    ]);
  });

  it("no inventa canales implementados que faltan en la base", () => {
    const [g] = groupProvidersByBrand([row("nave", 1)]);
    expect(g!.channels.map((c) => c.key)).toEqual(["nave"]);
  });

  it("GO Cuotas y Directo son QR + link con conexión propia (Directo con respaldo manual)", () => {
    const groups = groupProvidersByBrand([row("gocuotas", 1), row("directo", 2)]);
    expect(groups.map((g) => [g.brand.key, g.channels[0]!.channel])).toEqual([
      ["gocuotas", "qr_link"],
      ["directo", "qr_link"],
    ]);
    expect(connectionKeyOf("gocuotas")).toBe("gocuotas");
    expect(connectionKeyOf("directo")).toBe("directo");
    expect(MANUAL_FALLBACK.has("directo")).toBe(true);
    expect(SANDBOX_PROVIDERS.has("directo")).toBe(true);
    expect(paymentIcon("gocuotas")).toBe("/images/payments/gocuotas-icon.webp");
    expect(paymentWordmark("directo")).toBe("/images/payments/directo-wordmark.webp");
  });

  it("muestra marcas desconocidas al final", () => {
    const groups = groupProvidersByBrand([row("cash", 1), row("nueva", 2)]);
    expect(groups.map((g) => g.brand.key)).toEqual(["cash", "nueva"]);
  });
});

describe("planes y recargo por canal", () => {
  it("los Planes de Mercado Pago viven en Point pero se guardan como 'mercadopago'", () => {
    expect(PLANS_KEY_BY_CHANNEL.mercadopago_point).toBe("mercadopago");
    expect(PLANS_KEY_BY_CHANNEL.mercadopago).toBeUndefined();
    expect(surchargeModeOf("mercadopago_point", "point")).toBe("plans");
    expect(surchargeModeOf("mercadopago", "qr_link")).toBe("shared");
  });

  it("Payway y Mobbex usan Planes en su checkout; el resto recargo plano o terminal", () => {
    expect(surchargeModeOf("payway", "qr_link")).toBe("plans");
    expect(surchargeModeOf("mobbex", "qr_link")).toBe("plans");
    expect(surchargeModeOf("modo", "qr_link")).toBe("flat");
    expect(surchargeModeOf("cash", "manual")).toBe("flat");
    expect(surchargeModeOf("nave_point", "point")).toBe("terminal");
  });

  it("los Point usan la conexión de su marca", () => {
    expect(connectionKeyOf("mercadopago")).toBe("mercadopago");
    expect(connectionKeyOf("nave")).toBe("nave");
    expect(connectionKeyOf("cash")).toBeNull();
    expect(connectionKeyOf("fiserv")).toBeNull();
  });
});

describe("logos", () => {
  it("resuelve isotipo y logo horizontal por marca, y Point usa el de su marca", () => {
    expect(paymentIcon("mercadopago_point")).toBe("/images/payments/mercado-pago-icon.webp");
    expect(paymentWordmark("nave_point")).toBe("/images/payments/nave-wordmark.webp");
    expect(paymentWordmark("cash")).toBeNull();
    expect(paymentIcon("desconocido")).toBeNull();
  });
});
