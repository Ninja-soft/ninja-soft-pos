// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  counterBytes,
  formatCountdown,
  groupCode,
  hotp,
  oneTimeScopeOk,
  oneTimeState,
  otpauthUri,
  rotatingAcceptedCounters,
  rotatingCode,
  rotatingCounter,
  rotatingWindow,
  shareCodeText,
  totp,
  totpAcceptedCounters,
  whatsappShareUrl,
} from "@/lib/security/otp";

// Mismos vectores que el humo de la cadena sobre PGlite con pgcrypto real
// (otp_hotp, otp_base32 y otp_rotating_counter de 20261023100000): si cambian
// acá o allá, la paridad TS y SQL se rompe.
const enc = (s: string) => new TextEncoder().encode(s);
const K1 = enc("12345678901234567890");
const K2 = enc("12345678901234567890123456789012");
const sec = (iso: string) => Date.parse(iso) / 1000;

describe("HOTP y TOTP (RFC 4226 y 6238)", () => {
  it("RFC 4226 apéndice D", async () => {
    expect(await hotp(K1, 0)).toBe("755224");
    expect(await hotp(K1, 1)).toBe("287082");
    expect(await hotp(K1, 2)).toBe("359152");
    expect(await hotp(K1, 9)).toBe("520489");
  });

  it("RFC 6238 con 8 dígitos, SHA-1 y SHA-256", async () => {
    expect(await totp(K1, 59, 30, "sha1", 8)).toBe("94287082");
    expect(await totp(K2, 59, 30, "sha256", 8)).toBe("46119246");
    expect(await totp(K1, 1111111109, 30, "sha1", 8)).toBe("07081804");
    expect(await totp(K2, 1111111109, 30, "sha256", 8)).toBe("68084774");
    expect(await totp(K1, 1234567890, 30, "sha1", 8)).toBe("89005924");
    expect(await totp(K2, 2000000000, 30, "sha256", 8)).toBe("90698825");
  });

  it("contador de 8 bytes big-endian como int8send()", () => {
    expect([...counterBytes(1)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...counterBytes(0x0102030405)]).toEqual([0, 0, 0, 1, 2, 3, 4, 5]);
    expect(() => counterBytes(-1)).toThrow();
  });
});

describe("base32 (RFC 4648)", () => {
  it("vectores del RFC sin relleno", () => {
    const cases: [string, string][] = [
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [plain, b32] of cases) {
      expect(base32Encode(enc(plain))).toBe(b32);
      expect(new TextDecoder().decode(base32Decode(b32))).toBe(plain);
    }
    expect(base32Encode(enc("foobar"), true)).toBe("MZXW6YTBOI======");
  });

  it("paridad con otp_base32() de SQL", () => {
    expect(base32Encode(K1)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Encode(new Uint8Array([0x00, 0xff, 0x10, 0xa5, 0xc3]))).toBe("AD7RBJOD");
  });

  it("decodifica con minúsculas y espacios, rechaza basura", () => {
    expect([...base32Decode("ad7r bjod")]).toEqual([0x00, 0xff, 0x10, 0xa5, 0xc3]);
    expect(() => base32Decode("01")).toThrow();
  });
});

describe("PIN rotativo", () => {
  it("cambia a medianoche argentina (03:00 UTC) y a mediodía con 12 h", () => {
    expect(rotatingCounter(sec("2026-10-12T03:00:00Z"), 24) - rotatingCounter(sec("2026-10-12T02:59:59Z"), 24)).toBe(1);
    expect(rotatingCounter(sec("2026-10-12T15:00:00Z"), 12) - rotatingCounter(sec("2026-10-12T14:59:59Z"), 12)).toBe(1);
    const w = rotatingWindow(sec("2026-10-12T10:00:00Z"), 24);
    expect(w.start.toISOString()).toBe("2026-10-12T03:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-13T03:00:00.000Z");
  });

  it("paridad con otp_hotp(sha256) y otp_rotating_counter() de SQL", async () => {
    expect(rotatingCounter(1791800000, 12)).toBe(41476);
    expect(await rotatingCode(K2, 1791800000, 12)).toBe("605500");
    expect(await rotatingCode(K2, 1791800000, 24)).toBe("544264");
  });

  it("acepta la ventana anterior sólo los primeros 5 minutos", () => {
    const start = sec("2026-10-12T15:00:00Z");
    const c = rotatingCounter(start, 12);
    expect(rotatingAcceptedCounters(start + 60, 12)).toEqual([c, c - 1]);
    expect(rotatingAcceptedCounters(start + 299, 12)).toEqual([c, c - 1]);
    expect(rotatingAcceptedCounters(start + 300, 12)).toEqual([c]);
    expect(rotatingAcceptedCounters(start + 3600, 12)).toEqual([c]);
  });
});

