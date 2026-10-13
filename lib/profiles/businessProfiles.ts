// Perfiles por rubro (F5 · ADR-075). Un perfil es un PRESET que configura el
// negocio según su rubro: flags operativos de pos_settings, diseño del POS,
// categorías y unidades sugeridas, medios de pago típicos, atajos y ayuda.
//
// Fuente de verdad de los datos: `business-profiles.json` (este directorio).
// La migración 20261102200000_perfiles_rubro.sql siembra la misma lista en la
// tabla de plataforma `business_profiles` (que lee la RPC
// apply_business_profile); tests/unit/businessProfiles.test.ts falla si las dos
// copias se desalinean.
//
// Reglas (CLAUDE.md §6):
//   - Los flags de un perfil son FLAG-OPERATIVO (gratis). Un perfil sólo los
//     PRENDE, nunca los apaga, y nunca borra datos.
//   - Un perfil NO otorga features de plan: `planFeatures` y los medios de pago
//     son sugerencias que se muestran como "disponible en plan X" si el plan no
//     los incluye. El gating real sigue siendo tenant_has_feature_for.

import { z } from "zod";
import raw from "./business-profiles.json";
import { POS_PRESETS } from "@/lib/pos/layout";
import { VERTICALS } from "@/lib/verticals/config";

export const PROFILE_KEYS = [
  "kiosco",
  "almacen",
  "textil",
  "ferreteria",
  "farmacia",
  "gastronomia",
  "cafeteria",
  "verduleria",
  "libreria",
  "servicios",
  "otro",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Flags operativos de pos_settings que un perfil puede prender. */
export const PROFILE_FLAGS = [
  "dining_enabled",
  "delivery_enabled",
  "scale_enabled",
  "plu_enabled",
  "allow_free_sale",
] as const;
export type ProfileFlag = (typeof PROFILE_FLAGS)[number];

export const FLAG_INFO: Record<ProfileFlag, { label: string; help: string; feature?: string }> = {
  dining_enabled: {
    label: "Mesas y cocina (KDS)",
    help: "Salones, mesas, comandas y pantalla de cocina.",
  },
  delivery_enabled: {
    label: "Delivery propio",
    help: "Pedidos para enviar o retirar, con zonas y costo de envío.",
  },
  scale_enabled: {
    label: "Venta por peso con balanza",
    help: "Lee etiquetas de balanza y el peso en vivo de la balanza de la caja.",
    // El trigger de pos_settings exige esta feature (ADR-063).
    feature: "balanza",
  },
  plu_enabled: {
    label: "Códigos PLU",
    help: "Código corto para tipear productos sin buscarlos.",
  },
  allow_free_sale: {
    label: "Venta libre",
    help: "Cobrar un monto a mano sin cargar el producto (dueño o encargado).",
  },
};

/** Medios de cobro sugeribles: key = feature de plan del medio. */
export const PAYMENT_LABELS: Record<string, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  mercado_pago: "QR de Mercado Pago",
  mercadopago_point: "Posnet Point de Mercado Pago",
  cuenta_corriente: "Cuenta corriente (fiado)",
};

const profileSchema = z.object({
  key: z.enum(PROFILE_KEYS),
  version: z.number().int().positive(),
  label: z.string().min(1).max(60),
  tagline: z.string().min(1).max(120),
  vertical: z.enum(VERTICALS),
  flags: z.array(z.enum(PROFILE_FLAGS)),
  scanner: z.boolean(),
  posPreset: z.enum(POS_PRESETS),
  categories: z.array(z.string().min(1).max(60)).max(12),
  units: z.array(z.string().min(1).max(10)).min(1),
  payments: z.array(z.string().min(1)).min(1),
  planFeatures: z.array(z.string().min(1)),
  shortcuts: z.array(z.string().min(1)),
  tips: z.array(z.string().min(1)),
});
export type BusinessProfile = z.infer<typeof profileSchema>;

export const BUSINESS_PROFILES: readonly BusinessProfile[] = z.array(profileSchema).parse(raw);

export function isProfileKey(v: unknown): v is ProfileKey {
  return typeof v === "string" && (PROFILE_KEYS as readonly string[]).includes(v);
}

export function getProfile(key: string | null | undefined): BusinessProfile | null {
  return BUSINESS_PROFILES.find((p) => p.key === key) ?? null;
}

/**
 * Perfil sugerido para un rubro (tenants.industry) elegido en el registro.
 * Sirve para preseleccionar en el onboarding; el dueño siempre confirma.
 */
export function profileForVertical(industry: string | null | undefined): ProfileKey {
  switch (industry) {
    case "kiosco":
      return "kiosco";
    case "textil":
      return "textil";
    case "restaurante":
      return "gastronomia";
    case "cafeteria":
    case "heladeria":
    case "panaderia":
      return "cafeteria";
    case "peluqueria":
    case "estetica":
    case "servicios":
      return "servicios";
    case "retail":
    case "pyme":
    case "otro":
    default:
      return "otro";
  }
}
