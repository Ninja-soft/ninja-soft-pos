// =============================================================================
// Asistente IA · consulta genérica de SOLO LECTURA (`ai_query`) y su catálogo.
//
// Lógica pura compartida por la Edge `ai_assistant` (Deno) y Vitest (Node,
// tests/unit/aiQuery.test.ts). Sin imports.
//
// El modelo NO escribe SQL: arma un pedido JSON (entidad, columnas, filtros,
// agrupación, agregados, orden, límite). Este módulo:
//   1. define el CATÁLOGO (whitelist) de entidades y columnas que el asistente
//      puede leer, con su descripción en español (tool `ai_schema`);
//   2. valida y normaliza el pedido contra el catálogo (`validateQuery`) para
//      devolverle al modelo un error claro antes de tocar la base.
//
// La barrera real está en SQL: la función `ai_query(p_spec jsonb)` (SECURITY
// INVOKER, corre con el JWT del usuario → RLS aplica) RE-VALIDA cada
// identificador contra la copia SQL del catálogo (`ai__query_catalog()`, que se
// genera de `catalogForSql()` y un test verifica que no diverjan), fuerza
// `tenant_id = current_tenant_id()` y sólo interpola identificadores
// whitelisteados con quote_ident y valores con quote_literal.
//
// Fuera del catálogo a propósito (nunca se exponen): payment_secrets,
// platform_secrets, tenant_email_smtp, system_email_smtp, email_providers,
// mp_oauth_states, mp_webhook_events, audit_logs, users (emails de auth),
// invite_codes, cashier_profiles.pin_hash, tenant_payment_methods.config,
// payments.metadata / card_voucher, store_credit_vouchers.code (es un crédito
// al portador) y toda columna jsonb interna (metadata, settings, limits).
// =============================================================================

export type ColType =
  | "text"
  | "uuid"
  | "numeric"
  | "int"
  | "bool"
  | "timestamptz"
  | "date";

export type ColDef = { t: ColType; d: string };

/** Relación a otra entidad: `<ref>.<columna>` hace un LEFT JOIN. */
export type RefDef = {
  /** Columna local (o de `via`) que apunta a la entidad destino. */
  col: string;
  /** Entidad destino (debe existir en el catálogo). */
  to: string;
  /** Columna destino del join (default `id`). */
  target?: string;
  /** Ref base de esta entidad desde la que sale el join (un nivel más). */
  via?: string;
  d: string;
};

export type EntityDef = {
  /** Descripción en español para el modelo. */
  d: string;
  cols: Record<string, ColDef>;
  refs?: Record<string, RefDef>;
  /** Tiene `deleted_at`: se excluyen siempre las filas dadas de baja. */
  soft?: boolean;
  /** Sólo se puede usar como destino de una ref (no como entidad raíz). */
  refOnly?: boolean;
  /** Catálogo global (sin tenant_id): el join no filtra por tenant. */
  global?: boolean;
  /** Columnas por defecto cuando no se pide `select`. */
  def?: string[];
};

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;
export const MAX_SELECT = 25;
export const MAX_FILTERS = 12;
export const MAX_GROUP_BY = 2;
export const MAX_AGGREGATES = 6;
export const MAX_ORDER_BY = 3;
export const MAX_IN_VALUES = 50;
export const MAX_VALUE_LENGTH = 200;

export const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "ilike",
  "in",
  "between",
  "is_null",
  "not_null",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGG_OPS = [
  "count",
  "count_distinct",
  "sum",
  "avg",
  "min",
  "max",
] as const;
export type AggOp = (typeof AGG_OPS)[number];

export const TRUNCS = ["day", "week", "month", "year"] as const;
export type Trunc = (typeof TRUNCS)[number];

// Atajos para declarar columnas.
const c = (t: ColType, d: string): ColDef => ({ t, d });
const id = c("uuid", "Identificador");
const created = c("timestamptz", "Fecha de alta (hora Argentina)");
const updated = c("timestamptz", "Última modificación");
const active = c("bool", "Activo");

