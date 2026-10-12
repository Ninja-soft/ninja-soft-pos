// Asistente de alta de terminales (Configuración, Terminales; ADR-049, ADR-053
// y ADR-054). Lógica pura y copy del paso a paso: qué tipos de terminal hay,
// qué marca va con cada uno, cómo se identifica cada marca, el nombre
// sugerido y el resumen antes de guardar. Sin React ni Supabase.
//
// No cambia el modelo: cada tipo del asistente termina en un provider_key y
// un kind de payment_terminals que ya existían.

import { acquirerOfProvider, type AcquirerKey } from "@/lib/payments/acquirers";
import type { PaymentTerminal, TerminalKind } from "@/lib/payments/terminals";

/** Tipo de terminal tal como lo piensa el dueño (paso 1). */
export type SetupType = "point" | "qr" | "integrated" | "manual";

export interface SetupTypeDef {
  key: SetupType;
  title: string;
  /** Una línea: cómo cobra. */
  line: string;
  /** Marcas o equipos de ejemplo. */
  brands: string;
  /** provider_key que admite el tipo, en el orden en que se ofrecen. */
  providers: string[];
  /** true = no hace falta registrarla (se explica y se lleva a Tarjeta en posnet). */
  noRecord?: boolean;
}

export const SETUP_TYPES: SetupTypeDef[] = [
  {
    key: "point",
    title: "Point integrado por internet",
    line: "El POS manda el monto y la terminal avisa cuando se pagó.",
    brands: "Mercado Pago Point, Nave Point, Clover",
    providers: ["mercadopago_point", "nave_point", "fiserv_point"],
  },
  {
    key: "qr",
    title: "Caja QR de Mercado Pago",
    line: "QR fijo de la caja: el cliente lo escanea y el POS ve el pago.",
    brands: "Mercado Pago",
    providers: ["mercadopago"],
  },
  {
    key: "integrated",
    title: "Posnet o pinpad conectado",
    line: "La terminal cobra y devuelve el cupón solo.",
    brands: "Payway, Fiserv, Getnet por USB o red, con simulador para probar",
    providers: ["payway", "fiserv", "getnet"],
  },
  {
    key: "manual",
    title: "Posnet sin integrar",
    line: "Cobrás en el posnet y cargás el cupón.",
    brands: "Cualquier posnet",
    providers: ["payway", "fiserv", "getnet"],
    noRecord: true,
  },
];

export function setupTypeDef(key: SetupType): SetupTypeDef {
  return SETUP_TYPES.find((t) => t.key === key)!;
}

/** Tipo del asistente de una terminal ya registrada. */
export function setupTypeOf(kind: TerminalKind): SetupType {
  if (kind === "qr_caja") return "qr";
  if (kind === "posnet_integrado" || kind === "pinpad") return "integrated";
  if (kind === "posnet_manual") return "manual";
  return "point";
}

/** Nombre corto de la marca para el asistente y el nombre sugerido. */
export const PROVIDER_SHORT: Record<string, string> = {
  mercadopago_point: "Point",
  nave_point: "Nave Point",
  fiserv_point: "Clover",
  mercadopago: "QR",
  payway: "Payway",
  fiserv: "Fiserv",
  getnet: "Getnet",
};

/** Clave de logo (lib/payments/logos) de cada marca del asistente. */
export function providerLogoKey(provider: string): string {
  return provider === "fiserv" ? "fiserv" : provider;
}

export interface IdHelp {
  /** Etiqueta del campo. */
  label: string;
  placeholder: string;
  /** Dónde se encuentra, paso a paso. */
  steps: string[];
  /** Hay "Detectar" (lista los equipos de la cuenta del proveedor). */
  detect: boolean;
  /** El identificador es obligatorio. */
  required: boolean;
}

