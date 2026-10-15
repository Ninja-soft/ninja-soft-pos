// Catálogo de medios de pago agrupado por MARCA y CANAL (config del dueño).
//
// La fuente de verdad es payment_providers.brand / .channel (migración
// 20261011150000_payment_channels). Si esas columnas todavía no existen en la
// base (o una fila vino sin ellas), se usa PROVIDER_CHANNEL_FALLBACK, keyed por
// provider_key, así la pantalla funciona igual antes y después de la migración.
//
// Puro y testeable: sin React ni Supabase.

export type PaymentChannel = "manual" | "qr_link" | "point";

export interface ProviderRow {
  key: string;
  name: string;
  kind: string;
  sort: number;
  brand?: string | null;
  channel?: string | null;
}

export interface BrandDef {
  key: string;
  name: string;
  // Subtítulo corto bajo el nombre de la marca.
  tagline: string;
  // Dónde saca el dueño sus credenciales (link de ayuda en el modal).
  credentialsUrl?: string;
  credentialsLabel?: string;
  // Canales esperados de la marca, en orden de presentación.
  channels: string[];
  // Fila (provider_key) que guarda la conexión de la marca cuando no es su
  // canal QR + link (Fiserv: la conexión de Clover vive en `fiserv`).
  connection?: string;
}

// Orden de presentación. Efectivo y transferencia van juntos en "Cobros
// directos"; el resto son cuentas que se conectan.
export const BRANDS: BrandDef[] = [
  { key: "cash", name: "Efectivo", tagline: "Lo cobrás vos en el mostrador", channels: ["cash"] },
  { key: "transfer", name: "Transferencia", tagline: "A tu CBU o alias", channels: ["transfer"] },
  {
    key: "mercadopago",
    name: "Mercado Pago",
    tagline: "QR, link de pago y terminal Point",
    credentialsUrl: "https://www.mercadopago.com.ar/developers/panel/app",
    credentialsLabel: "Tus integraciones en Mercado Pago",
    channels: ["mercadopago", "mercadopago_point"],
  },
  {
    key: "payway",
    name: "Payway",
    tagline: "Checkout con tus cuotas y terminal Point",
    credentialsUrl: "https://www.payway.com.ar",
    credentialsLabel: "Portal de comercios Payway",
    channels: ["payway", "payway_point"],
  },
  {
    key: "getnet",
    name: "Getnet",
    tagline: "Checkout con tarjeta desde el celular",
    credentialsUrl: "https://www.getnet.com.ar",
    credentialsLabel: "Portal Getnet",
    channels: ["getnet", "getnet_point"],
  },
  {
    key: "nave",
    name: "Nave",
    tagline: "QR interoperable, link y terminal Point",
    credentialsUrl: "https://naranja.com/ranty/merchants/api",
    credentialsLabel: "Documentación de Nave para comercios",
    channels: ["nave", "nave_point"],
  },
  {
    key: "modo",
    name: "MODO",
    tagline: "QR para pagar con la app MODO o del banco",
    credentialsUrl: "https://www.modo.com.ar",
    credentialsLabel: "MODO para comercios",
    channels: ["modo"],
  },
  {
    key: "mobbex",
    name: "Mobbex",
    tagline: "Checkout con tarjetas y cuotas",
    credentialsUrl: "https://mobbex.com",
    credentialsLabel: "Consola de Mobbex",
    channels: ["mobbex"],
  },
  {
    key: "pagos360",
    name: "Pagos360",
    tagline: "Link de pago, débito y DEBIN",
    credentialsUrl: "https://www.pagos360.com",
    credentialsLabel: "Panel de Pagos360",
    channels: ["pagos360"],
  },
  {
    key: "gocuotas",
    name: "GO Cuotas",
    tagline: "2 a 4 cuotas sin interés con débito",
    credentialsUrl: "https://www.gocuotas.com",
    credentialsLabel: "Panel de GO Cuotas",
    channels: ["gocuotas"],
  },
  {
    key: "directo",
    name: "Directo",
    tagline: "Crédito en cuotas fijas sin tarjeta",
    credentialsUrl: "https://minegocio.directo.com.ar/login",
    credentialsLabel: "Portal de comercios de Directo",
    channels: ["directo"],
  },
  {
    key: "ualabis",
    name: "Ualá Bis",
    tagline: "Link de pago y QR, más tu QR, POS o Tap",
    credentialsUrl: "https://developers.ualabis.com.ar/v2/ambientes",
    credentialsLabel: "Ualá Bis para desarrolladores",
    channels: ["ualabis"],
  },
  {
    key: "fiserv",
    name: "Fiserv",
    tagline: "Terminales Clover integradas y Posnet",
    credentialsUrl: "https://docs.clover.com/dev/docs/quick-reference-guides-latam-developers",
    credentialsLabel: "Guía de Clover para Argentina",
    // Canal manual (Posnet o Clover sin integrar) + Clover Point por API
    // (ADR-047). La conexión de Clover se guarda en la fila `fiserv`.
    channels: ["fiserv", "fiserv_point"],
    connection: "fiserv",
  },
];