// ── Catálogo (whitelist) ─────────────────────────────────────────────────────
export const AI_QUERY_CATALOG: Record<string, EntityDef> = {
  products: {
    d: "Productos y servicios del catálogo.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      sku: c("text", "SKU / código interno"),
      barcode: c("text", "Código de barras"),
      plu: c("text", "PLU (balanza)"),
      description: c("text", "Descripción"),
      price: c("numeric", "Precio de venta"),
      cost: c("numeric", "Costo"),
      stock: c("numeric", "Stock actual"),
      stock_min: c("numeric", "Stock mínimo"),
      unit: c("text", "Unidad de medida"),
      is_active: active,
      track_stock: c("bool", "Controla stock"),
      is_kit: c("bool", "Es combo/kit"),
      has_variants: c("bool", "Tiene variantes (talle/color)"),
      is_serialized: c("bool", "Lleva número de serie"),
      tax_rate: c("numeric", "Alícuota de IVA %"),
      season: c("text", "Temporada"),
      warranty_months: c("int", "Meses de garantía"),
      is_favorite: c("bool", "Favorito en el POS"),
      commission_pct: c("numeric", "Comisión % (servicios)"),
      service_duration_min: c("int", "Duración del servicio en minutos"),
      station: c("text", "Estación de cocina (KDS)"),
      category_id: c("uuid", "Categoría"),
      brand_id: c("uuid", "Marca"),
      created_at: created,
      updated_at: updated,
    },
    refs: {
      category: { col: "category_id", to: "categories", d: "Categoría del producto" },
      brand: { col: "brand_id", to: "brands", d: "Marca del producto" },
    },
    def: ["name", "sku", "price", "cost", "stock", "stock_min", "is_active", "category.name"],
  },
  categories: {
    d: "Categorías de productos.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      parent_id: c("uuid", "Categoría padre"),
      is_active: active,
      sort_order: c("int", "Orden"),
      created_at: created,
    },
    refs: {
      parent: { col: "parent_id", to: "categories", d: "Categoría padre" },
    },
  },
  brands: {
    d: "Marcas de productos.",
    soft: true,
    cols: { id, name: c("text", "Nombre"), created_at: created },
  },
  product_variants: {
    d: "Variantes de producto (talle, color, etc.) con su stock.",
    soft: true,
    cols: {
      id,
      product_id: c("uuid", "Producto"),
      option1: c("text", "Opción 1 (ej. talle)"),
      option2: c("text", "Opción 2 (ej. color)"),
      sku: c("text", "SKU"),
      barcode: c("text", "Código de barras"),
      price_override: c("numeric", "Precio propio de la variante"),
      stock: c("numeric", "Stock"),
      created_at: created,
    },
    refs: { product: { col: "product_id", to: "products", d: "Producto" } },
  },
  stock_movements: {
    d: "Movimientos de stock (ventas, ajustes, ingresos, mermas, devoluciones).",
    cols: {
      id,
      product_id: c("uuid", "Producto"),
      variant_id: c("uuid", "Variante"),
      store_id: c("uuid", "Sucursal"),
      delta: c("numeric", "Cantidad (+ entra, − sale)"),
      reason: c("text", "Motivo: purchase (compra/ingreso), sale, sale_void, adjustment, transfer, loss (merma), return"),
      loss_reason: c("text", "Motivo de merma"),
      notes: c("text", "Notas"),
      created_by: c("uuid", "Usuario"),
      created_at: created,
    },
    refs: {
      product: { col: "product_id", to: "products", d: "Producto" },
      store: { col: "store_id", to: "stores", d: "Sucursal" },
      user: { col: "created_by", to: "tenant_users", target: "user_id", d: "Usuario que lo registró" },
    },
  },
  price_lists: {
    d: "Listas de precios.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      channel: c("text", "Canal"),
      adjustment_pct: c("numeric", "Ajuste % sobre el precio base"),
      is_active: active,
      created_at: created,
    },
  },
  price_list_items: {
    d: "Precios especiales de productos dentro de una lista de precios.",
    cols: {
      id,
      price_list_id: c("uuid", "Lista de precios"),
      product_id: c("uuid", "Producto"),
      variant_id: c("uuid", "Variante"),
      price: c("numeric", "Precio en la lista"),
      updated_at: updated,
    },
    refs: {
      price_list: { col: "price_list_id", to: "price_lists", d: "Lista de precios" },
      product: { col: "product_id", to: "products", d: "Producto" },
    },
  },
  customers: {
    d: "Clientes.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      document_type: c("text", "Tipo de documento"),
      document_number: c("text", "Número de documento / CUIT"),
      iva_condition: c("text", "Condición frente al IVA"),
      email: c("text", "Email"),
      phone: c("text", "Teléfono"),
      address: c("text", "Dirección"),
      notes: c("text", "Notas"),
      is_active: active,
      group_id: c("uuid", "Grupo de clientes"),
      credit_limit: c("numeric", "Límite de crédito en cuenta corriente"),
      birth_date: c("date", "Fecha de nacimiento"),
      created_at: created,
    },
    refs: { group: { col: "group_id", to: "customer_groups", d: "Grupo del cliente" } },
    def: ["name", "document_number", "phone", "email", "group.name", "created_at"],
  },
  customer_groups: {
    d: "Grupos de clientes.",
    cols: {
      id,
      name: c("text", "Nombre"),
      is_active: active,
      sort: c("int", "Orden"),
      created_at: created,
    },
  },
  customer_account_movements: {
    d: "Movimientos de cuenta corriente de clientes (delta > 0 = deuda; < 0 = pago). Saldo = suma de delta.",
    cols: {
      id,
      customer_id: c("uuid", "Cliente"),
      sale_id: c("uuid", "Venta"),
      delta: c("numeric", "Importe (+ deuda, − pago)"),
      reason: c("text", "Motivo"),
      due_date: c("date", "Vencimiento"),
      created_at: created,
    },
    refs: {
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
      sale: { col: "sale_id", to: "sales", d: "Venta" },
    },
  },
  store_credit_movements: {
    d: "Movimientos de saldo a favor (crédito en tienda) de clientes. Saldo = suma de delta.",
    cols: {
      id,
      customer_id: c("uuid", "Cliente"),
      delta: c("numeric", "Importe (+ suma, − consume)"),
      reason: c("text", "Motivo"),
      created_at: created,
    },
    refs: { customer: { col: "customer_id", to: "customers", d: "Cliente" } },
  },
  store_credit_vouchers: {
    d: "Vales de crédito emitidos por devoluciones (sin el código del vale).",
    cols: {
      id,
      amount: c("numeric", "Monto"),
      customer_id: c("uuid", "Cliente"),
      status: c("text", "Estado: active | redeemed | void"),
      expires_at: c("timestamptz", "Vence"),
      redeemed_at: c("timestamptz", "Usado el"),
      created_at: created,
    },
    refs: { customer: { col: "customer_id", to: "customers", d: "Cliente" } },
  },
  sales: {
    d: "Ventas (tickets). status: completed (válida), voided (anulada) o suspended (en espera). Para lo vendido usá status = completed.",
    cols: {
      id,
      number: c("int", "Número de venta"),
      status: c("text", "Estado: completed | voided | suspended"),
      subtotal: c("numeric", "Subtotal"),
      discount_total: c("numeric", "Descuentos"),
      tax_total: c("numeric", "Impuestos"),
      total: c("numeric", "Total cobrado"),
      tip_amount: c("numeric", "Propina"),
      tip_method: c("text", "Medio de la propina"),
      notes: c("text", "Notas"),
      customer_id: c("uuid", "Cliente"),
      store_id: c("uuid", "Sucursal"),
      cash_shift_id: c("uuid", "Turno de caja"),
      professional_id: c("uuid", "Profesional"),
      created_by: c("uuid", "Vendedor (usuario)"),
      promo_name: c("text", "Promoción aplicada"),
      promo_discount: c("numeric", "Descuento por promoción"),
      coupon_code: c("text", "Cupón aplicado"),
      coupon_discount: c("numeric", "Descuento por cupón"),
      void_reason: c("text", "Motivo de anulación"),
      voided_at: c("timestamptz", "Anulada el"),
      created_at: c("timestamptz", "Fecha y hora de la venta (hora Argentina)"),
    },
    refs: {
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
      store: { col: "store_id", to: "stores", d: "Sucursal" },
      professional: { col: "professional_id", to: "professionals", d: "Profesional" },
      seller: { col: "created_by", to: "tenant_users", target: "user_id", d: "Vendedor (miembro del equipo)" },
    },
    def: ["number", "created_at", "status", "total", "discount_total", "customer.name", "seller.display_name"],
  },
  sale_items: {
    d: "Renglones de cada venta (producto, cantidad, precio). Filtrá sale.status = completed para excluir anuladas.",
    cols: {
      id,
      sale_id: c("uuid", "Venta"),
      product_id: c("uuid", "Producto"),
      variant_id: c("uuid", "Variante"),
      product_name: c("text", "Nombre del producto al momento de la venta"),
      sku: c("text", "SKU"),
      quantity: c("numeric", "Cantidad"),
      unit_price: c("numeric", "Precio unitario"),
      discount: c("numeric", "Descuento del renglón"),
      subtotal: c("numeric", "Subtotal del renglón"),
      returned_qty: c("numeric", "Cantidad devuelta"),
      serial: c("text", "Número de serie"),
      created_at: created,
    },
    refs: {
      sale: { col: "sale_id", to: "sales", d: "Venta" },
      product: { col: "product_id", to: "products", d: "Producto" },
      product_category: {
        via: "product",
        col: "category_id",
        to: "categories",
        d: "Categoría del producto",
      },
    },
  },
  payments: {
    d: "Pagos de cada venta por medio de pago (method: cash, debit, credit, transfer, qr, account = cuenta corriente, store_credit = saldo a favor, other).",
    cols: {
      id,
      sale_id: c("uuid", "Venta"),
      method: c("text", "Medio de pago"),
      amount: c("numeric", "Importe"),
      reference: c("text", "Referencia / comprobante"),
      created_at: created,
    },
    refs: { sale: { col: "sale_id", to: "sales", d: "Venta" } },
  },
  sale_returns: {
    d: "Devoluciones y cambios (notas de crédito).",
    cols: {
      id,
      number: c("int", "Número"),
      sale_id: c("uuid", "Venta original"),
      customer_id: c("uuid", "Cliente"),
      total: c("numeric", "Total devuelto"),
      refund_method: c("text", "Reintegro: cash | store_credit"),
      reason: c("text", "Motivo"),
      created_by: c("uuid", "Usuario"),
      created_at: created,
    },
    refs: {
      sale: { col: "sale_id", to: "sales", d: "Venta original" },
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
    },
  },
  return_reasons: {
    d: "Motivos de devolución configurados.",
    cols: { id, label: c("text", "Motivo"), is_active: active },
  },
  stores: {
    d: "Sucursales del negocio.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      address: c("text", "Dirección"),
      phone: c("text", "Teléfono"),
      is_active: active,
      is_default: c("bool", "Sucursal principal"),
    },
  },
  cash_registers: {
    d: "Cajas registradoras.",
    cols: {
      id,
      name: c("text", "Nombre"),
      store_id: c("uuid", "Sucursal"),
      is_active: active,
    },
    refs: { store: { col: "store_id", to: "stores", d: "Sucursal" } },
  },
  cash_shifts: {
    d: "Turnos de caja (apertura y cierre). status: open | closed.",
    cols: {
      id,
      cash_register_id: c("uuid", "Caja"),
      status: c("text", "Estado: open | closed"),
      opened_at: c("timestamptz", "Apertura"),
      closed_at: c("timestamptz", "Cierre"),
      opening_amount: c("numeric", "Monto de apertura"),
      expected_amount: c("numeric", "Efectivo esperado al cierre"),
      closing_amount: c("numeric", "Efectivo contado al cierre"),
      difference: c("numeric", "Diferencia (contado − esperado)"),
      notes: c("text", "Notas"),
      opened_by: c("uuid", "Abrió"),
      closed_by: c("uuid", "Cerró"),
    },
    refs: {
      register: { col: "cash_register_id", to: "cash_registers", d: "Caja" },
      opener: { col: "opened_by", to: "tenant_users", target: "user_id", d: "Quién abrió" },
    },
  },
  cash_movements: {
    d: "Movimientos de caja (type: income = ingreso, expense = egreso, sale, sale_void).",
    cols: {
      id,
      cash_shift_id: c("uuid", "Turno"),
      type: c("text", "Tipo: income | expense | sale | sale_void"),
      amount: c("numeric", "Importe"),
      payment_method: c("text", "Medio"),
      reason: c("text", "Motivo"),
      created_by: c("uuid", "Usuario"),
      created_at: created,
    },
    refs: { shift: { col: "cash_shift_id", to: "cash_shifts", d: "Turno de caja" } },
  },
  cash_z_closures: {
    d: "Cierres Z de caja con totales del turno.",
    cols: {
      id,
      z_number: c("int", "Número de Z"),
      cash_shift_id: c("uuid", "Turno"),
      store_id: c("uuid", "Sucursal"),
      opened_at: c("timestamptz", "Apertura"),
      closed_at: c("timestamptz", "Cierre"),
      opening_amount: c("numeric", "Apertura"),
      closing_amount: c("numeric", "Contado"),
      expected_amount: c("numeric", "Esperado"),
      difference: c("numeric", "Diferencia"),
      sales_count: c("int", "Cantidad de ventas"),
      sales_total: c("numeric", "Total vendido"),
      voids_count: c("int", "Anulaciones"),
      voids_total: c("numeric", "Total anulado"),
      discounts_total: c("numeric", "Descuentos"),
      cash_in: c("numeric", "Ingresos de caja"),
      cash_out: c("numeric", "Egresos de caja"),
    },
  },
  promotions: {
    d: "Promociones automáticas (2x1, % off, combos, por medio de pago).",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      is_active: active,
      priority: c("int", "Prioridad"),
      valid_from: c("date", "Vigente desde"),
      valid_to: c("date", "Vigente hasta"),
      min_amount: c("numeric", "Compra mínima"),
      scope: c("text", "Alcance: cart | category | product"),
      action_type: c("text", "Beneficio: percent | amount | nxm | fixed_price | second_item | volume_tier | gift"),
      action_value: c("numeric", "Valor del beneficio"),
      buy_qty: c("int", "Llevás N"),
      pay_qty: c("int", "Pagás M"),
      payment_method: c("text", "Medio de pago requerido"),
      created_at: created,
    },
  },
  coupons: {
    d: "Cupones de descuento.",
    soft: true,
    cols: {
      id,
      code: c("text", "Código"),
      discount_type: c("text", "Tipo: percent | amount"),
      discount_value: c("numeric", "Valor"),
      min_amount: c("numeric", "Compra mínima"),
      valid_from: c("date", "Desde"),
      valid_to: c("date", "Hasta"),
      max_uses: c("int", "Usos máximos"),
      used_count: c("int", "Veces usado"),
      max_per_customer: c("int", "Usos por cliente"),
      is_active: active,
      created_at: created,
    },
  },
  coupon_redemptions: {
    d: "Usos de cupones en ventas.",
    cols: {
      id,
      coupon_id: c("uuid", "Cupón"),
      sale_id: c("uuid", "Venta"),
      customer_id: c("uuid", "Cliente"),
      discount: c("numeric", "Descuento aplicado"),
      redeemed_at: c("timestamptz", "Fecha"),
    },
    refs: {
      coupon: { col: "coupon_id", to: "coupons", d: "Cupón" },
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
    },
  },
  warranty_plans: {
    d: "Planes de garantía extendida que se venden.",
    cols: {
      id,
      label: c("text", "Nombre"),
      description: c("text", "Descripción"),
      months: c("int", "Meses"),
      price: c("numeric", "Precio fijo"),
      price_pct: c("numeric", "Precio % del producto"),
      commission_pct: c("numeric", "Comisión %"),
      is_active: active,
    },
  },
  product_serials: {
    d: "Números de serie de productos serializados.",
    cols: {
      id,
      product_id: c("uuid", "Producto"),
      serial: c("text", "Número de serie"),
      status: c("text", "Estado: in_stock | sold"),
      sale_id: c("uuid", "Venta"),
      created_at: created,
    },
    refs: { product: { col: "product_id", to: "products", d: "Producto" } },
  },
  professionals: {
    d: "Profesionales (agenda y comisiones).",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      commission_pct: c("numeric", "Comisión %"),
      is_active: active,
      notes: c("text", "Notas"),
      created_at: created,
    },
  },
  appointments: {
    d: "Turnos de la agenda.",
    cols: {
      id,
      professional_id: c("uuid", "Profesional"),
      customer_id: c("uuid", "Cliente"),
      service_name: c("text", "Servicio"),
      service_price: c("numeric", "Precio del servicio"),
      commission_pct: c("numeric", "Comisión %"),
      starts_at: c("timestamptz", "Fecha y hora del turno"),
      duration_min: c("int", "Duración en minutos"),
      status: c("text", "Estado: reservado | confirmado | en_curso | realizado | cancelado | no_show"),
      notes: c("text", "Notas"),
      is_walk_in: c("bool", "Sin turno previo"),
      sale_id: c("uuid", "Venta"),
      cancel_reason: c("text", "Motivo de cancelación"),
      created_at: created,
    },
    refs: {
      professional: { col: "professional_id", to: "professionals", d: "Profesional" },
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
    },
  },
  service_packs: {
    d: "Packs de sesiones que se venden (ej. 10 clases).",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      product_id: c("uuid", "Servicio"),
      sessions: c("int", "Sesiones"),
      price: c("numeric", "Precio"),
      validity_days: c("int", "Validez en días"),
      is_active: active,
    },
  },
  customer_pack_credits: {
    d: "Packs comprados por clientes y sesiones usadas.",
    cols: {
      id,
      customer_id: c("uuid", "Cliente"),
      pack_id: c("uuid", "Pack"),
      pack_name: c("text", "Pack"),
      sessions_total: c("int", "Sesiones compradas"),
      sessions_used: c("int", "Sesiones usadas"),
      expires_at: c("timestamptz", "Vence"),
      created_at: created,
    },
    refs: { customer: { col: "customer_id", to: "customers", d: "Cliente" } },
  },
  dining_areas: {
    d: "Salones / áreas del restaurante.",
    soft: true,
    cols: { id, name: c("text", "Nombre"), sort: c("int", "Orden") },
  },
  dining_tables: {
    d: "Mesas del restaurante.",
    soft: true,
    cols: {
      id,
      area_id: c("uuid", "Salón"),
      label: c("text", "Mesa"),
      capacity: c("int", "Capacidad"),
      status: c("text", "Estado: libre | ocupada | cuenta_pedida | bloqueada | reservada"),
      created_at: created,
    },
    refs: { area: { col: "area_id", to: "dining_areas", d: "Salón" } },
  },
  table_orders: {
    d: "Comandas de mesa (cuentas abiertas o cerradas).",
    cols: {
      id,
      table_id: c("uuid", "Mesa"),
      status: c("text", "Estado: abierta | cobrada | cancelada"),
      opened_at: c("timestamptz", "Apertura"),
      sale_id: c("uuid", "Venta"),
      notes: c("text", "Notas"),
      created_at: created,
    },
    refs: { table: { col: "table_id", to: "dining_tables", d: "Mesa" } },
  },
  table_order_items: {
    d: "Ítems pedidos en comandas de mesa.",
    cols: {
      id,
      order_id: c("uuid", "Comanda"),
      product_id: c("uuid", "Producto"),
      name: c("text", "Producto"),
      qty: c("numeric", "Cantidad"),
      unit_price: c("numeric", "Precio unitario"),
      station: c("text", "Estación"),
      kds_status: c("text", "Cocina: pendiente | preparando | listo | entregado"),
      course: c("int", "Tiempo / paso"),
      created_at: created,
    },
    refs: { order: { col: "order_id", to: "table_orders", d: "Comanda" } },
  },
  dining_reservations: {
    d: "Reservas de mesa.",
    soft: true,
    cols: {
      id,
      area_id: c("uuid", "Salón"),
      table_id: c("uuid", "Mesa"),
      customer_id: c("uuid", "Cliente"),
      customer_name: c("text", "Nombre"),
      customer_phone: c("text", "Teléfono"),
      party_size: c("int", "Personas"),
      reserved_at: c("timestamptz", "Fecha y hora"),
      duration_minutes: c("int", "Duración"),
      status: c("text", "Estado: pendiente | confirmada | sentada | cancelada | no_show"),
      deposit_amount: c("numeric", "Seña"),
      notes: c("text", "Notas"),
      created_at: created,
    },
  },
  delivery_orders: {
    d: "Pedidos de delivery / take away.",
    soft: true,
    cols: {
      id,
      channel: c("text", "Canal: mostrador | telefono | whatsapp | qr | delivery_propio"),
      order_type: c("text", "Tipo: delivery | takeaway | mostrador"),
      customer_id: c("uuid", "Cliente"),
      customer_name: c("text", "Nombre"),
      customer_phone: c("text", "Teléfono"),
      address: c("text", "Dirección"),
      promised_at: c("timestamptz", "Hora prometida"),
      courier_name: c("text", "Repartidor"),
      delivery_fee: c("numeric", "Costo de envío"),
      status: c("text", "Estado: recibido | preparando | en_camino | listo | entregado | cancelado"),
      sale_id: c("uuid", "Venta"),
      zone_id: c("uuid", "Zona"),
      notes: c("text", "Notas"),
      created_at: created,
    },
    refs: {
      zone: { col: "zone_id", to: "delivery_zones", d: "Zona de envío" },
      customer: { col: "customer_id", to: "customers", d: "Cliente" },
    },
  },
  delivery_order_items: {
    d: "Ítems de pedidos de delivery.",
    cols: {
      id,
      order_id: c("uuid", "Pedido"),
      product_id: c("uuid", "Producto"),
      name: c("text", "Producto"),
      qty: c("numeric", "Cantidad"),
      unit_price: c("numeric", "Precio unitario"),
      station: c("text", "Estación"),
      kds_status: c("text", "Cocina: pendiente | preparando | listo | entregado"),
      created_at: created,
    },
    refs: { order: { col: "order_id", to: "delivery_orders", d: "Pedido" } },
  },
  delivery_zones: {
    d: "Zonas de envío con su costo.",
    soft: true,
    cols: {
      id,
      name: c("text", "Nombre"),
      fee: c("numeric", "Costo de envío"),
      eta_minutes: c("int", "Demora estimada (min)"),
      is_active: active,
    },
  },
  menus: {
    d: "Cartas / menús (gastronomía).",
    soft: true,
    cols: { id, name: c("text", "Nombre"), is_active: active },
  },
  tenant_users: {
    d: "Equipo: usuarios del negocio con su rol (owner = dueño, manager = encargado, cashier = cajero, viewer). Sin emails ni credenciales.",
    cols: {
      id,
      user_id: c("uuid", "Usuario"),
      display_name: c("text", "Nombre visible"),
      role: c("text", "Rol"),
      status: c("text", "Estado: active | suspended | invited"),
      joined_at: c("timestamptz", "Se sumó el"),
      created_at: created,
    },
  },
  cashier_profiles: {
    d: "Perfiles de cajero (login por PIN; sin el PIN).",
    soft: true,
    cols: {
      id,
      display_name: c("text", "Nombre"),
      status: c("text", "Estado"),
      created_at: created,
    },
  },
  payment_plans: {
    d: "Planes de cuotas con tarjeta configurados (recargo por cuotas).",
    cols: {
      id,
      label: c("text", "Nombre"),
      base: c("text", "Base: efectivo | transferencia | debito | credito | qr | otro"),
      brand: c("text", "Tarjeta"),
      installments: c("int", "Cuotas"),
      surcharge_pct: c("numeric", "Recargo %"),
      provider_key: c("text", "Proveedor"),
      is_active: active,
    },
  },
  tenant_payment_methods: {
    d: "Medios de pago habilitados en el negocio (sin credenciales).",
    cols: {
      id,
      provider_key: c("text", "Medio / proveedor"),
      enabled: c("bool", "Habilitado"),
      sandbox: c("bool", "En modo prueba"),
      surcharge_pct: c("numeric", "Recargo %"),
      sort: c("int", "Orden"),
    },
  },
  subscriptions: {
    d: "Suscripción del negocio a NinjaPos (plan, estado y período).",
    cols: {
      id,
      status: c("text", "Estado: trial | active | past_due | suspended | cancelled"),
      billing_cycle: c("text", "Ciclo (monthly | yearly)"),
      is_lifetime: c("bool", "Vitalicia"),
      current_period_start: c("timestamptz", "Inicio del período"),
      current_period_end: c("timestamptz", "Fin del período"),
      cancel_at_period_end: c("bool", "Se cancela al fin del período"),
      plan_id: c("uuid", "Plan"),
      created_at: created,
    },
    refs: { plan: { col: "plan_id", to: "plans", d: "Plan contratado" } },
  },
  subscription_addons: {
    d: "Complementos contratados (ej. asistente_ia).",
    cols: {
      id,
      addon_key: c("text", "Complemento"),
      status: c("text", "Estado"),
      current_period_end: c("date", "Fin del período"),
      cancel_at_period_end: c("bool", "Se cancela al fin del período"),
      monthly_price_ars: c("numeric", "Precio mensual"),
    },
  },
  plans: {
    d: "Planes comerciales de NinjaPos (sólo vía suscripción).",
    refOnly: true,
    global: true,
    cols: {
      id,
      key: c("text", "Clave"),
      name: c("text", "Nombre"),
      monthly_price_ars: c("numeric", "Precio mensual"),
      yearly_price_ars: c("numeric", "Precio anual"),
    },
  },
};

