// =============================================================================
// Fuente de verdad de la documentación de la API pública v1 (ADR-094,
// portal ADR-159). De acá salen:
//   * el portal de Configuración › Integraciones › API (components/integrations/api),
//   * el OpenAPI 3.1 de /api/openapi.json (lib/api/openapi.ts),
//   * la colección de Postman v2.1 (lib/api/postman.ts),
//   * los ejemplos curl / JavaScript / Python (lib/api/snippets.ts).
//
// Sólo endpoints que EXISTEN en app/api/v1. tests/unit/apiPortal.test.ts
// falla si un endpoint de acá no tiene ruta, si una ruta no está acá o si los
// campos se separan de los esquemas Zod de lib/api-publica/schemas.ts.
// =============================================================================

import { API_SCOPES, SCOPE_INFO, type ApiScope } from "@/lib/api-publica/scopes";
import {
  DOCUMENT_TYPES,
  IVA_CONDITIONS,
  MAX_BATCH,
  MAX_BODY_BYTES,
  MAX_LIMIT_WITH_INCLUDE,
  MAX_PRODUCT_IDS,
  PRODUCT_INCLUDES,
  MAX_SALES_RANGE_DAYS,
  STOCK_REASONS,
} from "@/lib/api-publica/schemas";

export type HttpMethod = "GET" | "POST";
export type FieldType = "string" | "integer" | "number" | "boolean" | "array" | "object";

export interface FieldSpec {
  name: string;
  type: FieldType;
  description: string;
  required?: boolean;
  nullable?: boolean;
  format?: "uuid" | "date-time";
  enum?: readonly string[];
  /** Tipo de los elementos cuando type = array. */
  items?: Exclude<FieldType, "array" | "object">;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  example?: unknown;
  /** Propiedades de un objeto, o de cada elemento si type = array. */
  fields?: FieldSpec[];
}

export interface ParamSpec extends FieldSpec {
  in: "query" | "header";
}

export type ResourceId = "auth" | "products" | "prices" | "stores" | "stock" | "sales" | "customers";

export interface ResourceSpec {
  id: ResourceId;
  title: string;
  description: string;
}

export interface ItemErrorSpec {
  code: string;
  description: string;
}

export interface EndpointSpec {
  /** Id estable (anclas del portal, operationId de OpenAPI). */
  id: string;
  resource: ResourceId;
  method: HttpMethod;
  /** Ruta relativa a la base /api/v1. */
  path: string;
  title: string;
  description: string;
  /** Alcance que exige; null en el token. */
  scope: ApiScope | null;
  auth: "client_credentials" | "bearer";
  params: ParamSpec[];
  body?: {
    contentType: "application/json" | "application/x-www-form-urlencoded";
    description: string;
    /** Lote {items: [...]}: campos de cada ítem. */
    itemFields?: FieldSpec[];
    /** Cuerpo plano (token). */
    fields?: FieldSpec[];
    example: Record<string, unknown>;
  };
  response: {
    status: number;
    description: string;
    example: unknown;
    /** Forma del cuerpo: token, página con cursor, {data} o resultado de lote. */
    shape: "token" | "page" | "data" | "batch";
    /** Modelo de cada elemento (page / data / batch) o del cuerpo (token). */
    model: ModelId;
    /** Claves de summary en un lote. */
    summary?: readonly string[];
  };
  /** Códigos del catálogo de errores (ERRORS) que puede devolver. */
  errors: string[];
  /** Errores por ítem dentro de results[] (el pedido responde 200). */
  itemErrors?: ItemErrorSpec[];
  /** Qué pasa con una credencial de prueba. */
  sandbox: string;
  notes?: string[];
}

export type ModelId = "Token" | "Product" | "Store" | "StockRow" | "Sale" | "Customer" | "BatchResult";

export interface ModelSpec {
  id: ModelId;
  title: string;
  fields: FieldSpec[];
}

export interface ErrorSpec {
  code: string;
  status: number;
  description: string;
}

export const API_TITLE = "API pública de NinjaSoft POS";
export const API_VERSION = "v1";
export const API_BASE_PATH = "/api/v1";
export const OPENAPI_PATH = "/api/openapi.json";
export const TOKEN_TTL_SECONDS = 3600;
export const MAX_ACTIVE_CLIENTS = 10;
export const IDEMPOTENCY_TTL_HOURS = 24;
export const RATE_LIMIT = { min: 10, max: 10_000, default: 600 } as const;

export const API_DESCRIPTION =
  "API REST para conectar una tienda online, un ERP o una planilla con un negocio de NinjaSoft POS: productos, precios, sucursales, stock por sucursal, ventas (sólo lectura) y clientes. " +
  "Autenticación OAuth2 client_credentials con permisos por alcance. Cada credencial pertenece a un negocio: lo que se lee y escribe es siempre de ese negocio.";

// ── Recursos ────────────────────────────────────────────────────────────────
export const RESOURCES: ResourceSpec[] = [
  {
    id: "auth",
    title: "Autenticación",
    description:
      "Cambiá tu client_id y client_secret por un token Bearer de 1 hora. El token se manda en cada pedido en el header Authorization.",
  },
  {
    id: "products",
    title: "Productos",
    description:
      "Catálogo por SKU: alta y edición en lote, lectura paginada por fecha de modificación para sincronizar. Productos sin variantes; el stock que devuelve es el consolidado.",
  },
  {
    id: "prices",
    title: "Precios",
    description: "Cambio de precio de venta y costo en lote por SKU, sin tocar el resto de la ficha.",
  },
  {
    id: "stores",
    title: "Sucursales",
    description: "Sucursales del negocio, para elegir dónde leer o ajustar stock.",
  },
  {
    id: "stock",
    title: "Stock",
    description: "Stock por sucursal: lectura y ajustes o conteos con motivo. Cada ajuste deja su movimiento y su auditoría.",
  },
  {
    id: "sales",
    title: "Ventas",
    description: `Ventas por rango de fechas con ítems y cobros. Sólo lectura: la API no crea ni anula ventas. Rango máximo ${MAX_SALES_RANGE_DAYS} días.`,
  },
  {
    id: "customers",
    title: "Clientes",
    description:
      "Clientes con datos de contacto y fiscales. Alta y edición en lote por id de NinjaSoft o por tu propio id (external_id).",
  },
];

