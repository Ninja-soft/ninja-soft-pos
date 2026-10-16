// Presentación legible de un evento de auditoría (TX-AUD, ADR-160). PURO.
//
// Convierte una fila de audit_logs (entity_type, action, before_data,
// after_data) en algo que el dueño entiende de un vistazo:
//   - título humano ("Producto editado: Arroz 1 kg"),
//   - sólo los campos que cambiaron, con antes y después,
//   - etiquetas en español, agrupadas por sección,
//   - montos, porcentajes, fechas y booleanos formateados,
//   - ids resueltos a nombres (vía un `NameLookup` que arma el llamador),
//   - campos técnicos ocultos (siguen en "Ver datos técnicos").
// Lo que no está en los diccionarios cae a una etiqueta humanizada del
// snake_case: nunca se rompe por una tabla o acción nueva.

// ── Tipos ───────────────────────────────────────────────────────────────────

export type RefKind =
  | "category"
  | "brand"
  | "supplier"
  | "store"
  | "warehouse"
  | "customer"
  | "customer_group"
  | "user"
  | "register"
  | "price_list"
  | "product"
  | "cashier_profile";

/** Devuelve el nombre de un id ya resuelto, o null/undefined si no se pudo. */
export type NameLookup = (kind: RefKind, id: string) => string | null | undefined;

export interface AuditEventLike {
  entity_type: string;
  action: string;
  entity_id?: string | null;
  before_data: unknown;
  after_data: unknown;
}

export type AuditTone = "danger" | "warning" | "info" | "neutral";

export type SectionKey =
  | "general"
  | "precios"
  | "impuestos"
  | "stock"
  | "clasificacion"
  | "personas"
  | "ubicacion"
  | "estado"
  | "config"
  | "fechas"
  | "otros";

export const SECTION_TITLES: Record<SectionKey, string> = {
  general: "Datos generales",
  precios: "Precios y montos",
  impuestos: "Impuestos y facturación",
  stock: "Stock",
  clasificacion: "Clasificación",
  personas: "Personas",
  ubicacion: "Sucursal y caja",
  estado: "Estado",
  config: "Configuración",
  fechas: "Fechas",
  otros: "Otros datos",
};
const SECTION_ORDER = Object.keys(SECTION_TITLES) as SectionKey[];

export interface PresentedField {
  key: string;
  label: string;
  /** Valor anterior formateado; null = no había dato. */
  before: string | null;
  /** Valor nuevo formateado; null = quedó vacío. */
  after: string | null;
}

export interface PresentedSection {
  key: SectionKey;
  title: string;
  fields: PresentedField[];
}

export interface PresentedAudit {
  /** "Producto editado: Arroz 1 kg". */
  title: string;
  /** Sin el sujeto: "Producto editado". */
  headline: string;
  entityLabel: string;
  subject: string | null;
  /**
   * changes: hay antes y después, se muestran sólo los cambios.
   * snapshot: hay un solo lado (alta, baja o acción con detalle).
   * none: el evento no trae datos.
   */
  mode: "changes" | "snapshot" | "none";
  /** Encabezado de la lista ("Qué cambió", "Datos cargados"...). */
  listTitle: string;
  sections: PresentedSection[];
  fieldCount: number;
  tone: AuditTone;
}

type Gender = "m" | "f";
type ValueKind =
  | "text"
  | "money"
  | "money_cents"
  | "usd"
  | "pct"
  | "number"
  | "date"
  | "datetime"
  | "bool"
  | "json";

interface FieldDef {
  label: string;
  section?: SectionKey;
  kind?: ValueKind;
  ref?: RefKind;
}

// ── Entidades ───────────────────────────────────────────────────────────────

interface EntityDef {
  one: string;
  g: Gender;
}

