// Dataset ficticio del sandbox público (ADR-163, H68b). Un almacén de barrio
// inventado: nada de esto existe en la base ni sale de un negocio real. Es
// fijo (sin fechas relativas ni azar) para que el mismo pedido dé siempre la
// misma respuesta.

export const DEMO_BUSINESS = "Almacén Demo (datos ficticios)";

export type DemoProduct = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  price: number;
  cost: number | null;
  unit: string;
  is_active: boolean;
  track_stock: boolean;
  stock: number;
  stock_min: number | null;
  has_variants: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type DemoStore = { id: string; name: string; is_default: boolean; is_active: boolean };

export type DemoStockRow = {
  id: string;
  store_id: string;
  product_id: string;
  sku: string | null;
  qty: number;
  min_qty: number | null;
  updated_at: string;
};

export type DemoCustomer = {
  id: string;
  external_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  document_type: string | null;
  document_number: string | null;
  address: string | null;
  iva_condition: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type DemoSale = {
  id: string;
  number: number;
  status: "completed" | "voided";
  store_id: string;
  customer_id: string | null;
  subtotal: number;
  discount_total: number;
  tax_total: number;
  total: number;
  created_at: string;
  voided_at: string | null;
  items: {
    product_id: string | null;
    variant_id: string | null;
    sku: string | null;
    name: string;
    quantity: number;
    unit_price: number;
    discount: number;
    subtotal: number;
    returned_qty: number;
  }[];
  payments: { method: string; amount: number; reference: string | null }[];
};

export const DEMO_STORE_CENTRAL = "a1b2c3d4-0000-4000-8000-000000000001";
export const DEMO_STORE_NORTE = "a1b2c3d4-0000-4000-8000-000000000002";

export const DEMO_STORES: DemoStore[] = [
  { id: DEMO_STORE_CENTRAL, name: "Casa central", is_default: true, is_active: true },
  { id: DEMO_STORE_NORTE, name: "Sucursal Norte", is_default: false, is_active: true },
];

const P = (n: number) => `5b0c5e7e-3f6a-4f0e-9a51-${String(n).padStart(12, "0")}`;

// Los dos primeros SKU son los de los ejemplos del spec: con el cuerpo de
// ejemplo, el alta de productos da "updated" y "unchanged" de verdad.
export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    id: P(1),
    sku: "ALM-ARROZ-1KG",
    barcode: "7790070012345",
    name: "Arroz largo fino 1 kg",
    description: null,
    price: 1790,
    cost: 1150,
    unit: "un",
    is_active: true,
    track_stock: true,
    stock: 48,
    stock_min: 10,
    has_variants: false,
    created_at: "2026-09-01T12:00:00.000000+00:00",
    updated_at: "2026-10-01T09:00:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(2),
    sku: "ALM-FIDEOS-500",
    barcode: "7790070054321",
    name: "Fideos tirabuzón 500 g",
    description: null,
    price: 1350,
    cost: 820,
    unit: "un",
    is_active: true,
    track_stock: true,
    stock: 34,
    stock_min: 12,
    has_variants: false,
    created_at: "2026-09-01T12:00:00.000000+00:00",
    updated_at: "2026-10-02T10:30:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(3),
    sku: "ALM-YERBA-1KG",
    barcode: "7790070099991",
    name: "Yerba mate suave 1 kg",
    description: "Con palo, molienda tradicional.",
    price: 4200,
    cost: 2900,
    unit: "un",
    is_active: true,
    track_stock: true,
    stock: 20,
    stock_min: 6,
    has_variants: false,
    created_at: "2026-09-02T12:00:00.000000+00:00",
    updated_at: "2026-10-03T15:10:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(4),
    sku: "BEB-AGUA-2L",
    barcode: "7790070011112",
    name: "Agua mineral sin gas 2 l",
    description: null,
    price: 990,
    cost: 540,
    unit: "un",
    is_active: true,
    track_stock: true,
    stock: 72,
    stock_min: 24,
    has_variants: false,
    created_at: "2026-09-03T12:00:00.000000+00:00",
    updated_at: "2026-10-05T11:45:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(5),
    sku: "FIAM-QUESO-KG",
    barcode: null,
    name: "Queso cremoso (por kg)",
    description: "Se vende por peso.",
    price: 9800,
    cost: 6400,
    unit: "kg",
    is_active: true,
    track_stock: true,
    stock: 7.35,
    stock_min: 2,
    has_variants: false,
    created_at: "2026-09-04T12:00:00.000000+00:00",
    updated_at: "2026-10-08T08:20:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(6),
    sku: "REM-BASICA",
    barcode: null,
    name: "Remera básica algodón",
    description: "Talles S a XL, blanco y negro.",
    price: 12500,
    cost: 6900,
    unit: "un",
    is_active: true,
    track_stock: true,
    stock: 41,
    stock_min: null,
    has_variants: true,
    created_at: "2026-09-05T12:00:00.000000+00:00",
    updated_at: "2026-10-09T17:00:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(7),
    sku: "LIM-LAVAND-750",
    barcode: "7790070077771",
    name: "Lavandina 750 ml",
    description: null,
    price: 1150,
    cost: 610,
    unit: "un",
    is_active: false,
    track_stock: true,
    stock: 0,
    stock_min: 6,
    has_variants: false,
    created_at: "2026-09-06T12:00:00.000000+00:00",
    updated_at: "2026-10-11T13:00:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: P(8),
    sku: "GAL-OBLEA-90",
    barcode: "7790070088881",
    name: "Obleas rellenas 90 g (discontinuado)",
    description: null,
    price: 700,
    cost: 380,
    unit: "un",
    is_active: false,
    track_stock: true,
    stock: 0,
    stock_min: null,
    has_variants: false,
    created_at: "2026-09-07T12:00:00.000000+00:00",
    updated_at: "2026-10-12T09:00:00.000000+00:00",
    deleted_at: "2026-10-12T09:00:00.000000+00:00",
  },
];