/** Tablas que jamás deben aparecer en el catálogo (test de regresión). */
export const FORBIDDEN_TABLES = [
  "payment_secrets",
  "platform_secrets",
  "tenant_email_smtp",
  "system_email_smtp",
  "email_providers",
  "mp_oauth_states",
  "mp_webhook_events",
  "audit_logs",
  "users",
  "invite_codes",
  "ai_usage",
  "ai_conversations",
  "ai_messages",
] as const;

/** Patrones de columnas sensibles que jamás deben estar whitelisteadas. */
export const FORBIDDEN_COLUMN_PATTERN =
  /(secret|password|pass$|pin_hash|token|api_key|apikey|config|metadata|card_voucher|settings|limits)/i;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const TOKEN = /^[a-z_][a-z0-9_]{0,62}(\.[a-z_][a-z0-9_]{0,62})?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type ResolvedCol = { token: string; type: ColType; ref: string | null };

/** Resuelve `col` o `ref.col` de una entidad contra el catálogo. */
export function resolveColumn(
  entity: string,
  token: unknown,
): ResolvedCol | null {
  const ent = AI_QUERY_CATALOG[entity];
  if (!ent || typeof token !== "string" || !TOKEN.test(token)) return null;
  const [a, b] = token.split(".") as [string, string | undefined];
  if (b === undefined) {
    const col = Object.prototype.hasOwnProperty.call(ent.cols, a)
      ? ent.cols[a]
      : undefined;
    return col ? { token, type: col.t, ref: null } : null;
  }
  const ref =
    ent.refs && Object.prototype.hasOwnProperty.call(ent.refs, a)
      ? ent.refs[a]
      : undefined;
  if (!ref) return null;
  const target = AI_QUERY_CATALOG[ref.to];
  const col =
    target && Object.prototype.hasOwnProperty.call(target.cols, b)
      ? target.cols[b]
      : undefined;
  return col ? { token, type: col.t, ref: a } : null;
}

