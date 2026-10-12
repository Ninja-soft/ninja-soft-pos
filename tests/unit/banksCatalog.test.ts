import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANKS,
  bankByBcraCode,
  bankBySlug,
  bankByCvuPsp,
  bankIcon,
  bankWordmark,
  searchBanks,
} from "@/lib/payments/banks";

const PUBLIC = join(process.cwd(), "public");
const onDisk = (src: string | null) => !!src && existsSync(join(PUBLIC, src));

describe("catálogo de bancos y billeteras", () => {
  it("no repite slugs y los slugs son kebab-case", () => {
    const slugs = BANKS.map((b) => b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("está ordenado por nombre corto (es)", () => {
    const names = BANKS.map((b) => b.shortName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "es")));
  });

  it("cada entidad tiene ícono y wordmark en disco (y las variantes on-dark marcadas)", () => {
    for (const b of BANKS) {
      expect(onDisk(bankIcon(b.slug)), `${b.slug} icon`).toBe(true);
      expect(onDisk(bankWordmark(b.slug)), `${b.slug} wordmark`).toBe(true);
      if (b.iconOnDark) {
        const dark = bankIcon(b.slug, { on: "dark" });
        expect(dark).toBe(`/images/banks/${b.slug}-icon-on-dark.webp`);
        expect(onDisk(dark), `${b.slug} icon on-dark`).toBe(true);
      }
      if (b.wordmarkOnDark) {
        const dark = bankWordmark(b.slug, { on: "dark" });
        expect(dark).toBe(`/images/banks/${b.slug}-wordmark-on-dark.webp`);
        expect(onDisk(dark), `${b.slug} wordmark on-dark`).toBe(true);
      }
    }
  });

  it("sin variante on-dark devuelve el logo base", () => {
    const b = BANKS.find((x) => !x.wordmarkOnDark)!;
    expect(bankWordmark(b.slug, { on: "dark" })).toBe(
      `/images/banks/${b.slug}-wordmark.webp`,
    );
    expect(bankIcon("no-existe")).toBeNull();
    expect(bankWordmark("no-existe")).toBeNull();
  });

  it("los códigos BCRA son de 3 dígitos y los de PSP de 4, sin duplicados", () => {
    const bcra = BANKS.flatMap((b) => b.bcraCodes);
    const psp = BANKS.flatMap((b) => b.cvuPsp);
    for (const c of bcra) expect(c).toMatch(/^\d{3}$/);
    for (const c of psp) expect(c).toMatch(/^\d{4}$/);
    expect(new Set(bcra).size).toBe(bcra.length);
    expect(new Set(psp).size).toBe(psp.length);
  });

  it("los alias van en minúscula y sin tildes", () => {
    for (const b of BANKS) {
      for (const a of b.aliases)
        expect(a).toBe(
          a
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase(),
        );
    }
  });

  it("busca por código BCRA y por PSP", () => {
    expect(bankByBcraCode("011")?.slug).toBe("nacion");
    expect(bankByBcraCode("007")?.slug).toBe("galicia");
    expect(bankByBcraCode("072")?.slug).toBe("santander");
    expect(bankByBcraCode("014")?.slug).toBe("provincia");
    expect(bankByBcraCode("999")).toBeNull();
    expect(bankByCvuPsp("0003")?.slug).toBe("mercado-pago");
    expect(bankByCvuPsp("0007")?.slug).toBe("uala");
    expect(bankByCvuPsp("9999")).toBeNull();
  });

  it("busca por slug", () => {
    expect(bankBySlug("galicia")?.name).toBe("Banco Galicia");
    expect(bankBySlug(null)).toBeNull();
    expect(bankBySlug("no-existe")).toBeNull();
  });

  it("searchBanks ignora tildes y mayúsculas", () => {
    expect(searchBanks("uala").map((b) => b.slug)).toContain("uala");
    expect(searchBanks("UALÁ").map((b) => b.slug)).toContain("uala");
    expect(searchBanks("nación").map((b) => b.slug)).toContain("nacion");
    expect(searchBanks("cuenta dni").map((b) => b.slug)).toContain(
      "cuenta-dni",
    );
    expect(searchBanks("")).toHaveLength(BANKS.length);
  });
});