// ── Errores ─────────────────────────────────────────────────────────────────
export const ERRORS: ErrorSpec[] = [
  { code: "invalid_request", status: 400, description: "Pedido de token mal armado (falta grant_type o el cuerpo no se puede leer)." },
  { code: "unsupported_grant_type", status: 400, description: "grant_type distinto de client_credentials." },
  { code: "invalid_scope", status: 400, description: "Se pidió un alcance que la credencial no tiene." },
  { code: "invalid_json", status: 400, description: "El cuerpo no es JSON válido." },
  { code: "invalid_cursor", status: 400, description: "El cursor no es uno devuelto por la API." },
  { code: "invalid_idempotency_key", status: 400, description: "Idempotency-Key fuera de formato: de 8 a 128 caracteres (letras, números, . _ : -)." },
  { code: "invalid_client", status: 401, description: "client_id o client_secret incorrectos, o credencial revocada." },
  { code: "invalid_token", status: 401, description: "Falta el token, venció (dura 1 hora) o fue revocado. Pedí uno nuevo." },
  { code: "insufficient_scope", status: 403, description: "El token no tiene el alcance que pide el endpoint." },
  { code: "feature_not_in_plan", status: 403, description: "El plan del negocio no incluye la API pública (Enterprise)." },
  { code: "tenant_inactive", status: 403, description: "El negocio está suspendido o dado de baja." },
  { code: "not_found", status: 404, description: "La ruta no existe." },
  { code: "store_not_found", status: 404, description: "La sucursal no existe en el negocio." },
  { code: "method_not_allowed", status: 405, description: "Método HTTP no soportado en esa ruta." },
  { code: "conflict", status: 409, description: "Otro pedido modificó los mismos datos al mismo tiempo. Reintentá." },
  { code: "idempotency_conflict", status: 409, description: "La Idempotency-Key ya se usó con otro cuerpo u otro endpoint." },
  { code: "idempotency_in_progress", status: 409, description: "Hay un pedido con esa Idempotency-Key todavía en curso." },
  { code: "payload_too_large", status: 413, description: `El cuerpo supera ${MAX_BODY_BYTES.toLocaleString("es-AR")} bytes.` },
  { code: "unsupported_media_type", status: 415, description: "Content-Type tiene que ser application/json." },
  { code: "validation_error", status: 422, description: "Datos inválidos. details trae el campo (path) y el motivo." },
  { code: "rate_limited", status: 429, description: "Pasaste el límite de pedidos por minuto de la credencial. Esperá lo que indica Retry-After." },
  { code: "internal_error", status: 500, description: "Error interno. Reintentá más tarde." },
  { code: "unavailable", status: 503, description: "Servicio no disponible momentáneamente. Reintentá con espera." },
];

const AUTH_ERRORS = ["invalid_token", "insufficient_scope", "feature_not_in_plan", "tenant_inactive", "rate_limited", "unavailable"];
const WRITE_ERRORS = [
  ...AUTH_ERRORS,
  "invalid_json",
  "invalid_idempotency_key",
  "idempotency_conflict",
  "idempotency_in_progress",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "validation_error",
];

// ── Parámetros y campos reutilizados ────────────────────────────────────────
const P_LIMIT = (def: number, max: number): ParamSpec => ({
  name: "limit",
  in: "query",
  type: "integer",
  minimum: 1,
  maximum: max,
  default: def,
  description: `Cantidad por página (1 a ${max}, por defecto ${def}).`,
  example: def,
});
const P_CURSOR: ParamSpec = {
  name: "cursor",
  in: "query",
  type: "string",
  maxLength: 512,
  description: "next_cursor de la página anterior, tal cual. Sin cursor arranca desde el principio.",
};
const P_UPDATED_SINCE: ParamSpec = {
  name: "updated_since",
  in: "query",
  type: "string",
  format: "date-time",
  description: "Sólo lo modificado desde esta fecha (ISO 8601 con zona). Útil para sincronizar incrementalmente.",
  example: "2026-10-01T00:00:00-03:00",
};
const P_INCLUDE_DELETED: ParamSpec = {
  name: "include_deleted",
  in: "query",
  type: "boolean",
  default: false,
  description: "Incluir los dados de baja (vienen con deleted_at). Sirve para replicar bajas.",
};
const H_IDEMPOTENCY: ParamSpec = {
  name: "Idempotency-Key",
  in: "header",
  type: "string",
  minLength: 8,
  maxLength: 128,
  description: `Opcional. Si reintentás el mismo pedido con la misma clave dentro de ${IDEMPOTENCY_TTL_HOURS} horas, la API devuelve la respuesta guardada (header Idempotent-Replayed: true) y no vuelve a escribir.`,
  example: "sync-2026-10-15-0001",
};

const BATCH_NOTE = `Hasta ${MAX_BATCH} ítems por pedido. El pedido responde 200 aunque algún ítem falle: revisá results[].status y results[].error.`;
const DRY_RUN =
  "Con una credencial de prueba se valida y se ejecuta todo, pero se deshace antes de responder: nada se guarda y la respuesta trae dry_run: true. Los id de altas son simulados.";
const READ_ONLY_SANDBOX =
  "Con una credencial de prueba lee los datos reales del negocio, sólo lectura y con los mismos alcances.";

const PRODUCT_EXAMPLE = {
  id: "5b0c5e7e-3f6a-4f0e-9a51-2d1f0f6b8c11",
  sku: "ALM-ARROZ-1KG",
  barcode: "7790070012345",
  name: "Arroz largo fino 1 kg",
  description: null,
  price: 1890,
  cost: 1200,
  unit: "un",
  is_active: true,
  track_stock: true,
  stock: 48,
  stock_min: 10,
  has_variants: false,
  created_at: "2026-09-01T12:00:00.000000+00:00",
  updated_at: "2026-10-14T18:22:05.123456+00:00",
  deleted_at: null,
};

