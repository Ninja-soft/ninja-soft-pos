// F12 · H35 — Onboarding por rubro de catálogo chico.
// Metadatos de los presets para el wizard (tarjetas + resumen de lo que siembra).
// La SIEMBRA real (categorías, productos/servicios, defaults) vive en la RPC
// `apply_industry_preset` (migración 20260608530000). Acá sólo describimos cada
// preset para la UI: la fuente de verdad de los ítems es el server. Estos
// nombres de categorías y de muestra deben coincidir con los del SQL.

import type { LucideIcon } from "lucide-react";
import {
  Croissant,
  IceCream2,
  Coffee,
  Scissors,
  Sparkles,
  Car,
  Wrench,
  Briefcase,
} from "lucide-react";

// Qué vende el negocio (paso 1 del wizard). Filtra qué ítems del preset se
// siembran y los defaults del POS (servicios → sin stock / sin exigir cliente).
export type SellsMode = "productos" | "servicios" | "ambos";

export const SELLS_OPTIONS: {
  key: SellsMode;
  label: string;
  desc: string;
}[] = [
  {
    key: "productos",
    label: "Productos",
    desc: "Vendo artículos con stock (mercadería, comida, bebidas).",
  },
  {
    key: "servicios",
    label: "Servicios",
    desc: "Cobro trabajos o turnos, sin inventario.",
  },
  {
    key: "ambos",
    label: "Ambos",
    desc: "Vendo productos y también ofrezco servicios.",
  },
];

export type PresetKey =
  | "heladeria"
  | "cafeteria"
  | "panaderia"
  | "peluqueria"
  | "estetica"
  | "lavadero"
  | "taller"
  | "servicios";

export interface PresetDef {
  key: PresetKey;
  label: string;
  desc: string;
  icon: LucideIcon;
  // Naturaleza dominante del preset: ayuda a sugerir el modo "qué vendés" y a
  // mostrar el preset acorde al paso 1 (un preset de servicios no aparece si el
  // dueño dijo "sólo productos", salvo que el preset sea mixto).
  nature: "products" | "services" | "mixed";
  // Categorías que crea (para el resumen de la tarjeta).
  categories: string[];
  // Un par de ítems de muestra a modo de ejemplo en la tarjeta.
  sampleItems: string[];
}

export const PRESETS: PresetDef[] = [
  {
    key: "heladeria",
    label: "Heladería",
    desc: "Helados por tamaño, postres y bebidas. Botones rápidos listos.",
    icon: IceCream2,
    nature: "products",
    categories: ["Helados", "Postres", "Bebidas"],
    sampleItems: ["Helado 1/4 kg", "1/2 kg", "1 kg", "Cucurucho"],
  },
  {
    key: "cafeteria",
    label: "Cafetería / take away",
    desc: "Café por tamaño, comidas al paso y bebidas frías.",
    icon: Coffee,
    nature: "products",
    categories: ["Café", "Comidas", "Bebidas frías"],
    sampleItems: ["Café chico", "mediano", "grande", "Medialuna"],
  },
  {
    key: "panaderia",
    label: "Panadería simple",
    desc: "Pan y criollos por kilo, facturas surtidas y bebidas.",
    icon: Croissant,
    nature: "products",
    categories: ["Panadería", "Facturas", "Bebidas"],
    sampleItems: ["Pan (kg)", "Factura surtida", "Medialuna"],
  },
  {
    key: "peluqueria",
    label: "Peluquería / barbería",
    desc: "Servicios de corte, color y peinado. Sin stock.",
    icon: Scissors,
    nature: "services",
    categories: ["Cortes", "Color", "Peinados"],
    sampleItems: ["Corte", "Corte + barba", "Color", "Peinado"],
  },
  {
    key: "estetica",
    label: "Estética / uñas / spa",
    desc: "Uñas, tratamientos faciales y depilación. Sin stock.",
    icon: Sparkles,
    nature: "services",
    categories: ["Uñas", "Tratamientos faciales", "Depilación"],
    sampleItems: ["Esmaltado semipermanente", "Limpieza facial", "Cejas"],
  },
  {
    key: "lavadero",
    label: "Lavadero",
    desc: "Lavados y adicionales para el auto. Sin stock.",
    icon: Car,
    nature: "services",
    categories: ["Lavados", "Adicionales"],
    sampleItems: ["Lavado exterior", "Lavado completo", "Encerado"],
  },
  {
    key: "taller",
    label: "Taller liviano",
    desc: "Mano de obra (service, aceite) y algún repuesto con stock.",
    icon: Wrench,
    nature: "mixed",
    categories: ["Mano de obra", "Repuestos"],
    sampleItems: ["Service básico", "Cambio de aceite", "Aceite (litro)"],
  },
  {
    key: "servicios",
    label: "Servicios profesionales",
    desc: "Horas de consultoría, visitas y abonos. Sin stock.",
    icon: Briefcase,
    nature: "services",
    categories: ["Servicios", "Consultoría"],
    sampleItems: ["Hora de consultoría", "Visita técnica", "Servicio mensual"],
  },
];

// Presets visibles según lo que el negocio dijo que vende (paso 1). Un preset de
// servicios no tiene sentido si el dueño eligió "sólo productos" (y viceversa);
// los mixtos aparecen siempre. En "ambos" se muestran todos.
export function presetsForSells(sells: SellsMode): PresetDef[] {
  if (sells === "ambos") return PRESETS;
  if (sells === "productos")
    return PRESETS.filter((p) => p.nature !== "services");
  return PRESETS.filter((p) => p.nature !== "products");
}

// Resultado que devuelve la RPC apply_industry_preset.
export interface ApplyPresetResult {
  categories_created: number;
  items_created: number;
  skipped: number;
  settings_applied: boolean;
}