export type ScalarValue = string | number | boolean;

export type NormalizedFilter = {
  col: string;
  op: FilterOp;
  value?: ScalarValue;
  values?: ScalarValue[];
};
export type NormalizedGroup = { col: string; trunc?: Trunc };
export type NormalizedAgg = { op: AggOp; col?: string };
export type NormalizedOrder = { col: string; dir: "asc" | "desc" };

export type NormalizedQuery = {
  entity: string;
  select?: string[];
  filters: NormalizedFilter[];
  group_by: NormalizedGroup[];
  aggregates: NormalizedAgg[];
  order_by: NormalizedOrder[];
  limit: number;
};

export type ValidationResult =
  | { ok: true; spec: NormalizedQuery }
  | { ok: false; error: string };

const NUMERIC_TYPES: ColType[] = ["numeric", "int"];
const ORDERABLE_TYPES: ColType[] = ["numeric", "int", "date", "timestamptz", "text"];

/** Alias de salida de una columna agrupada (igual que en SQL). */
export function groupAlias(g: NormalizedGroup): string {
  const base = g.col.replace(".", "_");
  return g.trunc ? `${base}_${g.trunc}` : base;
}

/** Alias de salida de un agregado (igual que en SQL). */
export function aggAlias(a: NormalizedAgg): string {
  return a.col ? `${a.op}_${a.col.replace(".", "_")}` : a.op;
}

