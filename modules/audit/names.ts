"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { NameLookup, RefKind } from "@/lib/audit/present";

// Resolución en lote de ids de auditoría a nombres (TX-AUD, ADR-160).
// Corre del lado del cliente con la sesión del usuario: cada consulta pasa por
// la RLS de su tabla (el dueño ve lo de su negocio; internal, lo que le da
// internal_scope()). Lo que no se puede leer queda sin resolver y la UI muestra
// el id corto. Nunca service_role.

interface Source {
  table: string;
  cols: string;
  pick: (r: Record<string, unknown>) => string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

const SOURCES: Record<RefKind, Source> = {
  category: { table: "categories", cols: "id, name", pick: (r) => str(r.name) },
  brand: { table: "brands", cols: "id, name", pick: (r) => str(r.name) },
  supplier: { table: "suppliers", cols: "id, name, trade_name", pick: (r) => str(r.trade_name) ?? str(r.name) },
  store: { table: "stores", cols: "id, name", pick: (r) => str(r.name) },
  warehouse: { table: "warehouses", cols: "id, name", pick: (r) => str(r.name) },
  customer: { table: "customers", cols: "id, name", pick: (r) => str(r.name) },
  customer_group: { table: "customer_groups", cols: "id, name", pick: (r) => str(r.name) },
  user: { table: "users", cols: "id, full_name, email", pick: (r) => str(r.full_name) ?? str(r.email) },
  register: { table: "cash_registers", cols: "id, name", pick: (r) => str(r.name) },
  price_list: { table: "price_lists", cols: "id, name", pick: (r) => str(r.name) },
  product: { table: "products", cols: "id, name", pick: (r) => str(r.name) },
  cashier_profile: { table: "cashier_profiles", cols: "id, display_name", pick: (r) => str(r.display_name) },
};

type Loose = {
  from: (t: string) => {
    select: (c: string) => {
      in: (col: string, ids: string[]) => PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
    };
  };
};

const CHUNK = 100;

/** Pide los nombres de todos los ids, por tabla y en tandas. Fallas por tabla se ignoran. */
export async function resolveAuditNames(refs: Partial<Record<RefKind, string[]>>): Promise<Record<string, string>> {
  const sb = createClient() as unknown as Loose;
  const out: Record<string, string> = {};
  const jobs: Promise<void>[] = [];
  for (const [kind, ids] of Object.entries(refs) as [RefKind, string[]][]) {
    const src = SOURCES[kind];
    if (!src || !ids?.length) continue;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      jobs.push(
        Promise.resolve(sb.from(src.table).select(src.cols).in("id", slice)).then(
          ({ data }) => {
            for (const r of data ?? []) {
              const name = src.pick(r);
              if (name && typeof r.id === "string") out[`${kind}:${r.id}`] = name;
            }
          },
          () => undefined,
        ),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}

/**
 * Hook: resuelve los ids de los eventos y devuelve un `NameLookup`.
 * `known` suma nombres que el llamador ya tiene (p. ej. personal del negocio,
 * que la RLS de `users` no deja leer al dueño).
 */
export function useAuditNames(
  refs: Partial<Record<RefKind, string[]>>,
  known?: Partial<Record<RefKind, Record<string, string>>>,
): { names: NameLookup; isLoading: boolean } {
  const key = JSON.stringify(refs);
  const empty = key === "{}";
  const { data, isLoading } = useQuery({
    queryKey: ["audit", "names", key],
    queryFn: () => resolveAuditNames(refs),
    enabled: !empty,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const names: NameLookup = (kind, id) => known?.[kind]?.[id] ?? data?.[`${kind}:${id}`] ?? null;
  return { names, isLoading: !empty && isLoading };
}