const S = (n: number) => `e3b0c442-98fc-4c14-9afb-${String(n).padStart(12, "0")}`;

/** Stock por sucursal de los productos sin variantes y no dados de baja. */
export const DEMO_STOCK: DemoStockRow[] = [
  { id: S(1), store_id: DEMO_STORE_CENTRAL, product_id: P(1), sku: "ALM-ARROZ-1KG", qty: 30, min_qty: 6, updated_at: "2026-10-14T18:22:05.000000+00:00" },
  { id: S(2), store_id: DEMO_STORE_NORTE, product_id: P(1), sku: "ALM-ARROZ-1KG", qty: 18, min_qty: 4, updated_at: "2026-10-14T18:22:05.000000+00:00" },
  { id: S(3), store_id: DEMO_STORE_CENTRAL, product_id: P(2), sku: "ALM-FIDEOS-500", qty: 34, min_qty: 12, updated_at: "2026-10-13T10:00:00.000000+00:00" },
  { id: S(4), store_id: DEMO_STORE_CENTRAL, product_id: P(3), sku: "ALM-YERBA-1KG", qty: 12, min_qty: 4, updated_at: "2026-10-13T10:00:00.000000+00:00" },
  { id: S(5), store_id: DEMO_STORE_NORTE, product_id: P(3), sku: "ALM-YERBA-1KG", qty: 8, min_qty: 2, updated_at: "2026-10-13T10:00:00.000000+00:00" },
  { id: S(6), store_id: DEMO_STORE_CENTRAL, product_id: P(4), sku: "BEB-AGUA-2L", qty: 48, min_qty: 12, updated_at: "2026-10-12T16:40:00.000000+00:00" },
  { id: S(7), store_id: DEMO_STORE_NORTE, product_id: P(4), sku: "BEB-AGUA-2L", qty: 24, min_qty: 12, updated_at: "2026-10-12T16:40:00.000000+00:00" },
  { id: S(8), store_id: DEMO_STORE_CENTRAL, product_id: P(5), sku: "FIAM-QUESO-KG", qty: 7.35, min_qty: 2, updated_at: "2026-10-14T12:15:00.000000+00:00" },
  { id: S(9), store_id: DEMO_STORE_CENTRAL, product_id: P(7), sku: "LIM-LAVAND-750", qty: 0, min_qty: 6, updated_at: "2026-10-11T13:00:00.000000+00:00" },
];