function isScalar(v: unknown): v is ScalarValue {
  return (
    (typeof v === "string" && v.length <= MAX_VALUE_LENGTH) ||
    (typeof v === "number" && Number.isFinite(v)) ||
    typeof v === "boolean"
  );
}

/** Chequea que un valor sea casteable al tipo de la columna. */
function valueFits(type: ColType, v: ScalarValue): boolean {
  const s = String(v).trim();
  switch (type) {
    case "numeric":
    case "int":
      return s !== "" && Number.isFinite(Number(s));
    case "bool":
      // Mismos literales que acepta el cast ::boolean de Postgres.
      return /^(true|false|t|f|1|0|yes|no|y|n|on|off)$/i.test(s);
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    case "date":
      return DATE_ONLY.test(s) && !Number.isNaN(Date.parse(s));
    case "timestamptz":
      return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(s) &&
        !Number.isNaN(Date.parse(s.slice(0, 10)));
    default:
      return true;
  }
}

function fail(error: string): ValidationResult {
  return { ok: false, error };
}

/**
 * Valida y normaliza un pedido del modelo contra el catálogo. Cualquier
 * identificador fuera de la whitelist, operador desconocido, valor inválido o
 * exceso de límites devuelve { ok:false, error } con un texto que el modelo
 * puede usar para corregir el pedido.
 */
