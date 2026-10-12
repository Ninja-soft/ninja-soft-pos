import { describe, expect, it } from "vitest";
import {
  PRESET_DEFAULTS,
  QUICK_KEYS_BASE_MAX,
  layoutNeedsQuickKeysPro,
  posLayoutSchema,
  resolveLayout,
  sanitizeLayout,
} from "@/lib/pos/layout";

const UUID = "2f7c2b8e-4d59-4c3e-9a51-6f1f0a3c9b11";

describe("schema del diseño del POS", () => {
  it("los defaults de cada preset son válidos", () => {
    for (const layout of Object.values(PRESET_DEFAULTS)) {
      expect(posLayoutSchema.safeParse(layout).success).toBe(true);
    }
  });

  it("sin nada guardado cae al Mostrador", () => {
    expect(resolveLayout(null)).toEqual(PRESET_DEFAULTS.mostrador);
  });

  it("descarta campo por campo lo inválido sin perder lo válido", () => {
    const s = sanitizeLayout({
      preset: "boutique",
      density: "gigante",
      columns: "5",
      fontScale: 4,
      payments: { pinned: ["cash"], quickCash: [-1] },
      inventado: true,
    });
    expect(s).toEqual({ preset: "boutique", columns: "5", payments: { pinned: ["cash"] } });
  });

  it("ignora basura que no es un objeto", () => {
    expect(sanitizeLayout("mostrador")).toEqual({});
    expect(sanitizeLayout([1, 2])).toEqual({});
  });
});

describe("resolución negocio + usuario", () => {
  it("el negocio ajusta encima de su preset", () => {
    const l = resolveLayout({ preset: "boutique", columns: "4", accent: "violet" });
    expect(l.preset).toBe("boutique");
    expect(l.showImages).toBe(true);
    expect(l.columns).toBe("4");
    expect(l.accent).toBe("violet");
  });

  it("el usuario puede pisar el preset y no arrastra lo visual del negocio", () => {
    const l = resolveLayout(
      { preset: "boutique", columns: "4", accent: "violet" },
      { preset: "caja_rapida" },
    );
    expect(l.preset).toBe("caja_rapida");
    expect(l.keypad).toBe(true);
    expect(l.columns).toBe("auto");
    // Lo que no es visual (acento) sí se mantiene.
    expect(l.accent).toBe("violet");
  });

  it("las teclas rápidas son del negocio: el override de usuario no las trae", () => {
    const keys = [{ productId: UUID }];
    const l = resolveLayout({ quickKeys: keys }, { quickKeys: [{ productId: UUID, color: "gold" }] });
    expect(l.quickKeys).toEqual(keys);
  });

  it("mezcla las preferencias de pago por sub-campo", () => {
    const l = resolveLayout(
      { payments: { pinned: ["cash"], quickCash: [5000] } },
      { payments: { pinned: ["mercadopago:qr"] } },
    );
    expect(l.payments).toEqual({
      order: [],
      hidden: [],
      pinned: ["mercadopago:qr"],
      quickCash: [5000],
    });
  });
});

describe("teclas rápidas pro (espejo del trigger)", () => {
  const keys = (n: number) => Array.from({ length: n }, () => ({ productId: UUID }));

  it("hasta el máximo básico y sin color no requiere la feature", () => {
    expect(layoutNeedsQuickKeysPro({ quickKeys: keys(QUICK_KEYS_BASE_MAX) })).toBe(false);
  });

  it("más teclas o color por tecla requieren pos_quick_keys_pro", () => {
    expect(layoutNeedsQuickKeysPro({ quickKeys: keys(QUICK_KEYS_BASE_MAX + 1) })).toBe(true);
    expect(layoutNeedsQuickKeysPro({ quickKeys: [{ productId: UUID, color: "mint" }] })).toBe(true);
  });
});
