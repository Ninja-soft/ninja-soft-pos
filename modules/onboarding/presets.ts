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
  UtensilsCrossed,
  Beer,
  Drumstick,
  Bike,
  Store,
  ShoppingCart,
  Shirt,
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
  // Comercio general (los rubros más comunes del POS: kiosco/minimarket/retail).
  | "kiosco"
  | "minimarket"
  | "retail"
  | "heladeria"
  | "cafeteria"
  | "panaderia"
  | "peluqueria"
  | "estetica"
  | "lavadero"
  | "taller"
  | "servicios"
  // F13 · H47 — presets gastronómicos que enganchan la suite de gastronomía
  // (mesas/cocina/delivery). Activan dining_enabled/delivery_enabled y siembran
  // salón + mesas / zona de envío en la RPC apply_industry_preset.
  | "restaurante"
  | "resto_bar"
  | "rotiseria"
  | "dark_kitchen";

// F13 · H47 — qué módulo de gastronomía activa cada preset. La RPC lo aplica de
// verdad (dining_enabled / delivery_enabled + salón/zona); acá sólo lo declaramos
// para que la tarjeta del wizard muestre "Incluye mesas y cocina (KDS)" /
// "Incluye delivery". Vacío/ausente = preset que no toca la suite gastronómica.
export type PresetEnable = "dining" | "delivery";

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
  // F13 · H47 — módulos de gastronomía que el preset deja activados (la RPC los
  // enciende de verdad). La tarjeta muestra un hint por cada uno. Ausente = no
  // toca la suite gastronómica (presets clásicos: heladería, peluquería, etc.).
  enables?: PresetEnable[];
}

export const PRESETS: PresetDef[] = [
  {
    key: "kiosco",
    label: "Kiosco",
    desc: "Golosinas, bebidas, cigarrillos y snacks. Venta rápida al mostrador.",
    icon: Store,
    nature: "products",
    categories: ["Golosinas", "Bebidas", "Cigarrillos", "Snacks"],
    sampleItems: ["Alfajor", "Gaseosa lata", "Cigarrillos box", "Papas fritas"],
  },
  {
    key: "minimarket",
    label: "Minimarket / almacén",
    desc: "Almacén, bebidas, lácteos y limpieza. Ideal autoservicio chico.",
    icon: ShoppingCart,
    nature: "products",
    categories: ["Almacén", "Bebidas", "Lácteos", "Limpieza"],
    sampleItems: ["Arroz 1 kg", "Gaseosa 1.5L", "Leche 1L", "Lavandina 1L"],
  },
  {
    key: "retail",
    label: "Retail / indumentaria",
    desc: "Ropa, calzado y accesorios. Pensado para trabajar con variantes.",
    icon: Shirt,
    nature: "products",
    categories: ["Indumentaria", "Calzado", "Accesorios"],
    sampleItems: ["Remera", "Pantalón", "Zapatillas", "Gorra"],
  },
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

  // ── Gastronomía (F13 · H47) — enganchan la suite: mesas/cocina (KDS) y/o
  // delivery. Los nombres de categorías e ítems DEBEN coincidir con el SQL de
  // apply_industry_preset (migración 20260608760000_gastro_presets).
  {
    key: "restaurante",
    label: "Restaurante (salón)",
    desc: "Mesas con cocina: entradas, principales y postres. Comandas al KDS.",
    icon: UtensilsCrossed,
    nature: "products",
    categories: ["Entradas", "Principales", "Postres", "Bebidas"],
    sampleItems: ["Empanada", "Milanesa con papas", "Flan", "Gaseosa lata"],
    enables: ["dining"],
  },
  {
    key: "resto_bar",
    label: "Resto-bar",
    desc: "Salón + barra + delivery: para compartir, principales, tragos y cervezas.",
    icon: Beer,
    nature: "products",
    categories: [
      "Para compartir",
      "Principales",
      "Tragos",
      "Cervezas",
      "Postres",
    ],
    sampleItems: ["Picada", "Bife de chorizo", "Fernet con cola", "Cerveza pinta"],
    enables: ["dining", "delivery"],
  },
  {
    key: "rotiseria",
    label: "Rotisería",
    desc: "Mostrador + delivery: pollo, empanadas y guarniciones. Zona de envío lista.",
    icon: Drumstick,
    nature: "products",
    categories: ["Rotisería", "Empanadas", "Guarniciones", "Bebidas"],
    sampleItems: ["Pollo al spiedo", "Docena de empanadas", "Papas fritas"],
    enables: ["delivery"],
  },
  {
    key: "dark_kitchen",
    label: "Cocina oculta (delivery)",
    desc: "Solo delivery: hamburguesas, pizzas y acompañamientos. Sin mostrador.",
    icon: Bike,
    nature: "products",
    categories: ["Hamburguesas", "Pizzas", "Acompañamientos", "Bebidas"],
    sampleItems: ["Hamburguesa completa", "Pizza muzzarella", "Papas fritas"],
    enables: ["delivery"],
  },
];

// F13 · H47 — etiqueta para el hint de la tarjeta del wizard según el módulo de
// gastronomía que el preset activa. La RPC enciende dining/delivery + salón/zona;
// acá sólo decimos qué muestra la UI.
export const PRESET_ENABLE_LABELS: Record<PresetEnable, string> = {
  dining: "Incluye mesas y cocina (KDS)",
  delivery: "Incluye delivery",
};

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
