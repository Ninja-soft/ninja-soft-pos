// F13 · H47 — Catálogo de modificadores gastronómicos predefinidos.
//
// Los grupos de modificadores (H37) se arman a mano por producto. En gastronomía
// los mismos grupos se repiten en decenas de productos (punto de cocción de cada
// corte, tipo de leche de cada café, sabores de cada helado). Este catálogo
// ofrece PRESETS listos para insertar en el editor de un producto con un toque:
// el preset clona un grupo + sus opciones (con un precio sugerido editable) en el
// producto, y el dueño lo ajusta y guarda con el flujo normal.
//
// Es 100% CLIENTE: no hay tabla ni API nueva. El preset se materializa como un
// grupo más en `product_modifier_groups`/`options` al guardar el producto (mismo
// camino que "Agregar grupo"). Los precios son SUGERENCIAS en ARS; el dueño los
// edita. Cubre el checkbox de H47: punto de cocción, guarnición, salsa, leche,
// tamaño, sabor, topping, sin TACC / sin sal, extras.

export interface ModifierPresetOption {
  name: string;
  // Ajuste de precio sugerido (ARS). Omitido = 0. Editable tras insertar.
  price_delta?: number;
}

export interface ModifierPresetGroup {
  name: string;
  required: boolean;
  min_select: number;
  // null = sin tope (multi libre).
  max_select: number | null;
  options: ModifierPresetOption[];
}

export interface ModifierPreset {
  key: string;
  // Etiqueta en el selector de presets.
  label: string;
  // Pista corta del rubro/uso.
  hint: string;
  group: ModifierPresetGroup;
}

// Catálogo curado. Orden pensado para el flujo de un restaurante/cafetería/
// heladería de mostrador. Todos parten de valores razonables y editables.
export const MODIFIER_PRESETS: ModifierPreset[] = [
  {
    key: "coccion",
    label: "Punto de cocción",
    hint: "Carnes a la parrilla",
    group: {
      name: "Punto de cocción",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { name: "Jugoso" },
        { name: "A punto" },
        { name: "Cocido" },
        { name: "Bien cocido" },
      ],
    },
  },
  {
    key: "guarnicion",
    label: "Guarnición",
    hint: "Platos principales",
    group: {
      name: "Guarnición",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { name: "Papas fritas" },
        { name: "Puré" },
        { name: "Ensalada" },
        { name: "Arroz" },
        { name: "Verduras salteadas" },
      ],
    },
  },
  {
    key: "salsa",
    label: "Salsa",
    hint: "Carnes / pastas (elegí hasta 2)",
    group: {
      name: "Salsa",
      required: false,
      min_select: 0,
      max_select: 2,
      options: [
        { name: "Criolla" },
        { name: "Chimichurri" },
        { name: "Provenzal" },
        { name: "Mostaza" },
        { name: "Roquefort", price_delta: 800 },
      ],
    },
  },
  {
    key: "leche",
    label: "Tipo de leche",
    hint: "Cafetería",
    group: {
      name: "Tipo de leche",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { name: "Entera" },
        { name: "Descremada" },
        { name: "Almendras", price_delta: 600 },
        { name: "Soja", price_delta: 600 },
        { name: "Sin lactosa", price_delta: 500 },
      ],
    },
  },
  {
    key: "temperatura",
    label: "Temperatura",
    hint: "Café / infusiones",
    group: {
      name: "Temperatura",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [{ name: "Caliente" }, { name: "Tibio" }, { name: "Frío" }],
    },
  },
  {
    key: "tamano_cafe",
    label: "Tamaño (café)",
    hint: "Cafetería",
    group: {
      name: "Tamaño",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { name: "Chico" },
        { name: "Mediano", price_delta: 400 },
        { name: "Grande", price_delta: 800 },
      ],
    },
  },
  {
    key: "tamano_helado",
    label: "Tamaño (helado)",
    hint: "Heladería",
    group: {
      name: "Tamaño",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [
        { name: "1/4 kg" },
        { name: "1/2 kg", price_delta: 2500 },
        { name: "1 kg", price_delta: 6000 },
      ],
    },
  },
  {
    key: "sabores",
    label: "Sabores",
    hint: "Heladería (hasta 3) — editá la lista",
    group: {
      name: "Sabores",
      required: true,
      min_select: 1,
      max_select: 3,
      options: [
        { name: "Vainilla" },
        { name: "Chocolate" },
        { name: "Dulce de leche" },
        { name: "Frutilla" },
        { name: "Limón" },
      ],
    },
  },
  {
    key: "toppings",
    label: "Toppings",
    hint: "Helados / postres",
    group: {
      name: "Toppings",
      required: false,
      min_select: 0,
      max_select: null,
      options: [
        { name: "Granas" },
        { name: "Dulce de leche" },
        { name: "Crema" },
        { name: "Maní" },
        { name: "Frutas", price_delta: 500 },
        { name: "Salsa de chocolate", price_delta: 500 },
      ],
    },
  },
  {
    key: "restricciones",
    label: "Restricciones",
    hint: "Sin TACC / sin sal / sin azúcar",
    group: {
      name: "Restricciones",
      required: false,
      min_select: 0,
      max_select: null,
      options: [
        { name: "Sin TACC" },
        { name: "Sin sal" },
        { name: "Sin azúcar" },
        { name: "Sin gluten" },
        { name: "Sin lactosa" },
      ],
    },
  },
  {
    key: "extras",
    label: "Extras",
    hint: "Hamburguesas / sándwiches (con +precio)",
    group: {
      name: "Extras",
      required: false,
      min_select: 0,
      max_select: null,
      options: [
        { name: "Extra queso", price_delta: 700 },
        { name: "Doble carne", price_delta: 1800 },
        { name: "Huevo", price_delta: 600 },
        { name: "Bacon", price_delta: 900 },
        { name: "Cheddar", price_delta: 700 },
      ],
    },
  },
  {
    key: "para_llevar",
    label: "Para llevar / en local",
    hint: "Mostrador",
    group: {
      name: "Para llevar",
      required: true,
      min_select: 1,
      max_select: 1,
      options: [{ name: "En local" }, { name: "Para llevar" }],
    },
  },
];

export function findModifierPreset(key: string): ModifierPreset | undefined {
  return MODIFIER_PRESETS.find((p) => p.key === key);
}
