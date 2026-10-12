// Imputación de cobros de cuenta corriente (Cuenta corriente v2).
//
// ESPEJO del SQL: account_collect() en
// supabase/migrations/20261011180000_cuenta_corriente_v2.sql.
//
// Orden por defecto: punitorios (interés) más viejos primero; después cargos por
// vencimiento (FIFO por due_date, desempate por fecha de alta e id). Si el
// cajero elige la imputación, se respeta y el resto del cobro se imputa con el
// orden por defecto. Lo que sobra después de cancelar todo queda como saldo a
// favor (anticipo, `unapplied`). Todo se calcula en centavos.

export interface OpenItem {
  id: string;
  kind: "charge" | "interest";
  due_date: string | null;
  created_at: string;
  open: number;
}

export interface Allocation {
  id: string;
  amount: number;
}

const cents = (x: number) => Math.round(x * 100);

function cmp(a: string | null, b: string | null): number {
  const x = a ?? "9999-12-31";
  const y = b ?? "9999-12-31";
  return x < y ? -1 : x > y ? 1 : 0;
}

export function defaultOrder<T extends OpenItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "interest" ? -1 : 1;
    if (a.kind === "interest") return cmp(a.created_at, b.created_at) || cmp(a.id, b.id);
    return cmp(a.due_date, b.due_date) || cmp(a.created_at, b.created_at) || cmp(a.id, b.id);
  });
}

export function allocatePayment(
  items: OpenItem[],
  amount: number,
  chosen?: Allocation[] | null,
): { allocations: Allocation[]; unapplied: number } {
  let left = cents(amount);
  if (!(left > 0)) throw new Error("invalid_amount");

  const open = new Map(items.map((i) => [i.id, cents(i.open)]));
  const out: Allocation[] = [];

  for (const c of chosen ?? []) {
    const want = cents(c.amount);
    if (want <= 0) continue;
    const avail = open.get(c.id);
    if (avail === undefined) throw new Error("allocation_unknown_item");
    if (want > avail) throw new Error("allocation_exceeds_open");
    if (want > left) throw new Error("allocation_exceeds_payment");
    open.set(c.id, avail - want);
    left -= want;
    out.push({ id: c.id, amount: want / 100 });
  }

  for (const it of defaultOrder(items)) {
    if (left <= 0) break;
    const avail = open.get(it.id) ?? 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, left);
    open.set(it.id, avail - take);
    left -= take;
    const prev = out.find((o) => o.id === it.id);
    if (prev) prev.amount = (cents(prev.amount) + take) / 100;
    else out.push({ id: it.id, amount: take / 100 });
  }

  return { allocations: out, unapplied: left / 100 };
}