// Marcas que se cobran a mano, sin cuenta conectada: van en "Cobros directos".
export const DIRECT_BRANDS = new Set(["cash", "transfer"]);

// Marcas con API que, sin conectar, igual se cobran a mano (registro del
// número de operación). Directo (ADR-041): conectada cobra por QR + link.
// Fiserv (ADR-047): sin conectar, Posnet o Clover sin integrar (cupón manual).
// Ualá Bis (ADR-143): el registro manual (QR, POS, Tap) sigue con la API conectada.
export const MANUAL_FALLBACK = new Set(["directo", "fiserv", "ualabis"]);

export const BRAND_BY_KEY: Record<string, BrandDef> = Object.fromEntries(
  BRANDS.map((b) => [b.key, b]),
);

// Marca y canal por provider_key cuando la base no los trae.
export const PROVIDER_CHANNEL_FALLBACK: Record<string, { brand: string; channel: PaymentChannel }> = {
  cash: { brand: "cash", channel: "manual" },
  transfer: { brand: "transfer", channel: "manual" },
  mercadopago: { brand: "mercadopago", channel: "qr_link" },
  mercadopago_point: { brand: "mercadopago", channel: "point" },
  payway: { brand: "payway", channel: "qr_link" },
  payway_point: { brand: "payway", channel: "point" },
  getnet: { brand: "getnet", channel: "qr_link" },
  getnet_point: { brand: "getnet", channel: "point" },
  nave: { brand: "nave", channel: "qr_link" },
  nave_point: { brand: "nave", channel: "point" },
  modo: { brand: "modo", channel: "qr_link" },
  mobbex: { brand: "mobbex", channel: "qr_link" },
  pagos360: { brand: "pagos360", channel: "qr_link" },
  fiserv: { brand: "fiserv", channel: "manual" },
  fiserv_point: { brand: "fiserv", channel: "point" },
  gocuotas: { brand: "gocuotas", channel: "qr_link" },
  directo: { brand: "directo", channel: "qr_link" },
  ualabis: { brand: "ualabis", channel: "qr_link" },
};

// Canales con flujo de cobro real implementado. El resto se muestra como
// "Próximamente" (sin switch ni conexión).
export const IMPLEMENTED = new Set([
  "cash",
  "transfer",
  "mercadopago",
  "mercadopago_point",
  "mobbex",
  "modo",
  "pagos360",
  "payway",
  "getnet",
  "nave",
  "nave_point",
  "gocuotas",
  "directo",
  // Ualá Bis (ADR-143): link + QR por API y registro manual.
  "ualabis",
  // Fiserv (ADR-047): Posnet/Clover sin integrar (habilita la Tarjeta en
  // posnet) y Clover Point por Cloud Pay Display.
  "fiserv",
  "fiserv_point",
]);

// Proveedores cuyo ambiente de prueba cambia de verdad el host de la Edge.
// Mercado Pago tiene el suyo aparte (token de prueba, ADR-032).
// getnet (ADR-065): prueba = Web Checkout sandbox u homologación.
export const SANDBOX_PROVIDERS = new Set(["modo", "pagos360", "payway", "nave", "gocuotas", "directo", "fiserv", "getnet", "ualabis"]);

// Planes (cuotas por tarjeta + recargo): canal que los MUESTRA → provider_key
// con el que se guardan en payment_plans. Mercado Pago los presenta en Point
// (pedido del dueño) pero siguen guardados bajo 'mercadopago' para no tocar el
// modelo de datos ni el cobro del POS, que los lee con esa key.
export const PLANS_KEY_BY_CHANNEL: Record<string, string> = {
  mercadopago_point: "mercadopago",
  payway: "payway",
  payway_point: "payway",
  mobbex: "mobbex",
};