const ENTITIES: Record<string, EntityDef> = {
  products: { one: "Producto", g: "m" },
  product_stock: { one: "Stock del producto", g: "m" },
  categories: { one: "Categoría", g: "f" },
  brands: { one: "Marca", g: "f" },
  api_docs: { one: "Documentación de la API", g: "f" },
  suppliers: { one: "Proveedor", g: "m" },
  supplier_products: { one: "Producto del proveedor", g: "m" },
  supplier_tax_profiles: { one: "Perfil impositivo del proveedor", g: "m" },
  sales: { one: "Venta", g: "f" },
  sale: { one: "Venta", g: "f" },
  sale_items: { one: "Ítem de venta", g: "m" },
  sale_returns: { one: "Devolución", g: "f" },
  sale_orders: { one: "Pedido", g: "m" },
  sale_letter_overrides: { one: "Letra de comprobante forzada", g: "f" },
  paused_sales: { one: "Venta en espera", g: "f" },
  payments: { one: "Cobro", g: "m" },
  payment_plans: { one: "Plan de cuotas", g: "m" },
  payment_terminals: { one: "Terminal de cobro", g: "f" },
  payment_terms: { one: "Condición de pago", g: "f" },
  tenant_payment_methods: { one: "Medio de pago", g: "m" },
  customers: { one: "Cliente", g: "m" },
  customer_groups: { one: "Grupo de clientes", g: "m" },
  customer_account_movements: { one: "Movimiento de cuenta corriente", g: "m" },
  customer_pack_credits: { one: "Crédito de pack", g: "m" },
  cash_shifts: { one: "Turno de caja", g: "m" },
  cash_movements: { one: "Movimiento de caja", g: "m" },
  cash_registers: { one: "Caja", g: "f" },
  cash_z_closures: { one: "Cierre Z", g: "m" },
  stores: { one: "Sucursal", g: "f" },
  store_groups: { one: "Grupo de sucursales", g: "m" },
  warehouses: { one: "Depósito", g: "m" },
  tenant_users: { one: "Usuario", g: "m" },
  users: { one: "Usuario", g: "m" },
  member: { one: "Usuario", g: "m" },
  cashier_profiles: { one: "Perfil de cajero", g: "m" },
  staff: { one: "Personal", g: "m" },
  staff_status_events: { one: "Estado del personal", g: "m" },
  staff_branch_assignments: { one: "Sucursal del personal", g: "f" },
  price_lists: { one: "Lista de precios", g: "f" },
  price_list_assignments: { one: "Asignación de lista de precios", g: "f" },
  price_list_breaks: { one: "Escala de precios", g: "f" },
  price_schedules: { one: "Cambio de precio programado", g: "m" },
  price_bulk_batches: { one: "Cambio masivo de precios", g: "m" },
  price_fx_rules: { one: "Regla de precio en dólares", g: "f" },
  price_settings: { one: "Configuración de precios", g: "f" },
  price_index_values: { one: "Índice de precios", g: "m" },
  stock_movements: { one: "Movimiento de stock", g: "m" },
  stock_adjustments: { one: "Ajuste de stock", g: "m" },
  stock_transfers: { one: "Traslado", g: "m" },
  stock_reservations: { one: "Reserva de stock", g: "f" },
  stock_transfer_settings: { one: "Configuración de traslados", g: "f" },
  cycle_counts: { one: "Conteo cíclico", g: "m" },
  arca_settings: { one: "Configuración de ARCA", g: "f" },
  arca_certificates: { one: "Certificado de ARCA", g: "m" },
  arca_caea: { one: "CAEA", g: "m" },
  arca_padron_config: { one: "Consulta al padrón de ARCA", g: "f" },
  fiscal_documents: { one: "Comprobante fiscal", g: "m" },
  tax_settings: { one: "Configuración de impuestos", g: "f" },
  tax_regimes: { one: "Régimen impositivo", g: "m" },
  tax_exemptions: { one: "Exención impositiva", g: "f" },
  tax_padron_profiles: { one: "Padrón impositivo", g: "m" },
  tax_custom_values: { one: "Impuesto personalizado", g: "m" },
  tax_withholdings: { one: "Retención", g: "f" },
  iibb_activities: { one: "Actividad de IIBB", g: "f" },
  iibb_liquidations: { one: "Liquidación de IIBB", g: "f" },
  subscriptions: { one: "Suscripción", g: "f" },
  subscription: { one: "Suscripción", g: "f" },
  subscription_addons: { one: "Complemento", g: "m" },
  plans: { one: "Plan", g: "m" },
  tenants: { one: "Negocio", g: "m" },
  tenant: { one: "Negocio", g: "m" },
  tenant_feature_flags: { one: "Función del negocio", g: "f" },
  tenant_branding: { one: "Marca del negocio", g: "f" },
  billing_records: { one: "Registro de facturación", g: "m" },
  security_settings: { one: "Política de seguridad", g: "f" },
  pos_settings: { one: "Configuración del POS", g: "f" },
  promotions: { one: "Promoción", g: "f" },
  printers: { one: "Impresora", g: "f" },
  label_templates: { one: "Plantilla de etiquetas", g: "f" },
  appointments: { one: "Turno de agenda", g: "m" },
  agenda_resources: { one: "Recurso de agenda", g: "m" },
  agenda_waitlist: { one: "Lista de espera", g: "f" },
  dining_reservations: { one: "Reserva", g: "f" },
  dining_waitlist: { one: "Lista de espera", g: "f" },
  dining_tables: { one: "Mesa", g: "f" },
  table_orders: { one: "Comanda", g: "f" },
  menus: { one: "Menú", g: "m" },
  delivery_orders: { one: "Pedido de delivery", g: "m" },
  delivery_zones: { one: "Zona de delivery", g: "f" },
  service_packs: { one: "Pack de servicios", g: "m" },
  treasury_accounts: { one: "Cuenta de tesorería", g: "f" },
  treasury_movements: { one: "Movimiento de tesorería", g: "m" },
  transfer_accounts: { one: "Cuenta para transferencias", g: "f" },
  fx_rates: { one: "Cotización", g: "f" },
  remitos: { one: "Remito", g: "m" },
  store_credit_vouchers: { one: "Vale de crédito", g: "m" },
  warranty_plans: { one: "Plan de garantía", g: "m" },
  serial_warranty_claims: { one: "Reclamo de garantía", g: "m" },
  invite_codes: { one: "Código de invitación", g: "m" },
  notifications: { one: "Notificación", g: "f" },
  pending_charges: { one: "Cargo pendiente", g: "m" },
  payment_disputes: { one: "Contracargo", g: "m" },
  purchase_orders: { one: "Orden de compra", g: "f" },
  supplier_invoices: { one: "Factura de proveedor", g: "f" },
  supplier_payments: { one: "Pago a proveedor", g: "m" },
  impersonation: { one: "Acceso como el negocio", g: "m" },
};

/** Etiqueta singular de una entidad, con respaldo humanizado. */
export function entityLabel(entityType: string): string {
  return ENTITIES[entityType]?.one ?? humanize(entityType);
}

const PARTICIPLES: Record<string, Record<Gender, string>> = {
  insert: { m: "creado", f: "creada" },
  update: { m: "editado", f: "editada" },
  delete: { m: "eliminado", f: "eliminada" },
  soft_delete: { m: "dado de baja", f: "dada de baja" },
  restore: { m: "restaurado", f: "restaurada" },
  deactivate: { m: "desactivado", f: "desactivada" },
  activate: { m: "activado", f: "activada" },
};

// ── Acciones con nombre ─────────────────────────────────────────────────────

