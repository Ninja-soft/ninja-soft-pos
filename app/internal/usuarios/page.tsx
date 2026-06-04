"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, RotateCcw, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Eyebrow, Display } from "@/components/ui/Typography";
import { useToast } from "@/components/ui/Toast";
import { useInternalUsers, useSetUserActive } from "@/modules/internal/hooks";
import { formatRelative } from "@/lib/utils/format";

const LEVEL_LABELS: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  support: "Soporte",
};
const ROLE_LABELS: Record<string, string> = {
  owner: "dueño",
  manager: "encargado",
  cashier: "cajero",
  viewer: "lector",
};

export default function InternalUsersPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [onlySuspended, setOnlySuspended] = useState(false);
  const { data: users, isLoading } = useInternalUsers();
  const setActive = useSetUserActive();

  const { data: me } = useQuery({
    queryKey: ["my-internal-level"],
    queryFn: async () => {
      const {
        data: { user },
      } = await createClient().auth.getUser();
      return {
        id: user?.id ?? null,
        level: ((user?.app_metadata as { internal_level?: string } | null)
          ?.internal_level ?? null) as string | null,
      };
    },
  });
  const isSuper = me?.level === "super_admin";
  const isAdmin = isSuper || me?.level === "admin";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users ?? []).filter((u) => {
      if (onlySuspended && !u.suspended_at) return false;
      if (!q) return true;
      return [u.full_name, u.email, ...u.memberships.map((m) => m.tenantName)]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [users, search, onlySuspended]);

  function toggle(u: { id: string; suspended_at: string | null; email: string }) {
    const activating = Boolean(u.suspended_at);
    if (
      !activating &&
      !window.confirm(`¿Suspender la cuenta ${u.email}? No va a poder iniciar sesión.`)
    )
      return;
    setActive
      .mutateAsync({ userId: u.id, active: activating })
      .then(() =>
        toast({
          title: activating ? "Cuenta reactivada" : "Cuenta suspendida",
          variant: "success",
        }),
      )
      .catch((e) =>
        toast({
          title: "No se pudo actualizar",
          description: e instanceof Error ? e.message : undefined,
          variant: "error",
        }),
      );
  }

  return (
    <>
      <Eyebrow>Operaciones</Eyebrow>
      <Display className="mt-3 text-3xl md:text-4xl">Usuarios</Display>
      <p className="mt-2 text-muted-foreground">
        Todas las cuentas de la plataforma, con sus membresías por negocio.
        {isAdmin && " Podés suspender/reactivar cuentas (queda auditado)."}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, email o negocio…"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlySuspended}
            onChange={(e) => setOnlySuspended(e.target.checked)}
            className="h-4 w-4 accent-ninja-flame"
          />
          Solo suspendidos
        </label>
        {!isLoading && (
          <span className="text-xs text-muted-foreground">
            {filtered.length} de {users?.length ?? 0}
          </span>
        )}
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[840px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Persona</th>
              <th className="px-4 py-3">Negocios</th>
              <th className="px-4 py-3">Staff</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Alta</th>
              {isAdmin && <th className="px-4 py-3 text-right">Acciones</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Cargando…
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  Sin resultados.
                </td>
              </tr>
            )}
            {filtered.map((u) => {
              const canTouch =
                isAdmin && u.id !== me?.id && (isSuper || !u.internal_level);
              return (
                <tr key={u.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.full_name ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    {u.memberships.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.memberships.map((m, i) => (
                          <span
                            key={i}
                            className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
                            title={`${ROLE_LABELS[m.role] ?? m.role} · ${m.status}`}
                          >
                            {m.tenantName}
                            <span className="ml-1 text-muted-foreground">
                              ({ROLE_LABELS[m.role] ?? m.role})
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.internal_level ? (
                      <span className="inline-flex rounded-full bg-ninja-flame/12 px-2.5 py-0.5 text-xs font-semibold text-ninja-flameSoft">
                        {LEVEL_LABELS[u.internal_level] ?? u.internal_level}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.suspended_at ? (
                      <span
                        className="inline-flex rounded-full border border-red-400/40 bg-red-400/10 px-2.5 py-0.5 text-xs font-semibold text-red-300"
                        title={`Suspendido ${formatRelative(u.suspended_at)}`}
                      >
                        Suspendido
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                        Activo
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(u.created_at).toLocaleDateString("es-AR")}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {canTouch && (
                          <button
                            onClick={() => toggle(u)}
                            disabled={setActive.isPending}
                            title={u.suspended_at ? "Reactivar cuenta" : "Suspender cuenta"}
                            className={
                              u.suspended_at
                                ? "rounded-md p-2 text-muted-foreground transition hover:bg-emerald-500/15 hover:text-emerald-300"
                                : "rounded-md p-2 text-muted-foreground transition hover:bg-red-400/15 hover:text-red-300"
                            }
                          >
                            {u.suspended_at ? <RotateCcw size={16} /> : <Ban size={16} />}
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
