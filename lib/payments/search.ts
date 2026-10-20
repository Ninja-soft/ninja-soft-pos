// Buscador de Configuración › Medios de pago: encuentra una marca por su
// nombre, por lo que cobra (QR, link, Point, tarjeta, cuotas, transferencia,
// efectivo) o por sus canales. PURO.

import type { BrandGroup } from "@/lib/payments/catalog";

/** Sin acentos, minúsculas y espacios simples. */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Lo que el dueño busca aunque no esté en el nombre de la marca.
const EXTRA: Record<string, string[]> = {
  mercadopago: ["mp", "mercado pago", "point", "billetera", "tarjeta", "cuotas", "rapipago", "pago facil", "cupon"],
  modo: ["billetera", "bancos", "qr interoperable"],
  payway: ["prisma", "decidir", "posnet", "tarjeta", "cuotas"],
  getnet: ["santander", "tarjeta", "posnet"],
  nave: ["galicia", "naranja x", "naranja", "ranty", "tarjeta"],
  fiserv: ["posnet", "first data", "lapos", "clover", "tarjeta"],
  clover: ["fiserv", "posnet", "tarjeta"],
  mobbex: ["tarjeta", "cuotas", "link"],
  pagos360: ["debin", "debito", "link"],
  directo: ["credito", "financiacion", "cuotas sin tarjeta"],
  gocuotas: ["cuotas sin tarjeta", "debito"],
  ualabis: ["uala", "ualá", "tarjeta", "link"],
  viumi: ["macro", "banco macro", "tarjeta", "link"],
  talo: ["transferencia", "cvu", "alias"],
  dlocalgo: ["dlocal", "tarjeta", "link"],
  cash: ["efectivo", "plata"],
  transfer: ["transferencia", "cbu", "alias", "cvu"],
  account: ["cuenta corriente", "fiado", "a cuenta"],
  store_credit: ["saldo a favor", "vale"],
};

const CHANNEL_WORDS: Record<string, string[]> = {
  qr_link: ["qr", "link", "link de pago"],
  point: ["point", "terminal", "posnet", "tarjeta"],
  manual: ["manual"],
};

/** Texto donde se busca una marca. */
export function brandHaystack(g: BrandGroup): string {
  const parts = [
    g.brand.key,
    g.brand.name,
    g.brand.tagline,
    ...(EXTRA[g.brand.key] ?? []),
    ...g.channels.flatMap((c) => [c.key, c.name, ...(EXTRA[c.key] ?? []), ...(CHANNEL_WORDS[c.channel] ?? [])]),
  ];
  return normalizeSearch(parts.filter(Boolean).join(" "));
}

/** ¿La marca coincide con la búsqueda? Todas las palabras, en cualquier orden. */
export function brandMatches(g: BrandGroup, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = brandHaystack(g);
  return q.split(" ").every((w) => hay.includes(w));
}