const NAMED: Record<string, string> = {
  // Ventas y ARCA
  sale_ticket_only: "Venta con sólo ticket (sin factura)",
  sale_ticket_only_set: "Próxima venta con sólo ticket",
  sale_ticket_only_clear: "Se quitó el sólo ticket",
  sale_voided: "Venta anulada",
  sale_void: "Venta anulada",
  sale_order_created: "Pedido creado",
  sale_order_cancelled: "Pedido cancelado",
  sale_letter_override_set: "Letra del comprobante forzada",
  sale_letter_override_rejected: "Letra del comprobante rechazada",
  return_created: "Devolución registrada",
  remito_issued: "Remito emitido",
  arca_ticket_mode_changed: "Comprobante por defecto cambiado",
  arca_environment_changed: "Ambiente de ARCA cambiado",
  arca_settings_updated: "Configuración de ARCA editada",
  arca_certificate_deleted: "Certificado de ARCA eliminado",
  arca_padron_config_updated: "Consulta al padrón de ARCA editada",
  // Usuarios y personal
  member_invited: "Usuario invitado",
  member_updated: "Usuario editado",
  member_profile_updated: "Perfil del usuario editado",
  member_status_changed: "Estado del usuario cambiado",
  member_invite_resent: "Invitación reenviada",
  member_invited_internal: "Usuario invitado desde el panel interno",
  member_role_changed_internal: "Rol del usuario cambiado (panel interno)",
  member_suspended_internal: "Usuario suspendido (panel interno)",
  member_reactivated_internal: "Usuario reactivado (panel interno)",
  member_access_reset_internal: "Acceso del usuario reseteado",
  profile_created: "Perfil sin cuenta creado",
  profile_updated: "Perfil sin cuenta editado",
  profile_status_changed: "Estado del perfil cambiado",
  staff_member_created: "Persona dada de alta",
  staff_member_updated: "Persona editada",
  staff_suspended: "Persona suspendida",
  staff_leave_scheduled: "Licencia cargada",
  staff_terminated: "Persona dada de baja",
  staff_termination_applied: "Baja programada aplicada",
  staff_status_cancelled: "Estado programado cancelado",
  staff_status_lifted: "Suspensión o licencia levantada",
  staff_rehired: "Persona reincorporada",
  staff_branch_scheduled: "Asignación de sucursal programada",
  staff_branch_cancelled: "Traslado de personal cancelado",
  staff_permission_granted: "Permiso otorgado",
  staff_permission_revoked: "Permiso quitado",
  staff_level_set: "Nivel de staff cambiado",
  permission_role_created: "Rol creado",
  permission_role_updated: "Rol editado",
  permission_role_deleted: "Rol eliminado",
  permission_override_set: "Permiso puntual cambiado",
  permission_branch_role_set: "Rol por sucursal cambiado",
  // Seguridad y supervisor
  security_settings_changed: "Política de seguridad cambiada",
  supervisor_pin_set: "PIN de supervisor cargado",
  supervisor_pin_changed: "PIN de supervisor cambiado",
  supervisor_pin_cleared: "PIN de supervisor borrado",
  supervisor_pin_failed: "PIN de supervisor incorrecto",
  supervisor_pin_locked: "PIN de supervisor bloqueado",
  supervisor_pin_unlocked: "PIN de supervisor desbloqueado",
  supervisor_authorized: "Supervisor autorizó con PIN",
  supervisor_override_used: "Se usó una autorización de supervisor",
  supervisor_requester_locked: "Bloqueo por intentos fallidos",
  supervisor_rotating_enabled: "PIN rotativo activado",
  supervisor_rotating_regenerated: "Secreto del PIN rotativo cambiado",
  supervisor_rotating_disabled: "PIN rotativo desactivado",
  supervisor_totp_enroll_started: "Vinculación de app autenticadora iniciada",
  supervisor_totp_enabled: "App autenticadora vinculada",
  supervisor_totp_disabled: "App autenticadora desvinculada",
  supervisor_one_time_created: "PIN de un uso generado",
  supervisor_one_time_revoked: "PIN de un uso revocado",
  supervisor_methods_reset: "PINes del supervisor borrados",
  // Caja
  cash_shift_force_closed: "Cierre forzado de caja",
  shift_force_close: "Cierre forzado de caja",
  cash_drawer_opened: "Cajón abierto",
  cash_drawer_denied: "Pedido de cajón rechazado",
  register_hardware_changed: "Balanza o cajón de la caja cambiados",
  // Cuenta corriente
  account_override_authorized: "Venta a cuenta bloqueada autorizada",
  account_block_override: "Venta a cuenta con autorización",
  account_charge: "Venta a cuenta corriente",
  account_payment_voided: "Pago de cuenta corriente anulado",
  account_terms_changed: "Condiciones de cuenta corriente cambiadas",
  account_group_terms_changed: "Condiciones del grupo cambiadas",
  account_settings_changed: "Configuración de cuenta corriente cambiada",
  customer_note_deleted: "Nota del cliente eliminada",
  payments_reconciled: "Cobros con tarjeta conciliados",
  payments_unreconciled: "Cobros con tarjeta desconciliados",
  // Precios
  price_settings_changed: "Configuración de precios cambiada",
  price_bulk_created: "Cambio masivo de precios cargado",
  price_bulk_approved: "Cambio masivo de precios aprobado",
  price_bulk_rejected: "Cambio masivo de precios rechazado",
  price_bulk_reverted: "Cambio masivo de precios revertido",
  price_schedule_cancelled: "Cambio de precio programado cancelado",
  price_fx_rule_deleted: "Regla de precio en dólares eliminada",
  margin_settings_updated: "Alertas de margen editadas",
  fx_manual_set: "Cotización manual cargada",
  fx_manual_cleared: "Cotización manual quitada",
  // Stock
  stock_adjustment_requested: "Ajuste de stock pedido",
  stock_adjustment_approved: "Ajuste de stock aprobado",
  stock_adjustment_rejected: "Ajuste de stock rechazado",
  stock_adjustment_applied: "Ajuste de stock aplicado",
  stock_adjustment_cancelled: "Ajuste de stock cancelado",
  stock_adjustment_policy_updated: "Reglas de ajuste de stock editadas",
  stock_reservation_created: "Reserva de stock creada",
  stock_reservation_cancelled: "Reserva de stock cancelada",
  stock_reservation_pickup_failed: "Retiro de reserva fallido",
  cycle_count_applied: "Conteo cíclico aplicado",
  cycle_count_policy_updated: "Reglas de conteo cíclico editadas",
  warehouse_principal_created: "Depósito principal creado",
  warehouse_move_cancelled: "Movimiento entre depósitos cancelado",
  // Impuestos
  tax_settings_changed: "Configuración de impuestos cambiada",
  tax_custom_deleted: "Impuesto personalizado eliminado",
  tax_custom_reset: "Impuesto personalizado restablecido",
  tax_padron_manual_set: "Padrón cargado a mano",
  tax_padron_deleted: "Padrón eliminado",
  tax_withholdings_issued: "Retenciones emitidas",
  tax_withholdings_voided: "Retenciones anuladas",
  iibb_liquidation_voided: "Liquidación de IIBB anulada",
  // Tesorería
  treasury_movement_created: "Movimiento de tesorería cargado",
  treasury_movement_voided: "Movimiento de tesorería anulado",
  // Plataforma y plan
  tenant_created: "Alta del negocio (registro propio)",
  tenant_created_internal: "Alta manual del negocio desde el panel interno",
  tenant_suspended: "Negocio suspendido",
  tenant_reactivated: "Negocio reactivado",
  tenant_deleted: "Negocio dado de baja",
  status_changed: "Estado de la suscripción cambiado",
  trial_extended: "Prueba extendida",
  trial_end_set: "Fin de la prueba ajustado",
  dunning_past_due: "Pago vencido (cobranza automática)",
  dunning_suspended: "Suspendido por falta de pago",
  dunning_trial_expired: "Prueba vencida",
  subscription_reactivated: "Suscripción reactivada",
  account_closure_requested: "El dueño pidió la baja",
  access_granted: "Acceso otorgado con código",
  plan_changed: "Plan cambiado",
  plan_change_requested: "El dueño pidió cambio de plan",
  custom_plan_created: "Plan a medida creado",
  custom_plan_updated: "Plan a medida editado",
  limit_override_set: "Límite del plan ajustado",
  limit_overrides_set: "Límites del plan ajustados",
  addon_granted: "Complemento regalado",
  addon_revoked: "Complemento quitado",
  addon_set: "Complemento modificado",
  addon_activated: "Complemento activado",
  addon_ai_cancelled: "Asistente IA cancelado",
  addon_tier_applied: "Escalón del complemento aplicado",
  payment_recorded: "Pago registrado",
  impersonation_link_generated: "Acceso como el negocio (link de un uso)",
  impersonation_started: "Acceso como el negocio iniciado",
  impersonation_ended: "Acceso como el negocio cerrado",
  flag_changed: "Función del negocio cambiada",
  industry_changed: "Rubro cambiado",
  industry_preset_applied: "Preset de rubro aplicado",
  business_profile_applied: "Perfil de negocio aplicado",
  invite_code_created: "Código de invitación creado",
  invite_code_deleted: "Código de invitación eliminado",
  invite_code_redeemed: "Código de invitación canjeado",
  tenant_smtp_updated: "Correo saliente editado",
  config_override_set: "Configuración de sucursal cambiada",
  config_override_cleared: "Configuración de sucursal restablecida",
  store_logo_updated: "Logo de la sucursal cambiado",
  api_client_created: "Cliente de la API creado",
  api_client_updated: "Cliente de la API editado",
  api_client_revoked: "Cliente de la API revocado",
  api_token_issued: "Token de la API emitido",
  api_docs_emailed: "Documentación de la API enviada por email",
  api_docs_email_failed: "Envío de la documentación de la API fallido",
  mp_refund_requested: "Devolución de Mercado Pago pedida",
  mp_refund_approved: "Devolución de Mercado Pago aprobada",
  mp_refund_failed: "Devolución de Mercado Pago fallida",
  mp_refunds_enabled: "Devoluciones de Mercado Pago activadas",
  mp_refunds_disabled: "Devoluciones de Mercado Pago desactivadas",
  ml_sale_ingested: "Venta de Mercado Libre recibida",
  ml_sale_cancelled: "Venta de Mercado Libre cancelada",
};

