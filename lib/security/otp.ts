// PIN autenticador (ADR-060). PURO: HOTP/TOTP (RFC 4226 y 6238), base32
// (RFC 4648), ventanas del PIN rotativo y estado de los PIN de un uso.
//
// ESPEJO del SQL de supabase/migrations/20261023100000_pin_autenticador.sql:
// otp_hotp(), otp_base32(), otp_rotating_counter() y la tolerancia de
// supervisor_authorize(). El servidor es el único que conoce los secretos y
// calcula los códigos; esto sirve para los tests de paridad, la cuenta
// regresiva de la pantalla "Mis PINes" y armar el otpauth:// del QR.

export type OtpAlgo = "sha1" | "sha256";
export type PinMode = "fixed" | "rotating" | "one_time" | "totp";

export const PIN_MODES: PinMode[] = ["fixed", "rotating", "one_time", "totp"];

export const PIN_MODE_INFO: Record<PinMode, { label: string; short: string; desc: string }> = {
  fixed: {
    label: "PIN fijo",
    short: "Fijo",
    desc: "El PIN de 4 a 6 números que carga cada supervisor. No cambia solo.",
  },
  rotating: {
    label: "PIN rotativo",
    short: "Rotativo",
    desc: "Un código de 6 números que cambia solo cada tantas horas. El supervisor lo ve en Mis PINes y se lo pasa al empleado.",
  },
  one_time: {
    label: "PIN de un uso",
    short: "Un uso",
    desc: "Código de 6 números que el supervisor genera en el momento, vence en minutos y sirve una sola vez.",
  },
  totp: {
    label: "App autenticadora",
    short: "App",
    desc: "Google Authenticator, Microsoft Authenticator o similar: el código cambia cada 30 o 60 segundos.",
  },
};

/** Argentina es UTC-3 sin horario de verano: el PIN rotativo cambia a las 00 h, 12 h, etc. de acá. */
export const ROTATION_TZ_OFFSET_SECONDS = 3 * 3600;
/** El código anterior del PIN rotativo sigue valiendo estos segundos después del cambio. */
export const ROTATING_GRACE_SECONDS = 5 * 60;
/** Pasos de la app autenticadora que se aceptan antes y después del actual. */
export const TOTP_SKEW_STEPS = 1;
export const ROTATION_HOURS_OPTIONS = [12, 24] as const;
export const ONE_TIME_MINUTES_OPTIONS = [1, 2, 5, 10, 15, 30] as const;
export const TOTP_STEPS = [30, 60] as const;
export const OTP_ISSUER = "NinjaSoft POS";

// ---------------------------------------------------------------------------
// base32 (RFC 4648, sin relleno: es lo que esperan las apps autenticadoras)
// ---------------------------------------------------------------------------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array, pad = false): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  if (pad) while (out.length % 8) out += "=";
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error("base32_invalido");
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buf &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------
/** Contador de 8 bytes big-endian (igual que int8send() en Postgres). */
export function counterBytes(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("contador_invalido");
  const out = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    out[i] = c % 256;
    c = Math.floor(c / 256);
  }
  return out;
}

/** Truncado dinámico de RFC 4226 sobre el HMAC ya calculado. */
export function truncate(hmac: Uint8Array, digits = 6): string {
  const o = hmac[hmac.length - 1]! & 15;
  const bin =
    ((hmac[o]! & 127) << 24) | (hmac[o + 1]! << 16) | (hmac[o + 2]! << 8) | hmac[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

async function hmac(algo: OtpAlgo, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("webcrypto_no_disponible");
  const k = await subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: algo === "sha1" ? "SHA-1" : "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", k, data as BufferSource));
}

export async function hotp(secret: Uint8Array, counter: number, algo: OtpAlgo = "sha1", digits = 6): Promise<string> {
  return truncate(await hmac(algo, secret, counterBytes(counter)), digits);
}

/** Contador TOTP: floor((t - desfase) / paso). */
export function totpCounter(unixSeconds: number, stepSeconds: number, offsetSeconds = 0): number {
  return Math.floor((unixSeconds - offsetSeconds) / stepSeconds);
}

export async function totp(
  secret: Uint8Array,
  unixSeconds: number,
  stepSeconds = 30,
  algo: OtpAlgo = "sha1",
  digits = 6,
): Promise<string> {
  return hotp(secret, totpCounter(unixSeconds, stepSeconds), algo, digits);
}