// Recargo del canal: cómo se configura.
//   flat      → % plano del medio (input en la fila).
//   plans     → vive en el grid de Planes de ese canal.
//   shared    → usa los Planes de la marca configurados en otro canal.
//   terminal  → lo resuelve la terminal (sin % acá).
export type SurchargeMode = "flat" | "plans" | "shared" | "terminal";

export function surchargeModeOf(channelKey: string, channel: PaymentChannel): SurchargeMode {
  if (PLANS_KEY_BY_CHANNEL[channelKey]) return "plans";
  // El QR + link de MP comparte el recargo/planes de 'mercadopago' (Point).
  if (channelKey === "mercadopago") return "shared";
  // Posnet o Clover sin integrar: las cuotas y el recargo los define la terminal.
  if (channelKey === "fiserv") return "terminal";
  if (channel === "point") return "terminal";
  return "flat";
}

// Conexión (credenciales) que usa cada canal: la de su marca (su canal QR +
// link, o la fila `connection` de la marca). Los canales Point no piden
// credenciales propias.
export function connectionKeyOf(brandKey: string): string | null {
  const b = BRAND_BY_KEY[brandKey];
  if (!b || DIRECT_BRANDS.has(brandKey)) return null;
  if (b.connection) return b.connection;
  const qr = b.channels.find((c) => PROVIDER_CHANNEL_FALLBACK[c]?.channel === "qr_link");
  return qr ?? null;
}

export interface ChannelEntry {
  key: string;
  name: string;
  channel: PaymentChannel;
  implemented: boolean;
  // true si no hay fila en payment_providers (se muestra como Próximamente).
  placeholder: boolean;
}

export interface BrandGroup {
  brand: BrandDef;
  channels: ChannelEntry[];
}

function normalizeChannel(c: string | null | undefined): PaymentChannel | null {
  return c === "manual" || c === "qr_link" || c === "point" ? c : null;
}

export function channelLabel(c: PaymentChannel): string {
  return c === "point" ? "Point" : c === "qr_link" ? "QR + link" : "Manual";
}

// Agrupa los proveedores activos por marca, en el orden de BRANDS. Los canales
// esperados que no están en la base y no están implementados se agregan como
// placeholder "Próximamente"; los implementados sin fila se omiten (no se
// podrían guardar).
export function groupProvidersByBrand(providers: ProviderRow[]): BrandGroup[] {
  const byBrand = new Map<string, ChannelEntry[]>();
  for (const p of providers) {
    const fb = PROVIDER_CHANNEL_FALLBACK[p.key];
    const brand = p.brand || fb?.brand || p.key;
    const channel = normalizeChannel(p.channel) ?? fb?.channel ?? (p.kind === "manual" ? "manual" : "qr_link");
    const list = byBrand.get(brand) ?? [];
    list.push({
      key: p.key,
      name: p.name,
      channel,
      implemented: IMPLEMENTED.has(p.key),
      placeholder: false,
    });
    byBrand.set(brand, list);
  }

  const groups: BrandGroup[] = [];
  const known = new Set(BRANDS.map((b) => b.key));
  for (const brand of BRANDS) {
    const present = byBrand.get(brand.key) ?? [];
    if (present.length === 0) continue;
    const ordered: ChannelEntry[] = [];
    for (const ck of brand.channels) {
      const row = present.find((c) => c.key === ck);
      if (row) ordered.push(row);
      else if (!IMPLEMENTED.has(ck)) {
        const fb = PROVIDER_CHANNEL_FALLBACK[ck];
        ordered.push({
          key: ck,
          name: `${brand.name} ${fb ? channelLabel(fb.channel) : ""}`.trim(),
          channel: fb?.channel ?? "point",
          implemented: false,
          placeholder: true,
        });
      }
    }
    // Canales que la base trae pero el catálogo local no conoce: al final.
    for (const c of present) if (!brand.channels.includes(c.key)) ordered.push(c);
    groups.push({ brand, channels: ordered });
  }
  // Marcas nuevas que la UI todavía no conoce: igual se muestran.
  byBrand.forEach((channels, key) => {
    if (known.has(key)) return;
    groups.push({
      brand: { key, name: channels[0]?.name ?? key, tagline: "", channels: channels.map((c) => c.key) },
      channels,
    });
  });
  return groups;
}