// Sustantivo para acciones "<algo>_<verbo>" que no están en NAMED.
const ACTION_NOUNS: Record<string, EntityDef> = {
  collection_item: { one: "Ítem de cobranza", g: "m" },
  payment_fee_rule: { one: "Regla de comisión de cobro", g: "f" },
  service_type: { one: "Tipo de servicio", g: "m" },
  service_clarification: { one: "Aclaración de servicio", g: "f" },
  staff_expense: { one: "Gasto del personal", g: "m" },
  staff_bank_account: { one: "Cuenta bancaria del personal", g: "f" },
  staff_payment: { one: "Pago al personal", g: "m" },
  staff_adjustment: { one: "Ajuste del personal", g: "m" },
  warranty_plan: { one: "Plan de garantía", g: "m" },
  serial_claim: { one: "Reclamo de garantía", g: "m" },
  email_addon_tier: { one: "Escalón del email", g: "m" },
  platform_bank_account: { one: "Cuenta bancaria de la plataforma", g: "f" },
  platform_charge: { one: "Cargo de la plataforma", g: "m" },
  platform_promise: { one: "Promesa de pago", g: "f" },
  pending_charge: { one: "Cargo pendiente", g: "m" },
  payment_dispute: { one: "Contracargo", g: "m" },
  payment_voucher: { one: "Comprobante de pago", g: "m" },
  acc_account: { one: "Cuenta contable", g: "f" },
  acc_period: { one: "Período contable", g: "m" },
  ml_full_inbound: { one: "Envío a Full", g: "m" },
  catalog_sync: { one: "Sincronización del catálogo", g: "f" },
  store_template: { one: "Plantilla de sucursal", g: "f" },
  onboarding_tour: { one: "Recorrido guiado", g: "m" },
  onboarding_nudge: { one: "Aviso de puesta en marcha", g: "m" },
  delivery_channel: { one: "Canal de delivery", g: "m" },
  dispatch: { one: "Despacho", g: "m" },
  waitlist_entry: { one: "Lugar en lista de espera", g: "m" },
};

const VERB_SUFFIXES: Record<string, Record<Gender, string>> = {
  created: { m: "creado", f: "creada" },
  updated: { m: "editado", f: "editada" },
  deleted: { m: "eliminado", f: "eliminada" },
  voided: { m: "anulado", f: "anulada" },
  cancelled: { m: "cancelado", f: "cancelada" },
  approved: { m: "aprobado", f: "aprobada" },
  rejected: { m: "rechazado", f: "rechazada" },
  applied: { m: "aplicado", f: "aplicada" },
  requested: { m: "pedido", f: "pedida" },
  enabled: { m: "activado", f: "activada" },
  disabled: { m: "desactivado", f: "desactivada" },
  changed: { m: "cambiado", f: "cambiada" },
  set: { m: "configurado", f: "configurada" },
  cleared: { m: "borrado", f: "borrada" },
  granted: { m: "otorgado", f: "otorgada" },
  revoked: { m: "revocado", f: "revocada" },
  issued: { m: "emitido", f: "emitida" },
  opened: { m: "abierto", f: "abierta" },
  closed: { m: "cerrado", f: "cerrada" },
  failed: { m: "fallido", f: "fallida" },
  reopened: { m: "reabierto", f: "reabierta" },
};

// ── Campos ──────────────────────────────────────────────────────────────────