export function validateQuery(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail("El pedido debe ser un objeto.");
  }
  const q = input as Record<string, unknown>;
  const entity = q.entity;
  if (typeof entity !== "string" || !IDENT.test(entity)) {
    return fail("Falta 'entity' o no es válida. Usá ai_schema para ver las entidades.");
  }
  const ent = Object.prototype.hasOwnProperty.call(AI_QUERY_CATALOG, entity)
    ? AI_QUERY_CATALOG[entity]
    : undefined;
  if (!ent || ent.refOnly) {
    return fail(`La entidad '${entity}' no existe o no está disponible.`);
  }

  // ── filters ──
  const rawFilters = q.filters ?? [];
  if (!Array.isArray(rawFilters)) return fail("'filters' debe ser una lista.");
  if (rawFilters.length > MAX_FILTERS) {
    return fail(`Máximo ${MAX_FILTERS} filtros.`);
  }
  const filters: NormalizedFilter[] = [];
  for (const f of rawFilters) {
    if (!f || typeof f !== "object") return fail("Filtro inválido.");
    const { col, op, value, values } = f as Record<string, unknown>;
    const rc = resolveColumn(entity, col);
    if (!rc) return fail(`Columna no permitida en '${entity}': ${String(col).slice(0, 60)}`);
    if (typeof op !== "string" || !(FILTER_OPS as readonly string[]).includes(op)) {
      return fail(`Operador no permitido: ${String(op).slice(0, 30)}`);
    }
    const o = op as FilterOp;
    if (o === "is_null" || o === "not_null") {
      filters.push({ col: rc.token, op: o });
      continue;
    }
    if (o === "in" || o === "between") {
      if (!Array.isArray(values)) return fail(`'${o}' requiere 'values' (lista).`);
      if (o === "between" && values.length !== 2) {
        return fail("'between' requiere exactamente 2 valores.");
      }
      if (o === "in" && (values.length < 1 || values.length > MAX_IN_VALUES)) {
        return fail(`'in' acepta entre 1 y ${MAX_IN_VALUES} valores.`);
      }
      for (const v of values) {
        if (!isScalar(v) || !valueFits(rc.type, v)) {
          return fail(`Valor inválido para ${rc.token} (${rc.type}).`);
        }
      }
      filters.push({ col: rc.token, op: o, values: values as ScalarValue[] });
      continue;
    }
    if (!isScalar(value) || !valueFits(rc.type, value)) {
      return fail(`Valor inválido para ${rc.token} (${rc.type}).`);
    }
    if (o === "ilike" && rc.type !== "text") {
      return fail(`'ilike' sólo aplica a columnas de texto (${rc.token} es ${rc.type}).`);
    }
    if (["gt", "gte", "lt", "lte"].includes(o) && !ORDERABLE_TYPES.includes(rc.type)) {
      return fail(`'${o}' no aplica a ${rc.token} (${rc.type}).`);
    }
    filters.push({ col: rc.token, op: o, value });
  }

  // ── group_by ──
  const rawGroups = q.group_by ?? [];
  if (!Array.isArray(rawGroups)) return fail("'group_by' debe ser una lista.");
  if (rawGroups.length > MAX_GROUP_BY) return fail(`Máximo ${MAX_GROUP_BY} agrupaciones.`);
  const group_by: NormalizedGroup[] = [];
  for (const g of rawGroups) {
    const obj = typeof g === "string" ? { col: g } : (g as Record<string, unknown>);
    if (!obj || typeof obj !== "object") return fail("Agrupación inválida.");
    const rc = resolveColumn(entity, obj.col);
    if (!rc) return fail(`Columna no permitida para agrupar: ${String(obj.col).slice(0, 60)}`);
    const trunc = obj.trunc;
    if (trunc !== undefined && trunc !== null && trunc !== "") {
      if (typeof trunc !== "string" || !(TRUNCS as readonly string[]).includes(trunc)) {
        return fail("'trunc' debe ser day, week, month o year.");
      }
      if (rc.type !== "timestamptz" && rc.type !== "date") {
        return fail(`'trunc' sólo aplica a fechas (${rc.token} es ${rc.type}).`);
      }
      group_by.push({ col: rc.token, trunc: trunc as Trunc });
    } else {
      group_by.push({ col: rc.token });
    }
  }

  // ── aggregates ──
  const rawAggs = q.aggregates ?? [];
  if (!Array.isArray(rawAggs)) return fail("'aggregates' debe ser una lista.");
  if (rawAggs.length > MAX_AGGREGATES) return fail(`Máximo ${MAX_AGGREGATES} agregados.`);
  const aggregates: NormalizedAgg[] = [];
  for (const a of rawAggs) {
    if (!a || typeof a !== "object") return fail("Agregado inválido.");
    const { op, col } = a as Record<string, unknown>;
    if (typeof op !== "string" || !(AGG_OPS as readonly string[]).includes(op)) {
      return fail(`Agregado no permitido: ${String(op).slice(0, 30)}`);
    }
    const aop = op as AggOp;
    if (col === undefined || col === null || col === "") {
      if (aop !== "count") return fail(`'${aop}' requiere 'col'.`);
      aggregates.push({ op: "count" });
      continue;
    }
    const rc = resolveColumn(entity, col);
    if (!rc) return fail(`Columna no permitida para agregar: ${String(col).slice(0, 60)}`);
    if ((aop === "sum" || aop === "avg") && !NUMERIC_TYPES.includes(rc.type)) {
      return fail(`'${aop}' requiere una columna numérica (${rc.token} es ${rc.type}).`);
    }
    if ((aop === "min" || aop === "max") && !ORDERABLE_TYPES.includes(rc.type)) {
      return fail(`'${aop}' no aplica a ${rc.token} (${rc.type}).`);
    }
    aggregates.push({ op: aop, col: rc.token });
  }
  const aggMode = group_by.length > 0 || aggregates.length > 0;
  if (aggMode && aggregates.length === 0) aggregates.push({ op: "count" });

  const aliases = [...group_by.map(groupAlias), ...aggregates.map(aggAlias)];
  if (new Set(aliases).size !== aliases.length) {
    return fail("Hay columnas o agregados repetidos.");
  }

  // ── select ──
  let select: string[] | undefined;
  if (!aggMode && q.select !== undefined && q.select !== null) {
    if (!Array.isArray(q.select)) return fail("'select' debe ser una lista.");
    if (q.select.length > MAX_SELECT) return fail(`Máximo ${MAX_SELECT} columnas.`);
    select = [];
    for (const s of q.select) {
      const rc = resolveColumn(entity, s);
      if (!rc) return fail(`Columna no permitida en '${entity}': ${String(s).slice(0, 60)}`);
      if (!select.includes(rc.token)) select.push(rc.token);
    }
    if (select.length === 0) select = undefined;
  }

  // ── order_by ──
  const rawOrder = q.order_by ?? [];
  if (!Array.isArray(rawOrder)) return fail("'order_by' debe ser una lista.");
  if (rawOrder.length > MAX_ORDER_BY) return fail(`Máximo ${MAX_ORDER_BY} criterios de orden.`);
  const order_by: NormalizedOrder[] = [];
  for (const o of rawOrder) {
    const obj = typeof o === "string" ? { col: o } : (o as Record<string, unknown>);
    if (!obj || typeof obj !== "object") return fail("Orden inválido.");
    const dirRaw = obj.dir ?? "asc";
    if (dirRaw !== "asc" && dirRaw !== "desc") return fail("'dir' debe ser asc o desc.");
    const col = obj.col;
    if (typeof col !== "string" || !TOKEN.test(col)) return fail("Orden inválido.");
    if (aggMode) {
      // En modo agregado sólo se ordena por los alias de salida.
      const g = group_by.find((x) => x.col === col || groupAlias(x) === col);
      const alias = g ? groupAlias(g) : aliases.includes(col) ? col : null;
      if (!alias) {
        return fail(`En consultas agrupadas sólo podés ordenar por: ${aliases.join(", ")}.`);
      }
      order_by.push({ col: alias, dir: dirRaw });
    } else {
      const rc = resolveColumn(entity, col);
      if (!rc) return fail(`Columna no permitida para ordenar: ${col.slice(0, 60)}`);
      order_by.push({ col: rc.token, dir: dirRaw });
    }
  }

  // ── limit ──
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== null) {
    const n = Math.floor(Number(q.limit));
    if (!Number.isFinite(n)) return fail("'limit' debe ser un número.");
    limit = Math.min(Math.max(n, 1), MAX_LIMIT);
  }

  const spec: NormalizedQuery = { entity, filters, group_by, aggregates, order_by, limit };
  if (select) spec.select = select;
  return { ok: true, spec };
}

