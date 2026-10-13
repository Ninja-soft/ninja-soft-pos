import { describe, expect, it } from "vitest";
import {
  LAST_BUSINESS_KEY,
  clearRememberedBusiness,
  isSafeLogoUrl,
  parseRememberedBusiness,
  readRememberedBusiness,
  syncRememberedBusiness,
} from "@/lib/auth/rememberedBusiness";

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

const LOGO = "https://abc.supabase.co/storage/v1/object/public/tenant-assets/t1/logo.webp";
const fixed = () => new Date("2026-10-13T12:00:00.000Z");

describe("negocio recordado: lectura", () => {
  it("lee un valor válido", () => {
    const st = memStorage({
      [LAST_BUSINESS_KEY]: JSON.stringify({ name: "Almacén Don Pepe", logoUrl: LOGO, updatedAt: "x" }),
    });
    expect(readRememberedBusiness(st)).toEqual({ name: "Almacén Don Pepe", logoUrl: LOGO, updatedAt: "x" });
  });

  it("sin entrada devuelve null", () => {
    expect(readRememberedBusiness(memStorage())).toBeNull();
  });

  it.each([
    ["JSON roto", "{name:"],
    ["array", "[1,2]"],
    ["número", "42"],
    ["null", "null"],
    ["sin nombre", JSON.stringify({ logoUrl: LOGO })],
    ["nombre vacío", JSON.stringify({ name: "   ", logoUrl: LOGO })],
    ["sin logo", JSON.stringify({ name: "Kiosco" })],
    ["logo no string", JSON.stringify({ name: "Kiosco", logoUrl: 12 })],
    ["logo javascript:", JSON.stringify({ name: "Kiosco", logoUrl: "javascript:alert(1)" })],
    ["logo relativo", JSON.stringify({ name: "Kiosco", logoUrl: "/logo.png" })],
  ])("datos corruptos (%s) → null", (_label, raw) => {
    expect(parseRememberedBusiness(raw)).toBeNull();
  });

  it("si el storage tira error devuelve null", () => {
    const st = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readRememberedBusiness(st)).toBeNull();
  });

  it("acepta https, http y data URL de imagen; rechaza el resto", () => {
    expect(isSafeLogoUrl(LOGO)).toBe(true);
    expect(isSafeLogoUrl("http://localhost:3011/brand/ninja-isotype.webp")).toBe(true);
    expect(isSafeLogoUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeLogoUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeLogoUrl("blob:https://x/1")).toBe(false);
    expect(isSafeLogoUrl("")).toBe(false);
    expect(isSafeLogoUrl(null)).toBe(false);
  });
});

describe("negocio recordado: escritura", () => {
  it("guarda sólo nombre, logo y fecha", () => {
    const st = memStorage();
    const saved = syncRememberedBusiness({ name: "  Almacén   Don Pepe ", logoUrl: LOGO }, st, fixed);
    expect(saved).toEqual({ name: "Almacén Don Pepe", logoUrl: LOGO, updatedAt: "2026-10-13T12:00:00.000Z" });
    expect(Object.keys(JSON.parse(st.getItem(LAST_BUSINESS_KEY) as string)).sort()).toEqual([
      "logoUrl",
      "name",
      "updatedAt",
    ]);
  });

  it("no reescribe si no cambió (conserva la fecha)", () => {
    const st = memStorage();
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed);
    const again = syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, () => new Date("2030-01-01"));
    expect(again?.updatedAt).toBe("2026-10-13T12:00:00.000Z");
  });

  it("actualiza si cambió el logo", () => {
    const st = memStorage();
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed);
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO + "?v=2" }, st, fixed);
    expect(readRememberedBusiness(st)?.logoUrl).toBe(LOGO + "?v=2");
  });

  it("sin logo borra la entrada", () => {
    const st = memStorage();
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed);
    expect(syncRememberedBusiness({ name: "Kiosco", logoUrl: null }, st, fixed)).toBeNull();
    expect(st.map.has(LAST_BUSINESS_KEY)).toBe(false);
  });

  it("sin nombre o con logo inválido también borra", () => {
    const st = memStorage();
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed);
    syncRememberedBusiness({ name: "", logoUrl: LOGO }, st, fixed);
    expect(st.map.has(LAST_BUSINESS_KEY)).toBe(false);
    syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed);
    syncRememberedBusiness({ name: "Kiosco", logoUrl: "javascript:x" }, st, fixed);
    expect(st.map.has(LAST_BUSINESS_KEY)).toBe(false);
  });

  it("recorta nombres muy largos", () => {
    const st = memStorage();
    const saved = syncRememberedBusiness({ name: "x".repeat(200), logoUrl: LOGO }, st, fixed);
    expect(saved?.name.length).toBe(80);
  });

  it("si el storage está lleno no rompe", () => {
    const st = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(syncRememberedBusiness({ name: "Kiosco", logoUrl: LOGO }, st, fixed)).toBeNull();
  });
});

describe("negocio recordado: borrar", () => {
  it("borra la entrada y deja el resto del storage", () => {
    const st = memStorage({ [LAST_BUSINESS_KEY]: "{}", otra: "1" });
    clearRememberedBusiness(st);
    expect(st.map.has(LAST_BUSINESS_KEY)).toBe(false);
    expect(st.getItem("otra")).toBe("1");
  });

  it("borrar sin entrada no falla", () => {
    expect(() => clearRememberedBusiness(memStorage())).not.toThrow();
  });
});