const FIELDS: Record<string, FieldDef> = {
  // General
  name: { label: "Nombre", section: "general" },
  display_name: { label: "Nombre", section: "general" },
  full_name: { label: "Nombre", section: "general" },
  short_name: { label: "Nombre corto", section: "general" },
  trade_name: { label: "Nombre de fantasía", section: "general" },
  razon_social: { label: "Razón social", section: "impuestos" },
  title: { label: "Título", section: "general" },
  label: { label: "Etiqueta", section: "general" },
  description: { label: "Descripción", section: "general" },
  sku: { label: "SKU", section: "general" },
  barcode: { label: "Código de barras", section: "general" },
  plu: { label: "PLU de balanza", section: "general" },
  code: { label: "Código", section: "general" },
  unit: { label: "Unidad de venta", section: "stock" },
  image_url: { label: "Imagen", section: "general" },
  logo_url: { label: "Logo", section: "general" },
  color: { label: "Color", section: "general" },
  notes: { label: "Notas", section: "general" },
  note: { label: "Nota", section: "general" },
  with_secret: { label: "Con clave secreta", section: "general" },
  attachments: { label: "Adjuntos", section: "general" },
  phone: { label: "Teléfono", section: "general" },
  email: { label: "Email", section: "general" },
  address: { label: "Dirección", section: "general" },
  document_type: { label: "Tipo de documento", section: "general" },
  document_number: { label: "Número de documento", section: "general" },
  birth_date: { label: "Fecha de nacimiento", section: "general", kind: "date" },
  sale_number: { label: "Número de venta", section: "general" },
  number: { label: "Número", section: "general" },
  kind: { label: "Tipo", section: "general" },
  type: { label: "Tipo", section: "general" },
  method: { label: "Medio de pago", section: "precios" },
  installments: { label: "Cuotas", section: "precios", kind: "number" },
  reason: { label: "Motivo", section: "general" },
  source: { label: "Origen", section: "general" },
  channel: { label: "Canal", section: "general" },
  station: { label: "Estación de cocina", section: "general" },
  sort: { label: "Orden", section: "config", kind: "number" },
  sort_order: { label: "Orden", section: "config", kind: "number" },
  // Precios y costos
  price: { label: "Precio de venta", section: "precios", kind: "money" },
  min_price: { label: "Precio mínimo", section: "precios", kind: "money" },
  cost: { label: "Costo", section: "precios", kind: "money" },
  cost_currency: { label: "Moneda del costo", section: "precios" },
  cost_usd: { label: "Costo en dólares", section: "precios", kind: "usd" },
  cost_fx_rate: { label: "Cotización del costo", section: "precios", kind: "money" },
  cost_fx_date: { label: "Fecha de la cotización", section: "precios", kind: "date" },
  cost_fx_source: { label: "Fuente de la cotización", section: "precios" },
  cost_extras: { label: "Costos adicionales", section: "precios" },
  cost_updated_at: { label: "Costo actualizado el", section: "precios", kind: "datetime" },
  final_cost: { label: "Costo final", section: "precios", kind: "money" },
  last_cost: { label: "Último costo", section: "precios", kind: "money" },
  avg_cost: { label: "Costo promedio", section: "precios", kind: "money" },
  replacement_cost: { label: "Costo de reposición", section: "precios", kind: "money" },
  markup_pct: { label: "Margen", section: "precios", kind: "pct" },
  markup_mode: { label: "Cómo se calcula el precio", section: "precios" },
  commission_pct: { label: "Comisión", section: "precios", kind: "pct" },
  adjustment_pct: { label: "Ajuste", section: "precios", kind: "pct" },
  discount_percent: { label: "Descuento", section: "precios", kind: "pct" },
  total: { label: "Total", section: "precios", kind: "money" },
  subtotal: { label: "Subtotal", section: "precios", kind: "money" },
  discount: { label: "Descuento", section: "precios", kind: "money" },
  amount: { label: "Monto", section: "precios", kind: "money" },
  credit_limit: { label: "Límite de crédito", section: "precios", kind: "money" },
  credit_status: { label: "Estado del crédito", section: "estado" },
  monthly_price_ars: { label: "Precio mensual", section: "precios", kind: "money" },
  opening_amount: { label: "Monto de apertura", section: "precios", kind: "money" },
  closing_amount: { label: "Monto de cierre", section: "precios", kind: "money" },
  expected_amount: { label: "Monto esperado", section: "precios", kind: "money" },
  difference: { label: "Diferencia", section: "precios", kind: "money" },
  // Impuestos y facturación
  tax_rate: { label: "Alícuota de IVA", section: "impuestos", kind: "pct" },
  tax_rate_code: { label: "Código de IVA", section: "impuestos" },
  iva_rate: { label: "Alícuota de IVA", section: "impuestos", kind: "pct" },
  iva_condition: { label: "Condición frente al IVA", section: "impuestos" },
  cuit: { label: "CUIT", section: "impuestos" },
  internal_tax_mode: { label: "Impuestos internos", section: "impuestos" },
  internal_tax_rate: { label: "Alícuota de impuestos internos", section: "impuestos", kind: "pct" },
  internal_tax_amount: { label: "Monto de impuestos internos", section: "impuestos", kind: "money" },
  internal_tax_base: { label: "Base de impuestos internos", section: "impuestos" },
  internal_tax_included: { label: "Impuestos internos incluidos en el precio", section: "impuestos" },
  cbte_letter: { label: "Letra del comprobante", section: "impuestos" },
  letter: { label: "Letra del comprobante", section: "impuestos" },
  pto_vta: { label: "Punto de venta", section: "impuestos" },
  ticket_mode: { label: "Comprobante por defecto", section: "impuestos" },
  environment: { label: "Ambiente de ARCA", section: "impuestos" },
  non_fiscal: { label: "Sin factura (sólo ticket)", section: "impuestos" },
  // Stock
  stock: { label: "Stock", section: "stock", kind: "number" },
  stock_min: { label: "Stock mínimo", section: "stock", kind: "number" },
  qty: { label: "Cantidad", section: "stock", kind: "number" },
  quantity: { label: "Cantidad", section: "stock", kind: "number" },
  delta: { label: "Diferencia", section: "stock", kind: "number" },
  track_stock: { label: "Controla stock", section: "stock" },
  allow_negative: { label: "Permite vender sin stock", section: "stock" },
  net_content: { label: "Contenido neto", section: "stock", kind: "number" },
  net_content_unit: { label: "Unidad del contenido neto", section: "stock" },
  is_serialized: { label: "Lleva número de serie", section: "stock" },
  warranty_months: { label: "Garantía (meses)", section: "general", kind: "number" },
  // Clasificación
  category_id: { label: "Categoría", section: "clasificacion", ref: "category" },
  brand_id: { label: "Marca", section: "clasificacion", ref: "brand" },
  supplier_id: { label: "Proveedor", section: "clasificacion", ref: "supplier" },
  group_id: { label: "Grupo", section: "clasificacion", ref: "customer_group" },
  price_list_id: { label: "Lista de precios", section: "precios", ref: "price_list" },
  list_id: { label: "Lista de precios", section: "precios", ref: "price_list" },
  product_id: { label: "Producto", section: "general", ref: "product" },
  model: { label: "Modelo", section: "clasificacion" },
  season: { label: "Temporada", section: "clasificacion" },
  tags: { label: "Etiquetas", section: "clasificacion" },
  attributes: { label: "Atributos", section: "clasificacion" },
  has_variants: { label: "Tiene variantes", section: "clasificacion" },
  variant_axes: { label: "Ejes de variantes", section: "clasificacion" },
  is_kit: { label: "Es combo", section: "clasificacion" },
  is_service: { label: "Es un servicio", section: "clasificacion" },
  service_duration_min: { label: "Duración del servicio (min)", section: "clasificacion", kind: "number" },
  from_preset: { label: "Cargado desde un preset", section: "clasificacion" },
  // Personas
  customer_id: { label: "Cliente", section: "personas", ref: "customer" },
  user_id: { label: "Usuario", section: "personas", ref: "user" },
  collector_user_id: { label: "Cobrador", section: "personas", ref: "user" },
  waiter_user_id: { label: "Mozo", section: "personas", ref: "user" },
  supervisor_id: { label: "Supervisor", section: "personas", ref: "user" },
  authorized_by: { label: "Autorizó", section: "personas", ref: "user" },
  requested_by: { label: "Pidió", section: "personas", ref: "user" },
  verified_by: { label: "Verificó", section: "personas", ref: "user" },
  cashier_profile_id: { label: "Perfil de cajero", section: "personas", ref: "cashier_profile" },
  role: { label: "Rol", section: "personas" },
  role_name: { label: "Rol", section: "personas" },
  customer_name: { label: "Cliente", section: "personas" },
  // Sucursal y caja
  store_id: { label: "Sucursal", section: "ubicacion", ref: "store" },
  origin_store_id: { label: "Sucursal de origen", section: "ubicacion", ref: "store" },
  fulfillment_store_id: { label: "Sucursal que entrega", section: "ubicacion", ref: "store" },
  warehouse_id: { label: "Depósito", section: "ubicacion", ref: "warehouse" },
  register_id: { label: "Caja", section: "ubicacion", ref: "register" },
  cash_register_id: { label: "Caja", section: "ubicacion", ref: "register" },
  allowed_branch_ids: { label: "Sucursales habilitadas", section: "ubicacion", ref: "store" },
  is_default: { label: "Principal", section: "ubicacion" },
  // Estado
  is_active: { label: "Activo", section: "estado" },
  active: { label: "Activo", section: "estado" },
  enabled: { label: "Activado", section: "estado" },
  status: { label: "Estado", section: "estado" },
  deleted_at: { label: "Dado de baja el", section: "estado", kind: "datetime" },
  suspended_at: { label: "Suspendido el", section: "estado", kind: "datetime" },
  cancel_at_period_end: { label: "Se cancela al fin del período", section: "estado" },
  // Fechas
  opened_at: { label: "Abierto el", section: "fechas", kind: "datetime" },
  closed_at: { label: "Cerrado el", section: "fechas", kind: "datetime" },
  expires_at: { label: "Vence el", section: "fechas", kind: "datetime" },
  starts_at: { label: "Empieza el", section: "fechas", kind: "datetime" },
  trial_ends_at: { label: "Fin de la prueba", section: "fechas", kind: "datetime" },
  current_period_start: { label: "Inicio del período", section: "fechas", kind: "datetime" },
  current_period_end: { label: "Fin del período", section: "fechas", kind: "datetime" },
  valid_from: { label: "Vigente desde", section: "fechas", kind: "date" },
  due_date: { label: "Vencimiento", section: "fechas", kind: "date" },
  // Varios
  metadata: { label: "Datos adicionales", section: "otros" },
  settings: { label: "Configuración", section: "config" },
  limits: { label: "Límites", section: "config" },
  modules: { label: "Funciones", section: "config" },
  warnings: { label: "Advertencias", section: "otros" },
  plan: { label: "Plan", section: "config" },
  from: { label: "Antes", section: "general" },
  to: { label: "Después", section: "general" },
};