// Producto con include=attributes,images,price_lists,variants,stock (ADR-168).
const PRODUCT_FULL_EXAMPLE = {
  ...PRODUCT_EXAMPLE,
  attributes: [{ key: "Contenido", value: "1 kg" }],
  category: { id: "3d8f0b6c-1a2e-4b7d-9c3f-000000000001", name: "Almacén" },
  brand: { id: "9a4b2c1d-6e7f-4a8b-8c9d-000000000001", name: "Granos del Sur" },
  tags: ["sin TACC"],
  model: null,
  season: null,
  net_content: 1,
  net_content_unit: "kg",
  images: [
    {
      id: "b5e6f7a8-2c3d-4e5f-a6b7-000000000001",
      url: "https://images.example/almacen-demo/arroz-1kg.webp",
      path: null,
      position: 0,
      is_primary: true,
    },
  ],
  price_lists: [
    {
      id: "7c1e9a20-5d4b-4e8f-b2a6-000000000001",
      name: "Mayorista",
      channel: "mostrador",
      kind: "derived",
      price: 1701,
      prices_include_tax: true,
      valid_from: null,
      valid_to: null,
    },
  ],
  variants: [],
  stock_by_store: [
    { store_id: "a1b2c3d4-0000-4000-8000-000000000001", store_code: "CEN", store_name: "Casa central", qty: 30, min_qty: 6, max_qty: null, location: null },
    { store_id: "a1b2c3d4-0000-4000-8000-000000000002", store_code: "NOR", store_name: "Sucursal Norte", qty: 18, min_qty: 4, max_qty: null, location: null },
  ],
};

const CUSTOMER_EXAMPLE = {
  id: "0f9d2c1a-7b3e-4c55-8f0a-9e1d2c3b4a50",
  external_id: "ERP-000123",
  name: "Distribuidora Sur SRL",
  email: "compras@distrisur.com.ar",
  phone: "+54 11 4555-0000",
  document_type: "cuit",
  document_number: "30712345678",
  address: "Av. Mitre 1234, Avellaneda",
  iva_condition: "responsable_inscripto",
  notes: null,
  is_active: true,
  created_at: "2026-08-10T15:00:00.000000+00:00",
  updated_at: "2026-10-12T09:30:00.000000+00:00",
  deleted_at: null,
};

const STORE_ID = "a1b2c3d4-0000-4000-8000-000000000001";

// ── Modelos de respuesta ────────────────────────────────────────────────────
const TS = (name: string, description: string, nullable = false): FieldSpec => ({
  name,
  type: "string",
  format: "date-time",
  nullable,
  description,
});
const ID = (name: string, description: string, nullable = false): FieldSpec => ({
  name,
  type: "string",
  format: "uuid",
  nullable,
  description,
});