const C = (n: number) => `0f9d2c1a-7b3e-4c55-8f0a-${String(n).padStart(12, "0")}`;

// Personas y empresas inventadas: CUIT y DNI de ejemplo, dominios .example.
export const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    id: C(1),
    external_id: "ERP-000123",
    name: "Distribuidora Sur SRL",
    email: "compras@distrisur.example",
    phone: "+54 11 0000-0001",
    document_type: "cuit",
    document_number: "30000000007",
    address: "Calle Falsa 123, Avellaneda",
    iva_condition: "responsable_inscripto",
    notes: null,
    is_active: true,
    created_at: "2026-08-10T15:00:00.000000+00:00",
    updated_at: "2026-10-04T09:30:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: C(2),
    external_id: "ERP-000124",
    name: "Ana Ejemplo",
    email: "ana@cliente.example",
    phone: null,
    document_type: "dni",
    document_number: "00000001",
    address: null,
    iva_condition: "consumidor_final",
    notes: "Prefiere retirar por la tarde.",
    is_active: true,
    created_at: "2026-08-12T15:00:00.000000+00:00",
    updated_at: "2026-10-06T14:00:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: C(3),
    external_id: null,
    name: "Kiosco La Prueba",
    email: null,
    phone: "+54 11 0000-0003",
    document_type: "cuit",
    document_number: "20000000001",
    address: "Pasaje Demo 45, Lanús",
    iva_condition: "monotributo",
    notes: null,
    is_active: true,
    created_at: "2026-08-20T15:00:00.000000+00:00",
    updated_at: "2026-10-10T10:10:00.000000+00:00",
    deleted_at: null,
  },
  {
    id: C(4),
    external_id: "ERP-000099",
    name: "Cliente dado de baja",
    email: null,
    phone: null,
    document_type: null,
    document_number: null,
    address: null,
    iva_condition: null,
    notes: null,
    is_active: false,
    created_at: "2026-07-01T15:00:00.000000+00:00",
    updated_at: "2026-10-11T11:00:00.000000+00:00",
    deleted_at: "2026-10-11T11:00:00.000000+00:00",
  },
];

const V = (n: number) => `3c2b1a09-8f7e-4d6c-b5a4-${String(n).padStart(12, "0")}`;

// Ventas entre el 1 y el 14 de octubre de 2026 (el rango del ejemplo del spec).
export const DEMO_SALES: DemoSale[] = [
  {
    id: V(1),
    number: 1530,
    status: "completed",
    store_id: DEMO_STORE_CENTRAL,
    customer_id: null,
    subtotal: 3580,
    discount_total: 0,
    tax_total: 621.32,
    total: 3580,
    created_at: "2026-10-02T13:15:00.000000+00:00",
    voided_at: null,
    items: [
      { product_id: P(1), variant_id: null, sku: "ALM-ARROZ-1KG", name: "Arroz largo fino 1 kg", quantity: 2, unit_price: 1790, discount: 0, subtotal: 3580, returned_qty: 0 },
    ],
    payments: [{ method: "cash", amount: 3580, reference: null }],
  },
  {
    id: V(2),
    number: 1531,
    status: "completed",
    store_id: DEMO_STORE_NORTE,
    customer_id: C(2),
    subtotal: 14540,
    discount_total: 727,
    tax_total: 2397.31,
    total: 13813,
    created_at: "2026-10-07T18:40:00.000000+00:00",
    voided_at: null,
    items: [
      { product_id: P(3), variant_id: null, sku: "ALM-YERBA-1KG", name: "Yerba mate suave 1 kg", quantity: 1, unit_price: 4200, discount: 210, subtotal: 3990, returned_qty: 0 },
      { product_id: P(5), variant_id: null, sku: "FIAM-QUESO-KG", name: "Queso cremoso (por kg)", quantity: 0.45, unit_price: 9800, discount: 0, subtotal: 4410, returned_qty: 0 },
      { product_id: P(4), variant_id: null, sku: "BEB-AGUA-2L", name: "Agua mineral sin gas 2 l", quantity: 6, unit_price: 990, discount: 517, subtotal: 5423, returned_qty: 1 },
    ],
    payments: [
      { method: "debit", amount: 10000, reference: "Lote 0042 cupón 1187" },
      { method: "cash", amount: 3813, reference: null },
    ],
  },
  {
    id: V(3),
    number: 1532,
    status: "voided",
    store_id: DEMO_STORE_CENTRAL,
    customer_id: null,
    subtotal: 1350,
    discount_total: 0,
    tax_total: 234.3,
    total: 1350,
    created_at: "2026-10-10T11:05:00.000000+00:00",
    voided_at: "2026-10-10T11:07:30.000000+00:00",
    items: [
      { product_id: P(2), variant_id: null, sku: "ALM-FIDEOS-500", name: "Fideos tirabuzón 500 g", quantity: 1, unit_price: 1350, discount: 0, subtotal: 1350, returned_qty: 0 },
    ],
    payments: [{ method: "qr", amount: 1350, reference: "QR-DEMO-0001" }],
  },
  {
    id: V(4),
    number: 1533,
    status: "completed",
    store_id: DEMO_STORE_CENTRAL,
    customer_id: C(1),
    subtotal: 25000,
    discount_total: 0,
    tax_total: 4338.84,
    total: 25000,
    created_at: "2026-10-14T19:05:11.000000+00:00",
    voided_at: null,
    items: [
      { product_id: P(6), variant_id: "9a8b7c6d-0000-4000-8000-000000000003", sku: "REM-BASICA-M-NEGRO", name: "Remera básica algodón (M, negro)", quantity: 2, unit_price: 12500, discount: 0, subtotal: 25000, returned_qty: 0 },
    ],
    payments: [{ method: "transfer", amount: 25000, reference: "Transferencia 000123" }],
  },
];