/** Claves técnicas que nunca se listan (siguen en "Ver datos técnicos"). */
const HIDDEN = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "intent_id",
  "hash",
  "row_hash",
  "prev_hash",
  "chain_hash",
  "seq",
  "search_vector",
  "fts",
  "pin_hash",
  "secret",
]);

// Valores de enumeraciones frecuentes, por clave.
const VALUE_LABELS: Record<string, Record<string, string>> = {
  status: {
    active: "Activo",
    inactive: "Inactivo",
    suspended: "Suspendido",
    pending: "Pendiente",
    paid: "Pagada",
    completed: "Completada",
    voided: "Anulada",
    void: "Anulada",
    cancelled: "Cancelado",
    canceled: "Cancelado",
    open: "Abierto",
    closed: "Cerrado",
    draft: "Borrador",
    approved: "Aprobado",
    rejected: "Rechazado",
    trialing: "En prueba",
    past_due: "Pago vencido",
    invited: "Invitado",
    terminated: "Dado de baja",
    on_leave: "De licencia",
  },
  role: {
    owner: "Dueño",
    admin: "Administrador",
    manager: "Encargado",
    supervisor: "Supervisor",
    cashier: "Cajero",
    seller: "Vendedor",
    waiter: "Mozo",
    viewer: "Sólo lectura",
    accountant: "Contador",
  },
  unit: {
    un: "Unidad",
    unit: "Unidad",
    kg: "Kilo",
    g: "Gramo",
    l: "Litro",
    lt: "Litro",
    ml: "Mililitro",
    m: "Metro",
    cm: "Centímetro",
    cm3: "Centímetro cúbico",
  },
  ticket_mode: { factura: "Factura", preguntar: "Preguntar en cada venta", ticket: "Sólo ticket" },
  environment: {
    homologacion: "Prueba",
    homo: "Prueba",
    testing: "Prueba",
    produccion: "Real",
    prod: "Real",
    production: "Real",
  },
  cost_currency: { ARS: "Pesos", USD: "Dólares" },
  iva_condition: {
    responsable_inscripto: "Responsable inscripto",
    monotributo: "Monotributo",
    exento: "Exento",
    consumidor_final: "Consumidor final",
    no_responsable: "No responsable",
  },
  method: {
    cash: "Efectivo",
    efectivo: "Efectivo",
    card: "Tarjeta",
    debit: "Débito",
    credit: "Crédito",
    transfer: "Transferencia",
    mercadopago: "Mercado Pago",
    account: "Cuenta corriente",
    qr: "QR",
  },
};
VALUE_LABELS.net_content_unit = VALUE_LABELS.unit!;

// ── Utilidades ──────────────────────────────────────────────────────────────

export function humanize(s: string): string {
  const t = s.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return isPlainObject(v) ? v : null;
}

/** null, undefined, "", espacios, [] y {} cuentan como "sin dato". */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => !isEmptyValue(v[k]))
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Forma canónica para comparar: vacíos equivalentes, "100.00" = 100. */
function canonical(v: unknown): string {
  if (isEmptyValue(v)) return "∅";
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^-?\d+(\.\d+)?$/.test(t)) return `n:${Number(t)}`;
    if (DATETIME_RE.test(t)) {
      const ms = Date.parse(t);
      if (!Number.isNaN(ms)) return `d:${ms}`;
    }
    return `s:${t}`;
  }
  return stable(v);
}

/** ¿Son el mismo valor para una persona? */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function fieldDef(key: string): FieldDef | undefined {
  return FIELDS[key];
}