export const MODELS: Record<ModelId, ModelSpec> = {
  Token: {
    id: "Token",
    title: "Token",
    fields: [
      { name: "access_token", type: "string", description: "Token opaco (nsat_ o nsat_test_). Mandalo como Bearer." },
      { name: "token_type", type: "string", enum: ["Bearer"], description: "Siempre Bearer." },
      { name: "expires_in", type: "integer", description: "Segundos de vida (3600)." },
      { name: "scope", type: "string", description: "Alcances del token separados por espacio." },
      { name: "environment", type: "string", enum: ["live", "test"], description: "live = producción; test = sandbox." },
    ],
  },
  Product: {
    id: "Product",
    title: "Producto",
    fields: [
      ID("id", "Id del producto."),
      { name: "sku", type: "string", nullable: true, description: "Código interno." },
      { name: "barcode", type: "string", nullable: true, description: "Código de barras." },
      { name: "name", type: "string", description: "Nombre." },
      { name: "description", type: "string", nullable: true, description: "Descripción." },
      { name: "price", type: "number", description: "Precio de venta final." },
      { name: "cost", type: "number", nullable: true, description: "Costo unitario." },
      { name: "unit", type: "string", description: "Unidad de medida." },
      { name: "is_active", type: "boolean", description: "Si se vende." },
      { name: "track_stock", type: "boolean", description: "Si controla stock." },
      { name: "stock", type: "number", description: "Stock consolidado de todas las sucursales." },
      { name: "stock_min", type: "number", nullable: true, description: "Stock mínimo." },
      { name: "has_variants", type: "boolean", description: "Si tiene variantes (talle, color...)." },
      TS("created_at", "Alta."),
      TS("updated_at", "Última modificación (orden de la lista)."),
      TS("deleted_at", "Baja lógica (sólo con include_deleted).", true),
      // Sólo vienen si se piden con include (ADR-168).
      {
        name: "attributes",
        type: "array",
        description: "Con include=attributes. Atributos libres en orden (Contenido, Color, Talle...).",
        fields: [
          { name: "key", type: "string", description: "Nombre del atributo." },
          { name: "value", type: "string", description: "Valor." },
        ],
      },
      {
        name: "category",
        type: "object",
        nullable: true,
        description: "Con include=attributes. Categoría del producto.",
        fields: [ID("id", "Id de la categoría."), { name: "name", type: "string", description: "Nombre." }],
      },
      {
        name: "brand",
        type: "object",
        nullable: true,
        description: "Con include=attributes. Marca del producto.",
        fields: [ID("id", "Id de la marca."), { name: "name", type: "string", description: "Nombre." }],
      },
      { name: "tags", type: "array", items: "string", description: "Con include=attributes. Etiquetas." },
      { name: "model", type: "string", nullable: true, description: "Con include=attributes. Modelo." },
      { name: "season", type: "string", nullable: true, description: "Con include=attributes. Temporada." },
      { name: "net_content", type: "number", nullable: true, description: "Con include=attributes. Contenido neto (500, 1...)." },
      { name: "net_content_unit", type: "string", nullable: true, description: "Con include=attributes. Unidad del contenido neto (g, kg, ml, l...)." },
      {
        name: "images",
        type: "array",
        description: "Con include=images. Imágenes en orden, la principal primero. url es pública.",
        fields: [
          ID("id", "Id de la imagen (null en imágenes cargadas antes de la galería).", true),
          { name: "url", type: "string", description: "URL pública de la imagen." },
          { name: "path", type: "string", nullable: true, description: "Ruta dentro del almacenamiento de NinjaSoft." },
          { name: "position", type: "integer", description: "Orden (0 = primera)." },
          { name: "is_primary", type: "boolean", description: "Si es la imagen principal." },
        ],
      },
      {
        name: "price_lists",
        type: "array",
        description:
          "Con include=price_lists. Precio en cada lista vigente, resuelto con el mismo motor que el punto de venta (lista fija, derivada, sobre costo o en moneda, con su redondeo).",
        fields: [
          ID("id", "Id de la lista."),
          { name: "name", type: "string", description: "Nombre de la lista." },
          { name: "channel", type: "string", nullable: true, description: "Canal (mostrador, online, mayorista...)." },
          { name: "kind", type: "string", nullable: true, description: "Tipo de lista (fixed, derived, cost, currency)." },
          { name: "price", type: "number", nullable: true, description: "Precio unitario final en pesos en esa lista." },
          { name: "prices_include_tax", type: "boolean", nullable: true, description: "Si los precios de la lista incluyen IVA." },
          TS("valid_from", "Desde cuándo rige la lista.", true),
          TS("valid_to", "Hasta cuándo rige la lista.", true),
        ],
      },
      {
        name: "variants",
        type: "array",
        description: "Con include=variants. Variantes activas (talle, color...).",
        fields: [
          ID("id", "Id de la variante."),
          { name: "sku", type: "string", nullable: true, description: "SKU de la variante." },
          { name: "barcode", type: "string", nullable: true, description: "Código de barras de la variante." },
          {
            name: "options",
            type: "array",
            description: "Valor de cada eje, en orden.",
            fields: [
              { name: "axis", type: "string", nullable: true, description: "Eje (Talle, Color...)." },
              { name: "value", type: "string", description: "Valor (M, Rojo...)." },
            ],
          },
          { name: "price", type: "number", description: "Precio de la variante (el del producto si no tiene uno propio)." },
          { name: "stock", type: "number", description: "Stock consolidado de la variante." },
          TS("updated_at", "Última modificación de la variante."),
          {
            name: "stock_by_store",
            type: "array",
            description: "Sólo con include=variants,stock. Stock de la variante por sucursal.",
            fields: [
              ID("store_id", "Id de la sucursal."),
              { name: "store_code", type: "string", nullable: true, description: "Código de la sucursal." },
              { name: "qty", type: "number", description: "Cantidad." },
            ],
          },
        ],
      },
      {
        name: "stock_by_store",
        type: "array",
        description: "Con include=stock. Stock del producto por sucursal (el total sigue en stock).",
        fields: [
          ID("store_id", "Id de la sucursal."),
          { name: "store_code", type: "string", nullable: true, description: "Código de la sucursal." },
          { name: "store_name", type: "string", description: "Nombre de la sucursal." },
          { name: "qty", type: "number", description: "Cantidad." },
          { name: "min_qty", type: "number", nullable: true, description: "Mínimo de la sucursal." },
          { name: "max_qty", type: "number", nullable: true, description: "Máximo de la sucursal." },
          { name: "location", type: "string", nullable: true, description: "Ubicación en el depósito." },
        ],
      },
    ],
  },
  Store: {
    id: "Store",
    title: "Sucursal",
    fields: [
      ID("id", "Id de la sucursal."),
      { name: "name", type: "string", description: "Nombre." },
      { name: "is_default", type: "boolean", description: "Si es la predeterminada." },
      { name: "is_active", type: "boolean", description: "Si está activa." },
    ],
  },
  StockRow: {
    id: "StockRow",
    title: "Stock en una sucursal",
    fields: [
      ID("id", "Id de la fila (orden del cursor)."),
      ID("store_id", "Sucursal."),
      ID("product_id", "Producto."),
      { name: "sku", type: "string", nullable: true, description: "SKU del producto." },
      { name: "qty", type: "number", description: "Cantidad en esa sucursal." },
      { name: "min_qty", type: "number", nullable: true, description: "Mínimo en esa sucursal." },
      TS("updated_at", "Última modificación."),
    ],
  },
  Sale: {
    id: "Sale",
    title: "Venta",
    fields: [
      ID("id", "Id de la venta."),
      { name: "number", type: "integer", description: "Número de venta del negocio." },
      { name: "status", type: "string", description: "completed o voided (anulada)." },
      ID("store_id", "Sucursal."),
      ID("customer_id", "Cliente, si se eligió.", true),
      { name: "subtotal", type: "number", description: "Subtotal." },
      { name: "discount_total", type: "number", description: "Descuentos." },
      { name: "tax_total", type: "number", description: "Impuestos incluidos." },
      { name: "total", type: "number", description: "Total." },
      TS("created_at", "Fecha de la venta."),
      TS("voided_at", "Fecha de anulación.", true),
      {
        name: "items",
        type: "array",
        description: "Renglones.",
        fields: [
          ID("product_id", "Producto.", true),
          ID("variant_id", "Variante.", true),
          { name: "sku", type: "string", nullable: true, description: "SKU al momento de vender." },
          { name: "name", type: "string", description: "Nombre al momento de vender." },
          { name: "quantity", type: "number", description: "Cantidad." },
          { name: "unit_price", type: "number", description: "Precio unitario." },
          { name: "discount", type: "number", description: "Descuento del renglón." },
          { name: "subtotal", type: "number", description: "Subtotal del renglón." },
          { name: "returned_qty", type: "number", description: "Cantidad devuelta." },
        ],
      },
      {
        name: "payments",
        type: "array",
        description: "Cobros.",
        fields: [
          { name: "method", type: "string", description: "cash, debit, credit, transfer, qr, account..." },
          { name: "amount", type: "number", description: "Importe." },
          { name: "reference", type: "string", nullable: true, description: "Referencia del cobro." },
        ],
      },
    ],
  },
  Customer: {
    id: "Customer",
    title: "Cliente",
    fields: [
      ID("id", "Id del cliente."),
      { name: "external_id", type: "string", nullable: true, description: "Tu id." },
      { name: "name", type: "string", description: "Nombre o razón social." },
      { name: "email", type: "string", nullable: true, description: "Email." },
      { name: "phone", type: "string", nullable: true, description: "Teléfono." },
      { name: "document_type", type: "string", nullable: true, description: "Tipo de documento." },
      { name: "document_number", type: "string", nullable: true, description: "Número de documento." },
      { name: "address", type: "string", nullable: true, description: "Domicilio." },
      { name: "iva_condition", type: "string", nullable: true, description: "Condición frente al IVA." },
      { name: "notes", type: "string", nullable: true, description: "Notas internas." },
      { name: "is_active", type: "boolean", description: "Si está activo." },
      TS("created_at", "Alta."),
      TS("updated_at", "Última modificación (orden de la lista)."),
      TS("deleted_at", "Baja lógica (sólo con include_deleted).", true),
    ],
  },
  BatchResult: {
    id: "BatchResult",
    title: "Resultado de un ítem del lote",
    fields: [
      { name: "index", type: "integer", description: "Posición del ítem en items[] (desde 0)." },
      { name: "sku", type: "string", description: "SKU del ítem (productos, precios y stock)." },
      { name: "external_id", type: "string", description: "external_id del ítem (clientes)." },
      ID("id", "Id del registro. En sandbox, simulado."),
      {
        name: "status",
        type: "string",
        enum: ["created", "updated", "unchanged", "adjusted", "error"],
        description: "Qué pasó con el ítem.",
      },
      { name: "error", type: "string", description: "Código del error del ítem (ver Errores por ítem)." },
      ID("store_id", "Sucursal (stock)."),
      { name: "qty", type: "number", description: "Cantidad final (stock)." },
      { name: "delta", type: "number", description: "Diferencia aplicada (stock)." },
    ],
  },
};

