// Textos del visor de auditoría (F17 · H117, ADR-051). PURO.

const ACTIONS: Record<string, string> = {
  insert: "Alta",
  update: "Modificación",
  delete: "Baja",
  member_invited: "Invitó a un usuario",
  member_updated: "Editó un usuario",
  member_status_changed: "Cambió el estado de un usuario",
  profile_created: "Creó un perfil sin cuenta",
  profile_updated: "Editó un perfil sin cuenta",
  profile_status_changed: "Cambió el estado de un perfil",
  staff_suspended: "Suspendió a una persona",
  staff_leave_scheduled: "Cargó una licencia",
  staff_terminated: "Dio de baja a una persona",
  staff_termination_applied: "Se aplicó una baja programada",
  staff_status_cancelled: "Canceló un estado programado",
  staff_status_lifted: "Levantó una suspensión o licencia",
  staff_rehired: "Reincorporó a una persona",
  staff_branch_scheduled: "Asignó o trasladó de sucursal",
  staff_branch_cancelled: "Canceló un traslado",
  security_settings_changed: "Cambió la política de seguridad",
  supervisor_pin_set: "Cargó su PIN de supervisor",
  supervisor_pin_changed: "Cambió su PIN de supervisor",
  supervisor_pin_cleared: "Borró un PIN de supervisor",
  supervisor_pin_failed: "PIN de supervisor incorrecto",
  supervisor_pin_locked: "PIN de supervisor bloqueado",
  supervisor_authorized: "Supervisor autorizó con PIN",
  supervisor_override_used: "Se usó una autorización de supervisor",
  cash_shift_force_closed: "Cierre forzado de caja",
  account_override_authorized: "Autorizó venta a cuenta bloqueada",
  account_block_override: "Venta a cuenta con autorización",
  account_charge: "Venta a cuenta corriente",
  payments_reconciled: "Concilió cobros con tarjeta",
  payments_unreconciled: "Desconcilió cobros con tarjeta",
};

const ENTITIES: Record<string, string> = {
  sales: "Venta",
  sale_items: "Ítem de venta",
  payments: "Cobro",
  cash_shifts: "Turno de caja",
  cash_movements: "Movimiento de caja",
  cash_z_closures: "Cierre Z",
  products: "Producto",
  customers: "Cliente",
  stores: "Sucursal",
  cash_registers: "Caja",
  tenant_users: "Usuario",
  member: "Usuario",
  users: "Usuario",
  staff_status_events: "Estado del personal",
  staff_branch_assignments: "Sucursal del personal",
  security_settings: "Seguridad",
  stock_transfers: "Traslado",
  customer_groups: "Grupo de clientes",
};

export function auditActionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action]!;
  const t = action.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function auditEntityLabel(entity: string): string {
  return ENTITIES[entity] ?? entity.replace(/_/g, " ");
}

/** Tono del evento: rojo para lo sensible (PIN fallido, bajas, cierres forzados). */
export function auditTone(action: string): "danger" | "warning" | "info" | "neutral" {
  if (/failed|locked|force_closed|terminated|delete|void/.test(action)) return "danger";
  if (/supervisor|override|suspended|security_settings/.test(action)) return "warning";
  if (/insert|invited|rehired|set$/.test(action)) return "info";
  return "neutral";
}

export interface DiffRow {
  key: string;
  before: unknown;
  after: unknown;
  changed: boolean;
}

/** Diferencias campo a campo entre before_data y after_data. */
export function auditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): DiffRow[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const skip = new Set(["updated_at", "created_at"]);
  return [...keys]
    .filter((k) => !skip.has(k))
    .sort()
    .map((key) => {
      const b = before?.[key];
      const a = after?.[key];
      return { key, before: b, after: a, changed: JSON.stringify(b) !== JSON.stringify(a) };
    });
}

/** Valor legible de un campo del diff. */
export function auditValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "vacío";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