function refKindFor(key: string, entityType: string): RefKind | undefined {
  const def = fieldDef(key);
  if (def?.ref) return def.ref;
  if (key === "parent_id" && entityType === "categories") return "category";
  if (/(^|_)store_id$/.test(key) || /_store_ids?$/.test(key)) return "store";
  if (/(^|_)warehouse_id$/.test(key)) return "warehouse";
  if (/_user_id$/.test(key)) return "user";
  return undefined;
}

function inferKind(key: string, value: unknown): ValueKind {
  const def = fieldDef(key);
  if (def?.kind) return def.kind;
  if (typeof value === "boolean") return "bool";
  if (/_cents$/.test(key)) return "money_cents";
  if (/_usd$/.test(key)) return "usd";
  if (/(_pct|_percent|percent)$/.test(key)) return "pct";
  if (typeof value === "string") {
    if (/(_at|_until)$/.test(key) && DATETIME_RE.test(value)) return "datetime";
    if (/(_date|_on|^date)$/.test(key) || DATE_ONLY_RE.test(value)) {
      return DATETIME_RE.test(value) ? "datetime" : DATE_ONLY_RE.test(value) ? "date" : "text";
    }
  }
  const numeric = typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()));
  if (
    numeric &&
    /(^|_)(price|cost|total|subtotal|amount|balance|fee|tip|monto|importe|paid|debt)(_|$)/.test(key) &&
    !/(pct|rate|currency|mode|source|count|qty|days|months|_id)/.test(key)
  ) {
    return "money";
  }
  if (numeric) return "number";
  if (Array.isArray(value) || isPlainObject(value)) return "json";
  return "text";
}

// ── Formateo ────────────────────────────────────────────────────────────────

const TZ = "America/Argentina/Buenos_Aires";
const ars = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 });
const usd = new Intl.NumberFormat("es-AR", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const num = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 });
const dateTimeFmt = new Intl.DateTimeFormat("es-AR", {
  timeZone: TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

export function formatMoneyARS(n: number): string {
  return ars.format(n);
}

/** Fecha y hora argentina: "15/10/2026 14:30". */
export function formatDateTimeAR(v: string | Date): string {
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return dateTimeFmt.format(d).replace(",", "");
}

/** Fecha argentina "15/10/2026". Una fecha sola (YYYY-MM-DD) no se corre de día. */
export function formatDateAR(v: string): string {
  if (DATE_ONLY_RE.test(v)) {
    const [y, m, d] = v.split("-");
    return `${d}/${m}/${y}`;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dateFmt.format(d);
}

function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

function formatScalar(key: string, v: unknown, kind: ValueKind): string {
  if (typeof v === "boolean") return v ? "Sí" : "No";
  const n = toNumber(v);
  switch (kind) {
    case "money":
      return n === null ? String(v) : ars.format(n);
    case "money_cents":
      return n === null ? String(v) : ars.format(n / 100);
    case "usd":
      return n === null ? String(v) : usd.format(n);
    case "pct":
      return n === null ? String(v) : `${num.format(n)} %`;
    case "number":
      return n === null ? String(v) : num.format(n);
    case "date":
      return typeof v === "string" ? formatDateAR(v) : String(v);
    case "datetime":
      return typeof v === "string" ? formatDateTimeAR(v) : String(v);
    default:
      break;
  }
  if (typeof v === "string") {
    const labels = VALUE_LABELS[key];
    if (labels && labels[v]) return labels[v]!;
    return v;
  }
  return String(v);
}

/** Valor legible de un campo. null = sin dato. */
export function formatAuditValue(
  key: string,
  v: unknown,
  opts: { entityType?: string; names?: NameLookup } = {},
): string | null {
  if (isEmptyValue(v)) return null;
  const ref = refKindFor(key, opts.entityType ?? "");
  const resolve = (id: unknown) => {
    if (typeof id !== "string") return String(id);
    if (!ref) return UUID_RE.test(id) ? shortId(id) : id;
    return opts.names?.(ref, id) || shortId(id);
  };
  if (ref) return Array.isArray(v) ? v.map(resolve).join(", ") : resolve(v);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
      return v.map((x) => formatScalar(key, x, inferKind(key, x))).join(", ");
    }
    return `${v.length} ${v.length === 1 ? "elemento" : "elementos"}`;
  }
  if (isPlainObject(v)) return JSON.stringify(v);
  return formatScalar(key, v, inferKind(key, v));
}

/** Etiqueta en español de un campo (con respaldo humanizado). */
export function fieldLabel(key: string): string {
  const parts = key.split(".");
  return parts.map((p) => fieldDef(p)?.label ?? humanize(p.replace(/_ids?$/, ""))).join(" › ");
}

function sectionFor(key: string): SectionKey {
  const top = key.split(".")[0]!;
  const def = fieldDef(top);
  if (def?.section) return def.section;
  if (/(price|cost|total|amount|_cents|discount|balance|fee|tip|markup|commission)/.test(top)) return "precios";
  if (/(tax|iva|arca|cuit|cbte|fiscal|invoice)/.test(top)) return "impuestos";
  if (/(stock|qty|quantity|warehouse)/.test(top)) return "stock";
  if (/(store|register|branch)/.test(top)) return "ubicacion";
  if (/(customer|user|cashier|staff|seller|supervisor)/.test(top)) return "personas";
  if (/^(is_|has_)|status|enabled|active/.test(top)) return "estado";
  if (/(_at|_date|_until|_on)$/.test(top)) return "fechas";
  if (/(settings|config|policy|limits|mode)/.test(top)) return "config";
  return "general";
}

function isHidden(key: string, value: unknown, entityType: string): boolean {
  const leaf = key.split(".").pop()!;
  if (HIDDEN.has(leaf)) return true;
  if (/(_hash|_tsv|_secret|_token)$/.test(leaf) || /^search_/.test(leaf)) return true;
  // Ids técnicos sin nombre que resolver: fuera de la lista (siguen en el JSON).
  if (/_ids?$/.test(leaf) && !refKindFor(leaf, entityType)) return true;
  if (typeof value === "string" && UUID_RE.test(value) && !refKindFor(leaf, entityType)) return true;
  return false;
}

// Objetos que se comparan por dentro (un nivel) en vez de como bloque.
function shouldFlatten(key: string, b: unknown, a: unknown): boolean {
  if (fieldDef(key)?.ref) return false;
  const bo = isPlainObject(b) || isEmptyValue(b);
  const ao = isPlainObject(a) || isEmptyValue(a);
  return bo && ao && (isPlainObject(b) || isPlainObject(a));
}

interface RawPair {
  key: string;
  before: unknown;
  after: unknown;
}

function collectPairs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  depth: number,
): RawPair[] {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const out: RawPair[] = [];
  for (const k of keys) {
    const b = before[k];
    const a = after[k];
    const key = prefix ? `${prefix}.${k}` : k;
    if (depth < 2 && shouldFlatten(k, b, a)) {
      out.push(...collectPairs(asRecord(b) ?? {}, asRecord(a) ?? {}, key, depth + 1));
    } else {
      out.push({ key, before: b, after: a });
    }
  }
  return out;
}