// ── Endpoints ───────────────────────────────────────────────────────────────
export const ENDPOINTS: EndpointSpec[] = [
  {
    id: "oauth.token",
    resource: "auth",
    method: "POST",
    path: "/oauth/token",
    title: "Obtener un token",
    description:
      "OAuth2 client_credentials (RFC 6749 §4.4). Mandá el client_id y el client_secret por Basic auth o en el cuerpo. Devuelve un token Bearer que dura 1 hora; pedí uno nuevo cuando venza (no hay refresh token).",
    scope: null,
    auth: "client_credentials",
    params: [],
    body: {
      contentType: "application/x-www-form-urlencoded",
      description: "También acepta JSON con los mismos campos.",
      fields: [
        { name: "grant_type", type: "string", enum: ["client_credentials"], required: true, description: "Siempre client_credentials." },
        { name: "client_id", type: "string", maxLength: 64, description: "Si no usás Basic auth.", example: "nsc_test_0123456789abcdef01234567" },
        { name: "client_secret", type: "string", maxLength: 128, description: "Si no usás Basic auth." },
        {
          name: "scope",
          type: "string",
          maxLength: 400,
          description: "Opcional: alcances separados por espacio para un token más acotado. Sin scope, el token lleva todos los de la credencial.",
          example: "products:read stock:read",
        },
      ],
      example: { grant_type: "client_credentials", client_id: "{{client_id}}", client_secret: "{{client_secret}}" },
    },
    response: {
      status: 200,
      shape: "token",
      model: "Token",
      description: "Token emitido.",
      example: {
        access_token: "nsat_test_9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
        scope: "products:read products:write",
        environment: "test",
      },
    },
    errors: ["invalid_request", "unsupported_grant_type", "invalid_client", "invalid_scope", "feature_not_in_plan", "tenant_inactive", "rate_limited"],
    sandbox: "Una credencial de prueba (nsc_test_) devuelve un token nsat_test_ y environment: test.",
    notes: ["Los errores de este endpoint siguen el formato de OAuth: {error, error_description}."],
  },
  {
    id: "products.list",
    resource: "products",
    method: "GET",
    path: "/products",
    title: "Listar productos",
    description:
      "Productos ordenados por fecha de modificación. Para sincronizar: guardá la fecha de tu última corrida, pedí con updated_since y seguí next_cursor hasta que venga null.",
    scope: "products:read",
    auth: "bearer",
    params: [
      P_LIMIT(100, 500),
      P_CURSOR,
      P_UPDATED_SINCE,
      { name: "sku", in: "query", type: "string", minLength: 1, maxLength: 64, description: "Filtra por un SKU exacto.", example: "ALM-ARROZ-1KG" },
      {
        name: "ids",
        in: "query",
        type: "string",
        maxLength: 4000,
        description: `Ids de producto separados por coma (hasta ${MAX_PRODUCT_IDS}). Sirve para leer uno o varios productos puntuales.`,
      },
      {
        name: "include",
        in: "query",
        type: "string",
        maxLength: 200,
        description: `Datos extra separados por coma: ${PRODUCT_INCLUDES.join(", ")}. Sin include la respuesta es la de siempre. Con include, limit va hasta ${MAX_LIMIT_WITH_INCLUDE}.`,
        example: PRODUCT_INCLUDES.join(","),
      },
      P_INCLUDE_DELETED,
    ],
    response: {
      status: 200,
      shape: "page",
      model: "Product",
      description: "Página de productos. El ejemplo es con include de todo; sin include vienen sólo los campos básicos.",
      example: { data: [PRODUCT_FULL_EXAMPLE], next_cursor: null },
    },
    errors: [...AUTH_ERRORS, "invalid_cursor", "validation_error"],
    sandbox: READ_ONLY_SANDBOX,
    notes: [
      "include=price_lists resuelve el precio de cada lista con el mismo motor que el punto de venta: es el precio que cobraría la caja con esa lista.",
      "Las imágenes son URLs públicas: se pueden mostrar directo en una tienda online.",
      "Para traer un producto puntual con todo: ids=<id>&include=attributes,images,price_lists,variants,stock.",
    ],
  },
  {
    id: "products.batch",
    resource: "products",
    method: "POST",
    path: "/products/batch",
    title: "Crear y editar productos en lote",
    description:
      "Alta y edición por SKU. Si el SKU no existe se crea (name es obligatorio); si existe, se actualizan sólo los campos que mandás. Un campo ausente no se toca.",
    scope: "products:write",
    auth: "bearer",
    params: [H_IDEMPOTENCY],
    body: {
      contentType: "application/json",
      description: BATCH_NOTE,
      itemFields: [
        { name: "sku", type: "string", required: true, minLength: 1, maxLength: 64, description: "Código interno. Identifica el producto.", example: "ALM-ARROZ-1KG" },
        { name: "name", type: "string", minLength: 1, maxLength: 200, description: "Nombre. Obligatorio en un alta.", example: "Arroz largo fino 1 kg" },
        { name: "barcode", type: "string", nullable: true, maxLength: 64, description: "Código de barras. Único en el negocio.", example: "7790070012345" },
        { name: "description", type: "string", nullable: true, maxLength: 2000, description: "Descripción libre." },
        { name: "price", type: "number", minimum: 0, description: "Precio de venta final. En un alta, 0 si no viene.", example: 1890 },
        { name: "cost", type: "number", nullable: true, minimum: 0, description: "Costo unitario.", example: 1200 },
        { name: "unit", type: "string", minLength: 1, maxLength: 10, description: "Unidad de medida (un, kg, lt, m...). En un alta, un.", example: "un" },
        { name: "is_active", type: "boolean", description: "Si se vende. En un alta, true." },
        { name: "track_stock", type: "boolean", description: "Si controla stock. En un alta, true." },
        { name: "stock_min", type: "number", nullable: true, minimum: 0, description: "Stock mínimo para alertas.", example: 10 },
      ],
      example: {
        items: [
          { sku: "ALM-ARROZ-1KG", name: "Arroz largo fino 1 kg", barcode: "7790070012345", price: 1890, cost: 1200, stock_min: 10 },
          { sku: "ALM-FIDEOS-500", price: 1350 },
        ],
      },
    },
    response: {
      status: 200,
      shape: "batch",
      model: "BatchResult",
      summary: ["created", "updated", "unchanged", "failed"],
      description: "Resultado por ítem en el mismo orden.",
      example: {
        summary: { created: 1, updated: 1, unchanged: 0, failed: 0 },
        results: [
          { index: 0, sku: "ALM-ARROZ-1KG", id: PRODUCT_EXAMPLE.id, status: "created" },
          { index: 1, sku: "ALM-FIDEOS-500", id: "7c1e0b9a-2d4f-4b8e-a6c3-5f9e8d7c6b5a", status: "updated" },
        ],
      },
    },
    errors: WRITE_ERRORS,
    itemErrors: [
      { code: "name_required", description: "El SKU no existe y el ítem no trae name para darlo de alta." },
      { code: "barcode_in_use", description: "El código de barras ya lo tiene otro producto del negocio." },
    ],
    sandbox: DRY_RUN,
    notes: ["SKU y códigos de barras repetidos dentro del mismo lote dan 422."],
  },
  {
    id: "prices.batch",
    resource: "prices",
    method: "POST",
    path: "/prices/batch",
    title: "Cambiar precios en lote",
    description: "Precio de venta y, opcional, costo por SKU. Sólo productos existentes.",
    scope: "prices:write",
    auth: "bearer",
    params: [H_IDEMPOTENCY],
    body: {
      contentType: "application/json",
      description: BATCH_NOTE,
      itemFields: [
        { name: "sku", type: "string", required: true, minLength: 1, maxLength: 64, description: "SKU del producto.", example: "ALM-ARROZ-1KG" },
        { name: "price", type: "number", required: true, minimum: 0, description: "Precio de venta final.", example: 1990 },
        { name: "cost", type: "number", nullable: true, minimum: 0, description: "Costo unitario (opcional).", example: 1250 },
      ],
      example: { items: [{ sku: "ALM-ARROZ-1KG", price: 1990, cost: 1250 }] },
    },
    response: {
      status: 200,
      shape: "batch",
      model: "BatchResult",
      summary: ["updated", "unchanged", "failed"],
      description: "Resultado por ítem.",
      example: {
        summary: { updated: 1, unchanged: 0, failed: 0 },
        results: [{ index: 0, sku: "ALM-ARROZ-1KG", id: PRODUCT_EXAMPLE.id, status: "updated" }],
      },
    },
    errors: WRITE_ERRORS,
    itemErrors: [{ code: "product_not_found", description: "No hay un producto activo con ese SKU." }],
    sandbox: DRY_RUN,
  },
  {
    id: "stores.list",
    resource: "stores",
    method: "GET",
    path: "/stores",
    title: "Listar sucursales",
    description: "Sucursales activas e inactivas del negocio (sin las dadas de baja). La predeterminada viene primero.",
    scope: "stock:read",
    auth: "bearer",
    params: [],
    response: {
      status: 200,
      shape: "data",
      model: "Store",
      description: "Sucursales.",
      example: { data: [{ id: STORE_ID, name: "Casa central", is_default: true, is_active: true }] },
    },
    errors: AUTH_ERRORS,
    sandbox: READ_ONLY_SANDBOX,
  },
  {
    id: "stock.list",
    resource: "stock",
    method: "GET",
    path: "/stock",
    title: "Consultar stock por sucursal",
    description: "Stock de productos sin variantes por sucursal. Un producto sin fila en una sucursal tiene 0 ahí.",
    scope: "stock:read",
    auth: "bearer",
    params: [
      { name: "store_id", in: "query", type: "string", format: "uuid", description: "Sólo esa sucursal.", example: STORE_ID },
      {
        name: "sku",
        in: "query",
        type: "string",
        description: `Uno o varios SKU separados por coma (hasta ${MAX_BATCH}).`,
        example: "ALM-ARROZ-1KG,ALM-FIDEOS-500",
      },
      P_LIMIT(200, 500),
      P_CURSOR,
    ],
    response: {
      status: 200,
      shape: "page",
      model: "StockRow",
      description: "Página de stock.",
      example: {
        data: [
          {
            id: "e3b0c442-98fc-4c14-9afb-f4c8996fb924",
            store_id: STORE_ID,
            product_id: PRODUCT_EXAMPLE.id,
            sku: "ALM-ARROZ-1KG",
            qty: 48,
            min_qty: 10,
            updated_at: "2026-10-14T18:22:05.123456+00:00",
          },
        ],
        next_cursor: null,
      },
    },
    errors: [...AUTH_ERRORS, "invalid_cursor", "store_not_found", "validation_error"],
    sandbox: READ_ONLY_SANDBOX,
  },
  {
    id: "stock.adjustments",
    resource: "stock",
    method: "POST",
    path: "/stock/adjustments",
    title: "Ajustar stock",
    description:
      "Suma o resta (mode delta) o fija la cantidad contada (mode set) en una sucursal, con motivo. Sin store_id usa la sucursal predeterminada. Cada ajuste deja un movimiento de stock y su auditoría.",
    scope: "stock:write",
    auth: "bearer",
    params: [H_IDEMPOTENCY],
    body: {
      contentType: "application/json",
      description: BATCH_NOTE,
      itemFields: [
        { name: "sku", type: "string", required: true, minLength: 1, maxLength: 64, description: "SKU del producto (sin variantes).", example: "ALM-ARROZ-1KG" },
        { name: "store_id", type: "string", format: "uuid", nullable: true, description: "Sucursal. Sin dato, la predeterminada.", example: STORE_ID },
        { name: "mode", type: "string", enum: ["delta", "set"], default: "delta", description: "delta suma o resta qty; set deja el stock en qty (se registra como conteo)." },
        { name: "qty", type: "number", required: true, description: "Cantidad. En delta distinta de 0; en set mayor o igual a 0.", example: 12 },
        { name: "reason", type: "string", required: true, enum: STOCK_REASONS, description: "Motivo del ajuste.", example: "purchase" },
        { name: "notes", type: "string", nullable: true, maxLength: 300, description: "Nota para la auditoría." },
      ],
      example: {
        items: [
          { sku: "ALM-ARROZ-1KG", store_id: STORE_ID, mode: "delta", qty: 12, reason: "purchase", notes: "Remito 0001-00004567" },
          { sku: "ALM-FIDEOS-500", mode: "set", qty: 30, reason: "count" },
        ],
      },
    },
    response: {
      status: 200,
      shape: "batch",
      model: "BatchResult",
      summary: ["adjusted", "unchanged", "failed"],
      description: "Resultado por ítem con la cantidad final.",
      example: {
        summary: { adjusted: 2, unchanged: 0, failed: 0 },
        results: [
          { index: 0, sku: "ALM-ARROZ-1KG", id: PRODUCT_EXAMPLE.id, store_id: STORE_ID, status: "adjusted", qty: 60, delta: 12 },
          { index: 1, sku: "ALM-FIDEOS-500", id: "7c1e0b9a-2d4f-4b8e-a6c3-5f9e8d7c6b5a", store_id: STORE_ID, status: "adjusted", qty: 30, delta: -4 },
        ],
      },
    },
    errors: WRITE_ERRORS,
    itemErrors: [
      { code: "product_not_found", description: "No hay un producto activo con ese SKU." },
      { code: "variants_not_supported", description: "El producto tiene variantes: su stock no se ajusta por esta API." },
      { code: "store_not_found", description: "La sucursal no existe en el negocio." },
      { code: "feature_not_in_plan", description: "Ajuste en una sucursal que no es la predeterminada sin stock por sucursal en el plan." },
    ],
    sandbox: DRY_RUN,
  },
  {
    id: "sales.list",
    resource: "sales",
    method: "GET",
    path: "/sales",
    title: "Listar ventas",
    description: `Ventas creadas en el rango [from, to) con sus ítems y cobros, de la más vieja a la más nueva. Rango máximo ${MAX_SALES_RANGE_DAYS} días. No incluye ventas suspendidas.`,
    scope: "sales:read",
    auth: "bearer",
    params: [
      { name: "from", in: "query", type: "string", format: "date-time", required: true, description: "Desde (incluido), ISO 8601 con zona.", example: "2026-10-01T00:00:00-03:00" },
      { name: "to", in: "query", type: "string", format: "date-time", required: true, description: "Hasta (excluido), ISO 8601 con zona.", example: "2026-10-15T00:00:00-03:00" },
      { name: "store_id", in: "query", type: "string", format: "uuid", description: "Sólo esa sucursal." },
      P_LIMIT(50, 200),
      P_CURSOR,
    ],
    response: {
      status: 200,
      shape: "page",
      model: "Sale",
      description: "Página de ventas.",
      example: {
        data: [
          {
            id: "3c2b1a09-8f7e-4d6c-b5a4-938271605f4e",
            number: 1532,
            status: "completed",
            store_id: STORE_ID,
            customer_id: null,
            subtotal: 3780,
            discount_total: 0,
            tax_total: 656.03,
            total: 3780,
            created_at: "2026-10-14T19:05:11.000000+00:00",
            voided_at: null,
            items: [
              {
                product_id: PRODUCT_EXAMPLE.id,
                variant_id: null,
                sku: "ALM-ARROZ-1KG",
                name: "Arroz largo fino 1 kg",
                quantity: 2,
                unit_price: 1890,
                discount: 0,
                subtotal: 3780,
                returned_qty: 0,
              },
            ],
            payments: [{ method: "cash", amount: 3780, reference: null }],
          },
        ],
        next_cursor: null,
      },
    },
    errors: [...AUTH_ERRORS, "invalid_cursor", "store_not_found", "validation_error"],
    sandbox: READ_ONLY_SANDBOX,
  },
  {
    id: "customers.list",
    resource: "customers",
    method: "GET",
    path: "/customers",
    title: "Listar clientes",
    description: "Clientes ordenados por fecha de modificación, con el mismo esquema de sincronización que productos.",
    scope: "customers:read",
    auth: "bearer",
    params: [
      P_LIMIT(100, 500),
      P_CURSOR,
      P_UPDATED_SINCE,
      { name: "external_id", in: "query", type: "string", minLength: 1, maxLength: 100, description: "Filtra por tu id externo.", example: "ERP-000123" },
      P_INCLUDE_DELETED,
    ],
    response: {
      status: 200,
      shape: "page",
      model: "Customer",
      description: "Página de clientes.",
      example: { data: [CUSTOMER_EXAMPLE], next_cursor: null },
    },
    errors: [...AUTH_ERRORS, "invalid_cursor", "validation_error"],
    sandbox: READ_ONLY_SANDBOX,
  },
  {
    id: "customers.batch",
    resource: "customers",
    method: "POST",
    path: "/customers/batch",
    title: "Crear y editar clientes en lote",
    description:
      "Alta y edición por id de NinjaSoft o por external_id (tu id). Con id edita ese cliente; con external_id lo crea si no existe (name obligatorio) o lo edita. Un campo ausente no se toca.",
    scope: "customers:write",
    auth: "bearer",
    params: [H_IDEMPOTENCY],
    body: {
      contentType: "application/json",
      description: BATCH_NOTE + " Cada ítem necesita id o external_id.",
      itemFields: [
        { name: "id", type: "string", format: "uuid", description: "Id de NinjaSoft (para editar)." },
        { name: "external_id", type: "string", minLength: 1, maxLength: 100, description: "Tu id. Único en el negocio.", example: "ERP-000123" },
        { name: "name", type: "string", minLength: 1, maxLength: 200, description: "Nombre o razón social. Obligatorio en un alta.", example: "Distribuidora Sur SRL" },
        { name: "email", type: "string", nullable: true, maxLength: 200, description: "Email." },
        { name: "phone", type: "string", nullable: true, maxLength: 50, description: "Teléfono." },
        { name: "document_type", type: "string", nullable: true, enum: DOCUMENT_TYPES, description: "Tipo de documento.", example: "cuit" },
        { name: "document_number", type: "string", nullable: true, maxLength: 20, description: "Número sin guiones.", example: "30712345678" },
        { name: "address", type: "string", nullable: true, maxLength: 300, description: "Domicilio." },
        { name: "iva_condition", type: "string", nullable: true, enum: IVA_CONDITIONS, description: "Condición frente al IVA.", example: "responsable_inscripto" },
        { name: "notes", type: "string", nullable: true, maxLength: 1000, description: "Notas internas." },
        { name: "is_active", type: "boolean", description: "Si está activo." },
      ],
      example: {
        items: [
          {
            external_id: "ERP-000123",
            name: "Distribuidora Sur SRL",
            email: "compras@distrisur.com.ar",
            document_type: "cuit",
            document_number: "30712345678",
            iva_condition: "responsable_inscripto",
          },
        ],
      },
    },
    response: {
      status: 200,
      shape: "batch",
      model: "BatchResult",
      summary: ["created", "updated", "unchanged", "failed"],
      description: "Resultado por ítem.",
      example: {
        summary: { created: 1, updated: 0, unchanged: 0, failed: 0 },
        results: [{ index: 0, external_id: "ERP-000123", id: CUSTOMER_EXAMPLE.id, status: "created" }],
      },
    },
    errors: WRITE_ERRORS,
    itemErrors: [
      { code: "customer_not_found", description: "Vino un id que no es de un cliente del negocio." },
      { code: "external_id_in_use", description: "El external_id ya lo tiene otro cliente distinto del id enviado." },
      { code: "name_required", description: "Es un alta y no trae name." },
    ],
    sandbox: DRY_RUN,
  },
];