// ── Copia del catálogo para SQL ──────────────────────────────────────────────
// Forma compacta que embebe la migración en ai__query_catalog(). Un test
// compara este objeto con el JSON de la migración para que nunca diverjan.
export type SqlCatalog = {
  entities: Record<
    string,
    {
      cols: Record<string, ColType>;
      refs: Record<string, { col: string; to: string; target: string; via: string | null }>;
      soft: boolean;
      ref_only: boolean;
      global: boolean;
      def: string[] | null;
    }
  >;
};

export function catalogForSql(): SqlCatalog {
  const entities: SqlCatalog["entities"] = {};
  for (const name of Object.keys(AI_QUERY_CATALOG).sort()) {
    const e = AI_QUERY_CATALOG[name]!;
    const cols: Record<string, ColType> = {};
    for (const k of Object.keys(e.cols).sort()) cols[k] = e.cols[k]!.t;
    const refs: SqlCatalog["entities"][string]["refs"] = {};
    for (const k of Object.keys(e.refs ?? {}).sort()) {
      const r = e.refs![k]!;
      refs[k] = { col: r.col, to: r.to, target: r.target ?? "id", via: r.via ?? null };
    }
    entities[name] = {
      cols,
      refs,
      soft: Boolean(e.soft),
      ref_only: Boolean(e.refOnly),
      global: Boolean(e.global),
      def: e.def ?? null,
    };
  }
  return { entities };
}

