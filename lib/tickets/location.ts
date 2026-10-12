// Sucursal y caja en el ticket (F17 · H90). PURO.
// Con una sola sucursal viva el ticket no cambia (no se muestra nada); con 2+
// sale "Sucursal Centro · Caja 1". La sucursal es la de la VENTA (no la del
// dispositivo que reimprime) y la caja, la del turno en que se cobró.

export interface TicketLocation {
  branch: string | null;
  register: string | null;
}

interface BranchLike {
  id: string;
  name: string;
  deleted_at: string | null;
  registers: { id: string; name: string }[];
}

export function ticketLocation(
  branches: BranchLike[],
  storeId: string | null | undefined,
  registerId: string | null | undefined,
): TicketLocation | null {
  if (branches.filter((b) => !b.deleted_at).length < 2) return null;
  const store = storeId ? branches.find((b) => b.id === storeId) : undefined;
  const register = registerId
    ? branches.flatMap((b) => b.registers).find((r) => r.id === registerId)
    : undefined;
  if (!store && !register) return null;
  return { branch: store?.name ?? null, register: register?.name ?? null };
}

/** "Sucursal Centro · Caja 1" (null si no hay nada que mostrar). */
export function ticketLocationText(loc: TicketLocation | null | undefined): string | null {
  if (!loc) return null;
  const parts: string[] = [];
  if (loc.branch) parts.push(/^sucursal\b/i.test(loc.branch) ? loc.branch : `Sucursal ${loc.branch}`);
  if (loc.register) parts.push(loc.register);
  return parts.length > 0 ? parts.join(" · ") : null;
}