// ── Título ──────────────────────────────────────────────────────────────────

const SUBJECT_KEYS = ["name", "display_name", "full_name", "title", "label", "trade_name", "razon_social", "customer_name", "email"];

function subjectOf(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string | null {
  for (const src of [after, before]) {
    if (!src) continue;
    for (const k of SUBJECT_KEYS) {
      const v = src[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    for (const k of ["sale_number", "number", "receipt_no", "return_number"]) {
      const v = src[k];
      if ((typeof v === "string" && v.trim()) || typeof v === "number") return `N° ${v}`;
    }
  }
  return null;
}

function crudKind(action: string): "insert" | "update" | "delete" | null {
  const a = action.toLowerCase();
  if (a === "insert" || a === "create") return "insert";
  if (a === "update" || a === "edit") return "update";
  if (a === "delete") return "delete";
  return null;
}

function headlineFor(
  entityType: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string {
  const named = NAMED[action] ?? NAMED[action.toLowerCase()];
  if (named) return named;

  const crud = crudKind(action);
  const ent = ENTITIES[entityType] ?? { one: humanize(entityType), g: "m" as Gender };
  if (crud) {
    let verb: keyof typeof PARTICIPLES = crud;
    if (crud === "update" && before && after) {
      if (isEmptyValue(before.deleted_at) && !isEmptyValue(after.deleted_at)) verb = "soft_delete";
      else if (!isEmptyValue(before.deleted_at) && isEmptyValue(after.deleted_at)) verb = "restore";
      else if (before.is_active === true && after.is_active === false) verb = "deactivate";
      else if (before.is_active === false && after.is_active === true) verb = "activate";
    }
    return `${ent.one} ${PARTICIPLES[verb]![ent.g]}`;
  }

  // "<sustantivo>_<verbo>": stock_adjustment_approved, staff_expense_created...
  const m = /^(.*)_([a-z]+)$/.exec(action.toLowerCase());
  if (m) {
    const [, noun, verb] = m;
    const participle = VERB_SUFFIXES[verb!];
    const nounDef = ACTION_NOUNS[noun!] ?? ENTITIES[noun!] ?? ENTITIES[`${noun}s`];
    if (participle && nounDef) return `${nounDef.one} ${participle[nounDef.g]}`;
  }
  return humanize(action);
}

/** Tono del evento: rojo para lo sensible (PIN fallido, bajas, anulaciones). */
export function auditEventTone(action: string): AuditTone {
  const a = action.toLowerCase();
  if (/failed|locked|force_closed|force_close|terminated|delete|void/.test(a)) return "danger";
  if (/supervisor|override|suspended|security_settings|ticket_only/.test(a)) return "warning";
  if (/insert|create|invited|rehired|set$/.test(a)) return "info";
  return "neutral";
}

// ── API principal ───────────────────────────────────────────────────────────

/** Arma la vista legible de un evento de auditoría. */
export function presentAuditEvent(e: AuditEventLike, names?: NameLookup): PresentedAudit {
  const before = asRecord(e.before_data);
  const after = asRecord(e.after_data);
  const subject = subjectOf(before, after);
  const headline = headlineFor(e.entity_type, e.action, before, after);
  const title = subject && !headline.includes(subject) ? `${headline}: ${subject}` : headline;
  const crud = crudKind(e.action);

  let mode: PresentedAudit["mode"] = "none";
  let listTitle = "";
  let pairs: RawPair[] = [];
  if (before && after) {
    mode = "changes";
    listTitle = "Qué cambió";
    pairs = collectPairs(before, after, "", 0).filter((p) => !sameValue(p.before, p.after));
  } else if (after || before) {
    mode = "snapshot";
    listTitle = crud === "insert" ? "Datos cargados" : crud === "delete" ? "Datos al eliminar" : "Detalle";
    pairs = collectPairs({}, after ?? before ?? {}, "", 0)
      .map((p) => ({ key: p.key, before: undefined, after: p.after }))
      .filter((p) => !isEmptyValue(p.after));
  }

  const opts = { entityType: e.entity_type, names };
  const bySection = new Map<SectionKey, PresentedField[]>();
  for (const p of pairs) {
    if (isHidden(p.key, p.after ?? p.before, e.entity_type)) continue;
    const leaf = p.key.split(".").pop()!;
    const field: PresentedField = {
      key: p.key,
      label: fieldLabel(p.key),
      before: mode === "changes" ? formatAuditValue(leaf, p.before, opts) : null,
      after: formatAuditValue(leaf, p.after, opts),
    };
    // Dos valores distintos que se ven igual (p. ej. redondeo) no aportan.
    if (mode === "changes" && field.before === field.after) continue;
    const s = sectionFor(p.key);
    if (!bySection.has(s)) bySection.set(s, []);
    bySection.get(s)!.push(field);
  }
  const sections: PresentedSection[] = SECTION_ORDER.filter((s) => bySection.has(s)).map((s) => ({
    key: s,
    title: SECTION_TITLES[s],
    fields: bySection.get(s)!,
  }));
  const fieldCount = sections.reduce((n, s) => n + s.fields.length, 0);

  return {
    title,
    headline,
    entityLabel: entityLabel(e.entity_type),
    subject,
    mode,
    listTitle,
    sections,
    fieldCount,
    tone: auditEventTone(e.action),
  };
}

/** Ids a resolver (por tipo) en un conjunto de eventos, para pedirlos en lote. */
export function collectAuditRefs(events: AuditEventLike[]): Partial<Record<RefKind, string[]>> {
  const acc = new Map<RefKind, Set<string>>();
  const add = (kind: RefKind, v: unknown) => {
    if (typeof v !== "string" || !UUID_RE.test(v)) return;
    if (!acc.has(kind)) acc.set(kind, new Set());
    acc.get(kind)!.add(v);
  };
  for (const e of events) {
    for (const src of [asRecord(e.before_data), asRecord(e.after_data)]) {
      if (!src) continue;
      for (const [k, v] of Object.entries(src)) {
        const kind = refKindFor(k, e.entity_type);
        if (!kind) continue;
        if (Array.isArray(v)) v.forEach((x) => add(kind, x));
        else add(kind, v);
      }
    }
  }
  const out: Partial<Record<RefKind, string[]>> = {};
  for (const [k, set] of acc) out[k] = Array.from(set).sort();
  return out;
}