describe("app autenticadora: tolerancia y anti repetición", () => {
  it("±1 paso", () => {
    const t = 1_800_000_015;
    const c = Math.floor(t / 30);
    expect(totpAcceptedCounters(t, 30, null)).toEqual([c - 1, c, c + 1]);
  });

  it("nunca un paso ya usado ni uno anterior", () => {
    const t = 1_800_000_015;
    const c = Math.floor(t / 30);
    expect(totpAcceptedCounters(t, 30, c)).toEqual([c + 1]);
    expect(totpAcceptedCounters(t, 30, c + 1)).toEqual([]);
    expect(totpAcceptedCounters(t, 60, null)).toEqual([Math.floor(t / 60) - 1, Math.floor(t / 60), Math.floor(t / 60) + 1]);
  });

  it("otpauth:// para Google y Microsoft Authenticator", () => {
    const uri = otpauthUri({ secretBase32: "AD7RBJOD", account: "Kiosco Centro (ana@x.com)", step: 60 });
    expect(uri.startsWith("otpauth://totp/NinjaSoft%20POS:Kiosco%20Centro%20(ana%40x.com)?")).toBe(true);
    const q = new URLSearchParams(uri.split("?")[1]);
    expect(q.get("secret")).toBe("AD7RBJOD");
    expect(q.get("issuer")).toBe("NinjaSoft POS");
    expect(q.get("algorithm")).toBe("SHA1");
    expect(q.get("digits")).toBe("6");
    expect(q.get("period")).toBe("60");
  });
});

describe("PIN de un uso: ciclo de vida", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const base = { expires_at: "2026-10-12T12:05:00Z", used_at: null, revoked_at: null };

  it("activo, usado, revocado y vencido", () => {
    expect(oneTimeState(base, now)).toBe("active");
    expect(oneTimeState({ ...base, used_at: "2026-10-12T12:01:00Z" }, now)).toBe("used");
    expect(oneTimeState({ ...base, revoked_at: "2026-10-12T12:01:00Z" }, now)).toBe("revoked");
    expect(oneTimeState(base, Date.parse("2026-10-12T12:05:00Z"))).toBe("expired");
    // Usado gana a vencido: queda en el historial como usado.
    expect(oneTimeState({ ...base, used_at: "2026-10-12T12:01:00Z" }, Date.parse("2026-10-12T13:00:00Z"))).toBe("used");
  });

  it("alcance por acción y monto máximo", () => {
    expect(oneTimeScopeOk({ action: null, max_amount: null }, "sale_void", 99999)).toBe(true);
    expect(oneTimeScopeOk({ action: "sale_void", max_amount: 1000 }, "sale_void", 1000)).toBe(true);
    expect(oneTimeScopeOk({ action: "sale_void", max_amount: 1000 }, "sale_void", 1000.01)).toBe(false);
    expect(oneTimeScopeOk({ action: "sale_void", max_amount: null }, "cash_out", 1)).toBe(false);
    expect(oneTimeScopeOk({ action: null, max_amount: 500 }, "cash_out", null)).toBe(true);
  });
});

describe("presentación", () => {
  it("cuenta regresiva y código agrupado", () => {
    expect(formatCountdown(35)).toBe("35 s");
    expect(formatCountdown(250)).toBe("4 min 10 s");
    expect(formatCountdown(2 * 3600 + 5 * 60)).toBe("2 h 05 min");
    expect(formatCountdown(-3)).toBe("0 s");
    expect(groupCode("482913")).toBe("482 913");
    expect(groupCode("1234")).toBe("1234");
  });

  it("texto y link de WhatsApp sin número fijo", () => {
    const t = shareCodeText({ code: "482913", until: "2026-10-12T15:30:00Z", kind: "one_time", actionLabel: "Anular una venta" });
    expect(t).toMatch(/^PIN de un uso para anular una venta: 482 913\. Vence a las /);
    expect(t).not.toMatch(/\u2014/);
    expect(whatsappShareUrl(t)).toBe(`https://wa.me/?text=${encodeURIComponent(t)}`);
  });
});