// ── Producto completo (include de GET /products, ADR-168) ──────────────────
// Lo que la API real arma desde categorías, marcas, imágenes, listas de
// precios, variantes y stock por sucursal. Las imágenes son URLs .example
// (no apuntan a nada real).

export type DemoPriceList = {
  id: string;
  name: string;
  channel: string;
  kind: string;
  /** Ajuste sobre el precio base (las listas derivadas del sandbox). */
  adjustment_pct: number;
  prices_include_tax: boolean;
  valid_from: string | null;
  valid_to: string | null;
};

export type DemoProductExtra = {
  attributes: { key: string; value: string }[];
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  tags: string[];
  model: string | null;
  season: string | null;
  net_content: number | null;
  net_content_unit: string | null;
  images: { id: string; url: string; path: string | null; position: number; is_primary: boolean }[];
};

export type DemoVariant = {
  id: string;
  product_id: string;
  sku: string;
  barcode: string | null;
  options: { axis: string; value: string }[];
  price: number;
  stock: number;
  updated_at: string;
  stock_by_store: { store_id: string; qty: number }[];
};

const L = (n: number) => `7c1e9a20-5d4b-4e8f-b2a6-${String(n).padStart(12, "0")}`;
const CAT = (n: number) => `3d8f0b6c-1a2e-4b7d-9c3f-${String(n).padStart(12, "0")}`;
const BR = (n: number) => `9a4b2c1d-6e7f-4a8b-8c9d-${String(n).padStart(12, "0")}`;
const IMG = (n: number) => `b5e6f7a8-2c3d-4e5f-a6b7-${String(n).padStart(12, "0")}`;
const VAR = (n: number) => `d2c3b4a5-8e9f-4a1b-9c2d-${String(n).padStart(12, "0")}`;

export const DEMO_PRICE_LISTS: DemoPriceList[] = [
  { id: L(1), name: "Mayorista", channel: "mostrador", kind: "derived", adjustment_pct: -10, prices_include_tax: true, valid_from: null, valid_to: null },
  { id: L(2), name: "Tienda online", channel: "online", kind: "derived", adjustment_pct: 5, prices_include_tax: true, valid_from: "2026-10-01T03:00:00.000000+00:00", valid_to: null },
];

