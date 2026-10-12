// Personal habilitado en una sucursal (F17 · H91). PURO.
// Espeja staff_allowed_store_ids (ADR-045) para filtrar, en el POS, los
// perfiles sin cuenta y las personas que se pueden elegir (vendedor de la
// venta) según la sucursal donde vende el dispositivo: cobertura exclusiva >
// base + adicionales > sin asignaciones (encargado = todas; cajero, solo
// lectura y perfiles sin cuenta = la principal). El dueño, en todas.
import { allowedStoreIds, type Branch, type StaffAssignment, type StaffRole } from "./logic";

type StoreLite = Pick<Branch, "id" | "is_default" | "deleted_at" | "created_at">;

export interface StaffScopePerson {
  userId: string | null;
  profileId: string | null;
  // null = perfil sin cuenta (opera como cajero).
  role: StaffRole | null;
}

export function personAllowedIn(
  person: StaffScopePerson,
  storeId: string,
  stores: StoreLite[],
  assignments: StaffAssignment[],
  today: string,
): boolean {
  const mine = assignments.filter((a) =>
    person.userId ? a.user_id === person.userId : a.cashier_profile_id === person.profileId,
  );
  return allowedStoreIds({
    role: person.role ?? "cashier",
    stores,
    assignments: mine,
    today,
  }).includes(storeId);
}

/**
 * Filtra una lista de personas a las habilitadas en la sucursal. Sin sucursal
 * (contexto todavía cargando) no filtra, para no dejar el selector vacío.
 */
export function staffForStore<T extends StaffScopePerson>(
  people: T[],
  storeId: string | null,
  stores: StoreLite[],
  assignments: StaffAssignment[],
  today: string,
): T[] {
  if (!storeId) return people;
  return people.filter((p) => personAllowedIn(p, storeId, stores, assignments, today));
}

/**
 * Vendedores (professionals) habilitados en la sucursal: los vinculados a un
 * usuario siguen el alcance de ese usuario; los que no tienen usuario no
 * tienen sucursal y se muestran siempre.
 */
export function professionalsForStore<T extends { user_id: string | null }>(
  list: T[],
  storeId: string | null,
  roles: Map<string, StaffRole>,
  stores: StoreLite[],
  assignments: StaffAssignment[],
  today: string,
): T[] {
  if (!storeId) return list;
  return list.filter((p) => {
    if (!p.user_id) return true;
    const role = roles.get(p.user_id);
    if (!role) return true;
    return personAllowedIn({ userId: p.user_id, profileId: null, role }, storeId, stores, assignments, today);
  });
}