// ---------------------------------------------------------------------------
// PIN rotativo (pasos de horas, alineados a la hora argentina, HMAC-SHA256)
// ---------------------------------------------------------------------------
export function rotatingCounter(unixSeconds: number, hours: number): number {
  return totpCounter(unixSeconds, hours * 3600, ROTATION_TZ_OFFSET_SECONDS);
}

export interface RotatingWindow {
  counter: number;
  start: Date;
  end: Date;
}

export function rotatingWindow(unixSeconds: number, hours: number): RotatingWindow {
  const counter = rotatingCounter(unixSeconds, hours);
  const step = hours * 3600;
  const start = counter * step + ROTATION_TZ_OFFSET_SECONDS;
  return { counter, start: new Date(start * 1000), end: new Date((start + step) * 1000) };
}

export async function rotatingCode(secret: Uint8Array, unixSeconds: number, hours: number): Promise<string> {
  return hotp(secret, rotatingCounter(unixSeconds, hours), "sha256", 6);
}

/** Contadores del PIN rotativo que acepta el servidor: el actual y, en los primeros minutos, el anterior. */
export function rotatingAcceptedCounters(unixSeconds: number, hours: number, graceSeconds = ROTATING_GRACE_SECONDS): number[] {
  const w = rotatingWindow(unixSeconds, hours);
  const since = unixSeconds - w.start.getTime() / 1000;
  return since < graceSeconds ? [w.counter, w.counter - 1] : [w.counter];
}

/** Contadores de la app autenticadora: ±1 paso, nunca uno ya usado (anti repetición). */
export function totpAcceptedCounters(unixSeconds: number, step: number, lastUsed: number | null): number[] {
  const c = totpCounter(unixSeconds, step);
  const out: number[] = [];
  for (let d = -TOTP_SKEW_STEPS; d <= TOTP_SKEW_STEPS; d++) {
    const n = c + d;
    if (n >= 0 && (lastUsed == null || n > lastUsed)) out.push(n);
  }
  return out;
}

/** otpauth:// para enrolar la app (Google y Microsoft Authenticator). */
export function otpauthUri(i: { secretBase32: string; account: string; issuer?: string; step?: number; digits?: number }): string {
  const issuer = i.issuer ?? OTP_ISSUER;
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(i.account)}`;
  const q = new URLSearchParams({
    secret: i.secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(i.digits ?? 6),
    period: String(i.step ?? 30),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// PIN de un uso
// ---------------------------------------------------------------------------
export interface OneTimeLike {
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  action: string | null;
  max_amount: number | null;
}

export type OneTimeState = "active" | "used" | "expired" | "revoked";

export function oneTimeState(c: Pick<OneTimeLike, "expires_at" | "used_at" | "revoked_at">, nowMs = Date.now()): OneTimeState {
  if (c.used_at) return "used";
  if (c.revoked_at) return "revoked";
  return new Date(c.expires_at).getTime() > nowMs ? "active" : "expired";
}

/** ¿El código de un uso sirve para esta acción y monto? (espejo del servidor) */
export function oneTimeScopeOk(c: Pick<OneTimeLike, "action" | "max_amount">, action: string, amount: number | null): boolean {
  if (c.action && c.action !== action) return false;
  if (c.max_amount != null && (amount ?? 0) > c.max_amount + 0.001) return false;
  return true;
}

/** Segundos que faltan (nunca negativo). */
export function secondsLeft(untilIso: string | Date, nowMs = Date.now()): number {
  const t = typeof untilIso === "string" ? new Date(untilIso).getTime() : untilIso.getTime();
  return Math.max(0, Math.ceil((t - nowMs) / 1000));
}

/** "2 h 05 min", "4 min 10 s", "35 s". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(r).padStart(2, "0")} s`;
  return `${r} s`;
}

/** "482 913": más fácil de dictar. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Texto para pasar el código por WhatsApp. */
export function shareCodeText(i: { code: string; until: string | Date; kind: PinMode; actionLabel?: string | null }): string {
  const hora = new Date(i.until).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  const que = i.kind === "one_time" ? "PIN de un uso" : "PIN de autorización";
  const para = i.actionLabel ? ` para ${i.actionLabel.toLowerCase()}` : "";
  return `${que}${para}: ${groupCode(i.code)}. Vence a las ${hora}. No lo compartas.`;
}

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