/** Ayuda para identificar la terminal (paso 3) según marca y tipo. */
export function idHelp(provider: string, kind: TerminalKind, simulator = false): IdHelp {
  if (provider === "mercadopago_point") {
    return {
      label: "Device id del lector",
      placeholder: "PAX_A910__SMARTPOS1234567890",
      steps: [
        "Prendé el Point y vinculalo a la cuenta de Mercado Pago conectada en Medios de pago.",
        "Tocá Detectar: aparecen los lectores de la cuenta y elegís el tuyo.",
        "Si no aparece, revisá que esté prendido y en la misma cuenta. El id empieza con el modelo del equipo.",
      ],
      detect: true,
      required: true,
    };
  }
  if (provider === "nave_point") {
    return {
      label: "Id de la terminal en Nave",
      placeholder: "Id del punto de venta",
      steps: [
        "Cargá las credenciales de Nave en Medios de pago.",
        "Tocá Detectar: aparecen las terminales de tu cuenta de Nave.",
        "También figura en el portal de Nave, en el detalle de cada terminal.",
      ],
      detect: true,
      required: true,
    };
  }
  if (provider === "fiserv_point") {
    return {
      label: "Número de serie de la Clover",
      placeholder: "C043UQ12345678",
      steps: [
        "Tocá Detectar: aparecen las Clover de tu cuenta.",
        "Si preferís copiarlo: está en la etiqueta de atrás del equipo o en la Clover, en Configuración, Acerca del dispositivo.",
      ],
      detect: true,
      required: true,
    };
  }
  if (provider === "mercadopago") {
    return {
      label: "Id de la caja en Mercado Pago (external_pos_id)",
      placeholder: "NINJA_CAJA_1",
      steps: [
        "Lo más simple es crearla desde acá con una caja elegida: NinjaSoft la da de alta en Mercado Pago con la dirección de la sucursal.",
        "Si ya la creaste en Mercado Pago, cargá su external_pos_id.",
      ],
      detect: false,
      required: true,
    };
  }
  if (kind === "posnet_integrado" || kind === "pinpad") {
    return {
      label: simulator ? "N° de terminal (opcional con el simulador)" : "N° de terminal",
      placeholder: "12345678",
      steps: [
        "Figura impreso en los cupones y en el cierre de lote como Terminal o TERM.",
        "También lo ves en el menú de la terminal, en la sección de datos o configuración.",
      ],
      detect: false,
      required: !simulator,
    };
  }
  return {
    label: "N° de terminal (opcional)",
    placeholder: "12345678",
    steps: ["Figura impreso en los cupones como Terminal o TERM. Sirve para reconocerla en la lista."],
    detect: false,
    required: false,
  };
}

/**
 * Nombre sugerido: marca + caja (o sucursal), sin repetir uno existente.
 *   "Point Caja 1", "Clover Mostrador", "Payway Centro (2)".
 */
