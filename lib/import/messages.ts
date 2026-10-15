// Mensajes en lenguaje simple para los códigos que devuelven las RPC import_*
// (migración 20261104100100, ADR-078). El servidor devuelve el código o el
// texto del error de Postgres por fila; acá se traduce para el preview y el
// archivo de errores.

const FEATURE_LABELS: Record<string, string> = {
  importacion_excel: "la importación desde Excel",
  listas_precios: "las listas de precios",
  garantias: "las garantías extendidas",
  devoluciones: "las devoluciones",
  multi_sucursal: "varias sucursales",
  stock_sucursales: "el stock por sucursal",
  productos: "el catálogo de productos",
  clientes: "la gestión de clientes",
  stock: "el control de stock",
  depositos: "los depósitos internos",
  ajustes_stock: "los ajustes de stock",
  aprobacion_ajustes: "la aprobación de ajustes",
};

const CODES: Record<string, string> = {
  import_name_required: "Falta el nombre.",
  import_price_required: "Falta el precio (hace falta para crear un producto nuevo).",
  import_price_invalid: "El precio tiene que ser 0 o más.",
  import_cost_invalid: "El costo no puede ser negativo.",
  import_tax_invalid: "El IVA tiene que estar entre 0 y 100.",
  import_barcode_taken: "Ese código de barras ya lo tiene otro producto.",
  import_store_not_found: "No hay ninguna sucursal con ese nombre o código.",
  import_product_not_found: "No hay ningún producto con ese SKU o código de barras.",
  import_nothing_to_do: "La fila no trae cantidad, mínimo, máximo ni ubicación.",
  import_list_not_found: "No hay ninguna lista de precios con ese nombre.",
  import_months_invalid: "Los meses no pueden ser negativos.",
  import_pct_invalid: "Los porcentajes tienen que estar entre 0 y 100.",
  import_destination_invalid: "El destino del stock no es válido.",
  variant_required: "El producto tiene variantes: usá el SKU o el código de barras de la variante.",
  variant_not_found: "No se encontró la variante.",
  invalid_qty: "La cantidad no puede ser negativa.",
  min_greater_than_max: "El mínimo no puede ser mayor que el máximo.",
  store_not_found: "No se encontró la sucursal.",
  product_not_found: "No se encontró el producto.",
  store_name_required: "Falta el nombre de la sucursal.",
  forbidden: "Sólo el dueño o un encargado pueden importar.",
  no_tenant: "No hay un negocio activo en la sesión.",
  too_many_rows: "Demasiadas filas en un solo envío.",
  invalid_rows: "El envío no tiene el formato esperado.",
  import_warehouse_not_found: "No hay ningún depósito con ese código o nombre en la sucursal.",
  invalid_kind: "El tipo de depósito no es válido (Reserva, Devoluciones, Merma u Otro).",
  insufficient_warehouse_stock: "No alcanza el stock del salón para pasar esa cantidad al depósito.",
  warehouse_principal_is_computed: "El salón de ventas no se cuenta: su stock es lo que queda de la sucursal.",
  store_forbidden: "No tenés acceso a esa sucursal.",
  invalid_mode: "La operación tiene que ser Sumar, Restar o Fijar.",
  invalid_reason: "El motivo no es uno de la lista.",
  reason_notes_required: "Con el motivo Otro, contá qué pasó en la nota.",
  notes_too_long: "La nota es demasiado larga (máx. 300).",
  photo_required: "Este ajuste va a aprobación y el negocio pide foto: cargalo desde Inventario con la foto.",
  warehouse_store_mismatch: "Ese depósito es de otra sucursal.",
  warehouse_not_found: "No se encontró el depósito.",
  forbidden_capability: "No tenés permiso para ajustar stock.",
  forbidden_read_only: "Tu usuario es de solo lectura.",
  variant_not_allowed: "Ese producto no tiene variantes: usá el SKU del producto.",
};

const CONSTRAINTS: Array<[RegExp, string]> = [
  [/products_tenant_sku_idx/, "Ese SKU ya lo tiene otro producto."],
  [/products_tenant_barcode_idx/, "Ese código de barras ya lo tiene otro producto."],
  [/stores_tenant_code_uidx/, "Ese código de sucursal ya existe."],
  [/uq_return_reasons_tenant_code/, "Ese código de motivo ya existe."],
  [/stores_afip_pos_number_chk/, "El punto de venta fiscal tiene que estar entre 1 y 99998."],
  [/customers_iva_condition_check/, "La condición frente al IVA no es válida."],
  [/customers_document_type_check/, "El tipo de documento no es válido."],
  [/return_reasons_stock_destination_check/, "El destino del stock no es válido."],
  [/warehouses_store_name_key/, "Ya hay un depósito con ese nombre en la sucursal."],
  [/warehouses_tenant_code_key/, "Ese código de depósito ya existe."],
];

const NOTES: Record<string, string> = {
  unchanged: "Sin cambios: ya está igual en el sistema.",
  stock_ignored: "El stock no se cambia al actualizar un producto: usá la importación de stock.",
  scheduled: "Queda programado para la fecha indicada.",
  pending_approval: "Supera el umbral: queda esperando que lo apruebe el dueño o un auditor.",
  no_qty: "Sin cantidad: esta fila no se toca.",
};

/** Traduce el error del servidor (código o texto de Postgres) a lenguaje simple. */
export function importErrorMessage(raw: string | null | undefined): string {
  const msg = (raw ?? "").trim();
  if (!msg) return "No se pudo guardar esta fila.";
  const code = msg.split(/\s/)[0]!.replace(/:$/, "");
  if (CODES[code]) return CODES[code]!;
  const feat = /feature_not_in_plan:\s*([a-z_]+)/.exec(msg);
  if (feat) return `Tu plan no incluye ${FEATURE_LABELS[feat[1]!] ?? feat[1]}.`;
  const limit = /plan_limit:\s*([a-z_]+)/.exec(msg);
  if (limit) {
    return limit[1] === "max_stores"
      ? "Llegaste al máximo de sucursales de tu plan."
      : "Llegaste a un límite de tu plan.";
  }
  for (const [re, text] of CONSTRAINTS) if (re.test(msg)) return text;
  if (/duplicate key/i.test(msg)) return "Ya existe un registro con esos datos.";
  if (/invalid input syntax/i.test(msg)) return "Hay un valor con formato inválido.";
  return `No se pudo guardar esta fila (${msg}).`;
}

/** Aviso de una fila que se crea, actualiza u omite (null = sin aviso). */
export function importNoteMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return NOTES[raw] ?? null;
}