const img = (n: number, file: string, position: number) => ({
  id: IMG(n),
  url: `https://images.example/almacen-demo/${file}.webp`,
  path: null,
  position,
  is_primary: position === 0,
});
const extra = (e: Partial<DemoProductExtra>): DemoProductExtra => ({
  attributes: [],
  category: null,
  brand: null,
  tags: [],
  model: null,
  season: null,
  net_content: null,
  net_content_unit: null,
  images: [],
  ...e,
});
const ALMACEN = { id: CAT(1), name: "Almacén" };

export const DEMO_PRODUCT_EXTRAS: Record<string, DemoProductExtra> = {
  [P(1)]: extra({ attributes: [{ key: "Contenido", value: "1 kg" }, { key: "Tipo", value: "Largo fino" }], category: ALMACEN, brand: { id: BR(1), name: "Granos del Sur" }, tags: ["sin TACC"], net_content: 1, net_content_unit: "kg", images: [img(1, "arroz-1kg", 0), img(2, "arroz-1kg-dorso", 1)] }),
  [P(2)]: extra({ attributes: [{ key: "Contenido", value: "500 g" }], category: ALMACEN, brand: { id: BR(2), name: "Pastas Demo" }, net_content: 500, net_content_unit: "g", images: [img(3, "fideos-500", 0)] }),
  [P(3)]: extra({ attributes: [{ key: "Contenido", value: "1 kg" }, { key: "Origen", value: "Misiones" }], category: ALMACEN, brand: { id: BR(3), name: "Yerbatera Demo" }, net_content: 1, net_content_unit: "kg", images: [img(4, "yerba-1kg", 0)] }),
  [P(4)]: extra({ attributes: [{ key: "Contenido", value: "2 l" }], category: { id: CAT(2), name: "Bebidas" }, net_content: 2, net_content_unit: "l" }),
  [P(5)]: extra({ attributes: [{ key: "Origen", value: "Córdoba" }], category: { id: CAT(3), name: "Fiambrería" }, tags: ["por peso"] }),
  [P(6)]: extra({ attributes: [{ key: "Material", value: "Algodón 100%" }], category: { id: CAT(4), name: "Indumentaria" }, brand: { id: BR(4), name: "Básicos Demo" }, model: "Clásica", season: "Primavera 2026", images: [img(5, "remera-blanca", 0), img(6, "remera-negra", 1)] }),
  [P(7)]: extra({ category: { id: CAT(5), name: "Limpieza" }, net_content: 750, net_content_unit: "ml" }),
};

export const DEMO_VARIANTS: DemoVariant[] = [
  { id: VAR(1), product_id: P(6), sku: "REM-BASICA-S-BLA", barcode: "7790070066611", options: [{ axis: "Talle", value: "S" }, { axis: "Color", value: "Blanco" }], price: 12500, stock: 9, updated_at: "2026-10-09T17:00:00.000000+00:00", stock_by_store: [{ store_id: DEMO_STORE_CENTRAL, qty: 6 }, { store_id: DEMO_STORE_NORTE, qty: 3 }] },
  { id: VAR(2), product_id: P(6), sku: "REM-BASICA-M-BLA", barcode: "7790070066612", options: [{ axis: "Talle", value: "M" }, { axis: "Color", value: "Blanco" }], price: 12500, stock: 14, updated_at: "2026-10-09T17:00:00.000000+00:00", stock_by_store: [{ store_id: DEMO_STORE_CENTRAL, qty: 10 }, { store_id: DEMO_STORE_NORTE, qty: 4 }] },
  { id: VAR(3), product_id: P(6), sku: "REM-BASICA-M-NEG", barcode: "7790070066613", options: [{ axis: "Talle", value: "M" }, { axis: "Color", value: "Negro" }], price: 12500, stock: 11, updated_at: "2026-10-09T17:00:00.000000+00:00", stock_by_store: [{ store_id: DEMO_STORE_CENTRAL, qty: 11 }] },
  { id: VAR(4), product_id: P(6), sku: "REM-BASICA-XL-NEG", barcode: null, options: [{ axis: "Talle", value: "XL" }, { axis: "Color", value: "Negro" }], price: 13900, stock: 7, updated_at: "2026-10-09T17:00:00.000000+00:00", stock_by_store: [{ store_id: DEMO_STORE_CENTRAL, qty: 5 }, { store_id: DEMO_STORE_NORTE, qty: 2 }] },
];