// ── Guías (secciones de texto del portal) ───────────────────────────────────
export const RATE_LIMIT_DOC = {
  summary: `Cada credencial tiene su límite de pedidos por minuto (de ${RATE_LIMIT.min} a ${RATE_LIMIT.max.toLocaleString("es-AR")}, por defecto ${RATE_LIMIT.default}), que elige el dueño al crearla. Cuenta todo, incluido el pedido de token.`,
  headers: [
    { name: "RateLimit-Limit", description: "Pedidos por minuto de la credencial." },
    { name: "RateLimit-Remaining", description: "Cuántos te quedan en la ventana." },
    { name: "RateLimit-Reset", description: "Segundos hasta que se libera la ventana." },
    { name: "Retry-After", description: "Sólo en 429: segundos a esperar antes de reintentar." },
  ],
  limits: [
    `Hasta ${MAX_BATCH} ítems por lote y ${MAX_BODY_BYTES.toLocaleString("es-AR")} bytes por cuerpo.`,
    `Ventas: rango máximo de ${MAX_SALES_RANGE_DAYS} días por consulta.`,
    `Token: dura ${TOKEN_TTL_SECONDS / 60} minutos.`,
    `Hasta ${MAX_ACTIVE_CLIENTS} credenciales activas por negocio (producción y prueba juntas).`,
    `Idempotency-Key: se recuerda ${IDEMPOTENCY_TTL_HOURS} horas por credencial.`,
  ],
};

