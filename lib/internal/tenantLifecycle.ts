// Ciclo de vida del negocio en el panel interno (F7 · H11c, ADR-073).
// Espejo puro de internal_tenant_lifecycle: qué acciones se ofrecen según el
// estado y el nivel de staff. El servidor vuelve a validar todo.

export type LifecycleAction = "suspend" | "reactivate" | "delete";
export type LifecycleState = "operating" | "suspended" | "cancelled" | "deleted";
export type StaffLevel = "super_admin" | "admin" | "support" | null;

export function lifecycleState(t: {
  status: string;
  subStatus?: string | null;
  deletedAt?: string | null;
}): LifecycleState {
  if (t.deletedAt) return "deleted";
  const st = t.status;
  if (st === "suspended") return "suspended";
  if (st === "cancelled") return "cancelled";
  return "operating";
}

/** Acciones de ciclo de vida disponibles. Soporte no tiene ninguna. */
export function lifecycleActions(state: LifecycleState, level: StaffLevel): LifecycleAction[] {
  // Sin nivel guardado: interno legacy, se trata como admin (igual que la RPC).
  const lv = level ?? "admin";
  if (lv === "support") return [];
  const out: LifecycleAction[] = [];
  if (state === "operating") out.push("suspend");
  if (state !== "operating") out.push("reactivate");
  if (state !== "deleted" && lv === "super_admin") out.push("delete");
  return out;
}

/** Estados que se eligen desde el selector (sin motivo). */
export const EDITABLE_STATUSES = [
  { key: "trial", name: "Trial" },
  { key: "active", name: "Activo" },
  { key: "past_due", name: "Pago pendiente" },
] as const;

export const LIFECYCLE_COPY: Record<
  LifecycleAction,
  { title: string; confirm: string; description: string; success: string }
> = {
  suspend: {
    title: "Suspender negocio",
    confirm: "Suspender",
    description:
      "El negocio deja de vender, abrir caja y hacer devoluciones al instante. Los datos quedan intactos y se puede reactivar.",
    success: "Negocio suspendido",
  },
  reactivate: {
    title: "Reactivar negocio",
    confirm: "Reactivar",
    description:
      "El negocio vuelve a operar con estado Activo. Si estaba dado de baja, se quita la baja.",
    success: "Negocio reactivado",
  },
  delete: {
    title: "Dar de baja el negocio",
    confirm: "Dar de baja",
    description:
      "Baja lógica: no se borra nada, el negocio queda cancelado y sin operar. Se puede revertir con Reactivar.",
    success: "Negocio dado de baja",
  },
};

const ERRORS: Record<string, string> = {
  reason_required: "El motivo tiene que tener al menos 5 caracteres.",
  reason_too_long: "El motivo es demasiado largo (máximo 500 caracteres).",
  invalid_transition: "El negocio ya cambió de estado. Recargá la página.",
  forbidden_super_admin_only: "Sólo un super admin puede dar de baja un negocio.",
  forbidden: "Tu nivel de staff no permite esta acción.",
  tenant_not_found: "No se encontró el negocio.",
  use_tenant_lifecycle: "Para suspender, cancelar o reactivar usá las acciones de ciclo de vida (piden motivo).",
};

/** Mensaje legible para un error de las RPC de administración de negocios. */
export function lifecycleErrorMessage(message: string | undefined | null): string {
  const m = message ?? "";
  // forbidden_super_admin_only contiene "forbidden": se busca la clave más larga primero.
  const key = Object.keys(ERRORS)
    .sort((a, b) => b.length - a.length)
    .find((k) => m.includes(k));
  return key ? ERRORS[key]! : m || "No se pudo completar la acción.";
}