// ── ai_schema: descripción legible para el modelo ────────────────────────────

/** Lista corta de entidades (va en el system prompt). */
export function schemaIndex(): string {
  return Object.entries(AI_QUERY_CATALOG)
    .filter(([, e]) => !e.refOnly)
    .map(([k, e]) => `• ${k}: ${e.d}`)
    .join("\n");
}

/** Detalle de columnas y relaciones de una o varias entidades. */
export function describeEntities(names: unknown): {
  entities?: Record<string, unknown>;
  error?: string;
} {
  const list = (Array.isArray(names) ? names : typeof names === "string" ? [names] : [])
    .filter((n): n is string => typeof n === "string")
    .slice(0, 6);
  if (list.length === 0) {
    return { error: "Indicá 'entities' (lista de nombres). Entidades: " + Object.keys(AI_QUERY_CATALOG).filter((k) => !AI_QUERY_CATALOG[k]!.refOnly).join(", ") };
  }
  const out: Record<string, unknown> = {};
  for (const n of list) {
    const e = Object.prototype.hasOwnProperty.call(AI_QUERY_CATALOG, n)
      ? AI_QUERY_CATALOG[n]
      : undefined;
    if (!e || e.refOnly) {
      out[n] = { error: "no existe o no está disponible" };
      continue;
    }
    const refs: Record<string, string> = {};
    for (const [rk, r] of Object.entries(e.refs ?? {})) {
      const target = AI_QUERY_CATALOG[r.to]!;
      refs[rk] = `${r.d} → usá ${rk}.<col> con col de ${r.to}: ${Object.keys(target.cols).join(", ")}`;
    }
    out[n] = {
      descripcion: e.d,
      columnas: Object.fromEntries(
        Object.entries(e.cols).map(([k, v]) => [k, `${v.t} · ${v.d}`]),
      ),
      ...(Object.keys(refs).length ? { relaciones: refs } : {}),
      ...(e.soft ? { nota: "Las filas dadas de baja se excluyen solas." } : {}),
    };
  }
  return { entities: out };
}