export function suggestLabel(input: {
  provider: string;
  kind: TerminalKind;
  registerName?: string | null;
  storeName?: string | null;
  taken?: string[];
}): string {
  const brand = input.kind === "pinpad" ? `Pinpad ${PROVIDER_SHORT[input.provider] ?? ""}`.trim() : PROVIDER_SHORT[input.provider] ?? "Terminal";
  const place = (input.registerName || input.storeName || "").trim();
  const base = `${brand}${place ? ` ${place}` : ""}`.slice(0, 60).trim();
  const taken = new Set((input.taken ?? []).map((t) => t.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${base} (${n})`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return base;
}

/** Adquirente sugerido para la marca (n° de comercio y conciliación). */
export function defaultAcquirer(provider: string): AcquirerKey | null {
  return acquirerOfProvider(provider);
}

/** Pasos del asistente. */
export const WIZARD_STEPS = ["Tipo", "Ubicación", "Identificación", "Detalles", "Resumen"] as const;
export type WizardStep = 0 | 1 | 2 | 3 | 4;

export interface WizardDraft {
  type: SetupType | null;
  provider_key: string;
  kind: TerminalKind;
  store_id: string;
  cash_register_id: string | null;
  external_id: string;
  simulator: boolean;
  label: string;
}

/**
 * Qué falta para pasar del paso actual (null = puede seguir). El último
 * control lo hace el servidor; acá sólo se guía.
 */
export function stepProblem(step: WizardStep, d: WizardDraft): string | null {
  if (step === 0) {
    if (!d.type) return "Elegí el tipo de terminal.";
    if (d.type === "manual" && !d.provider_key) return "Elegí la marca del posnet.";
    return null;
  }
  if (step === 1) return d.store_id ? null : "Elegí la sucursal.";
  if (step === 2) {
    const help = idHelp(d.provider_key, d.kind, d.simulator);
    const v = d.external_id.trim();
    if (help.required && !v) return `Cargá el ${help.label.replace(/ \(.*\)$/, "").toLowerCase()}.`;
    if (v && !/^[A-Za-z0-9_.:-]{1,120}$/.test(v)) return "Sólo letras, números, guiones, puntos y dos puntos.";
    return null;
  }
  if (step === 3) return d.label.trim() ? null : "Poné un nombre para reconocerla.";
  return null;
}

// ── Lista agrupada (sucursal > caja) ─────────────────────────────────────────

export interface RegisterGroup {
  /** null = toda la sucursal (flotante). */
  registerId: string | null;
  name: string;
  terminals: PaymentTerminal[];
}

/**
 * Terminales de una sucursal agrupadas por caja: primero las de toda la
 * sucursal (si hay) y después cada caja en el orden recibido, con o sin
 * terminales. Dentro de cada grupo, la por defecto primero, después activas y
 * por nombre.
 */
export function groupByRegister(
  terminals: PaymentTerminal[],
  registers: { id: string; name: string }[],
): RegisterGroup[] {
  const sort = (a: PaymentTerminal, b: PaymentTerminal) =>
    Number(b.is_default) - Number(a.is_default) ||
    Number(b.active) - Number(a.active) ||
    a.label.localeCompare(b.label, "es");
  const known = new Set(registers.map((r) => r.id));
  const floating = terminals.filter((t) => !t.cash_register_id || !known.has(t.cash_register_id)).sort(sort);
  const groups: RegisterGroup[] = [];
  if (floating.length > 0) groups.push({ registerId: null, name: "Toda la sucursal", terminals: floating });
  for (const r of registers) {
    groups.push({
      registerId: r.id,
      name: r.name,
      terminals: terminals.filter((t) => t.cash_register_id === r.id).sort(sort),
    });
  }
  return groups;
}

/** Cómo elige el POS en una caja, en una línea (para el encabezado de cada caja). */
export function registerPickHint(group: RegisterGroup, floatingCount: number): string {
  const active = group.terminals.filter((t) => t.active);
  if (group.registerId === null) return "Sirven para cualquier caja de la sucursal que no tenga una propia.";
  if (active.length === 0) {
    return floatingCount > 0 ? "Sin terminal propia: usa las de toda la sucursal." : "Sin terminal: el POS no ofrece cobro integrado acá.";
  }
  if (active.length === 1) return "El POS usa esta terminal sola.";
  // El POS elige por medio: dos del mismo medio sin una por defecto = pregunta.
  const byProvider = new Map<string, PaymentTerminal[]>();
  for (const t of active) byProvider.set(t.provider_key, [...(byProvider.get(t.provider_key) ?? []), t]);
  const ambiguous = Array.from(byProvider.values()).some((l) => l.length > 1 && !l.some((t) => t.is_default));
  if (ambiguous) return "Hay dos del mismo medio sin una por defecto: el POS pregunta cuál usar.";
  return Array.from(byProvider.values()).some((l) => l.length > 1)
    ? "Con dos del mismo medio, el POS usa la marcada por defecto."
    : "El POS usa la de cada medio sola.";
}