export const SANDBOX_DOC = {
  summary:
    "Las credenciales de prueba sirven para desarrollar y probar sin tocar el negocio. Se crean igual que las de producción eligiendo el ambiente Prueba y se reconocen por el prefijo: client_id nsc_test_, secreto nss_test_ y token nsat_test_.",
  rules: [
    "Escrituras (productos, precios, stock y clientes): se validan y se ejecutan de verdad dentro de la base y se deshacen antes de responder. La respuesta es la misma que en producción, con dry_run: true. No queda nada: ni productos, ni stock, ni movimientos, ni auditoría del lote.",
    "Los id de las altas que devuelve una prueba son simulados: no existen después.",
    "Lecturas: datos reales del negocio, sólo lectura, con los alcances que elegiste para la credencial.",
    "Nunca factura en ARCA, no cobra, no publica en Mercado Libre ni sincroniza el catálogo: la API no expone esas operaciones y lo que encolaría una escritura también se deshace.",
    "Idempotency-Key no se guarda en prueba: repetir la clave vuelve a simular el pedido.",
    "Mismo plan (Enterprise), mismo límite por minuto y mismos errores que producción. Las respuestas llevan el header X-Ninja-Environment: test.",
  ],
};

export const AUTH_DOC = {
  steps: [
    "Creá una credencial en Credenciales con los permisos que necesita la integración. El secreto se muestra una sola vez.",
    "Pedí un token a POST /api/v1/oauth/token con grant_type=client_credentials.",
    "Mandá el token en cada pedido: Authorization: Bearer <token>.",
    "Cuando venza (1 hora) o recibas 401 invalid_token, pedí otro.",
  ],
  security: [
    "Guardá el client_secret en el servidor de la integración (gestor de secretos o variable de entorno), nunca en el navegador, una app móvil ni un repositorio.",
    "Si un secreto se filtra, rotalo o revocá la credencial: los tokens emitidos dejan de servir en el acto.",
    "El negocio sale de la credencial: ningún parámetro elige el negocio y un id de otro negocio simplemente no existe.",
  ],
};

export const RESPONSE_FORMAT_DOC = {
  errorExample: {
    error: {
      code: "validation_error",
      message: "Datos inválidos.",
      details: [{ path: "items.0.price", message: "Number must be greater than or equal to 0" }],
    },
  },
  headers: [
    { name: "X-Request-Id", description: "Id del pedido. Pasalo si escribís a soporte." },
    { name: "X-Api-Version", description: "Versión de la API (v1)." },
    { name: "X-Ninja-Environment", description: "live o test según la credencial del token." },
  ],
};

// ── Utilidades ──────────────────────────────────────────────────────────────
export function endpointsOf(resource: ResourceId): EndpointSpec[] {
  return ENDPOINTS.filter((e) => e.resource === resource);
}

export function findEndpoint(id: string): EndpointSpec | undefined {
  return ENDPOINTS.find((e) => e.id === id);
}

export function errorSpec(code: string): ErrorSpec | undefined {
  return ERRORS.find((e) => e.code === code);
}

/** Alcances con su texto, en el orden de la API. */
export function scopeList(): { scope: ApiScope; label: string; desc: string }[] {
  return API_SCOPES.map((s) => ({ scope: s, ...SCOPE_INFO[s] }));
}
