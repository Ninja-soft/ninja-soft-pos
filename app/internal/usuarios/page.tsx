"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, RotateCcw, Search, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { useInternalUsers, useSetUserActive } from "@/modules/internal/hooks";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatRelative } from "@/lib/utils/format";
import { NoData } from "@/components/ui/NoData";
import { PageHeader } from "@/components/ui/PageHeader";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";

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
  const [toSuspend, setToSuspend] = useState<{
    id: string;
    suspended_at: string | null;
    email: string;
  } | null>(null);
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
    if (!activating) {
      // Suspensión: confirmación con diálogo propio (sin window.confirm).
      setToSuspend(u);
      return;
    }
    doToggle(u, activating);
  }

  function doToggle(
    u: { id: string; suspended_at: string | null; email: string },
    activating: boolean,
  ) {
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
      <PageHeader
        eyebrow="Operaciones"
        title="Usuarios"
        icon={Users}
        description={
          <>
            Todas las cuentas de la plataforma, con sus membresías por negocio.
            {isAdmin && " Podés suspender y reactivar cuentas; queda auditado."}
          </>
        }
      />

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder="Buscar por nombre, email o negocio"
          aria-label="Buscar usuarios"
          className="sm:max-w-sm"
        />
        <Segmented<"all" | "suspended">
          aria-label="Estado"
          value={onlySuspended ? "suspended" : "all"}
          onChange={(v) => setOnlySuspended(v === "suspended")}
          options={[
            { value: "all", label: "Todos" },
            { value: "suspended", label: "Suspendidos" },
          ]}
        />
        {!isLoading && (
          <span className="text-xs tabular-nums text-muted-foreground sm:ml-auto">
            {filtered.length} de {users?.length ?? 0}
          </span>
        )}
      </div>

      <TableWrap className="mt-4">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Persona</th>
              <th className="px-4 py-3">Negocios</th>
              <th className="hidden px-4 py-3 md:table-cell">Staff</th>
              <th className="px-4 py-3">Estado</th>
              <th className="hidden px-4 py-3 lg:table-cell">Alta</th>
              {isAdmin && (
                <th className="px-4 py-3 text-right">
                  <span className="sr-only">Acciones</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-foreground">
            {isLoading && <TableStateRow colSpan={6} loading />}
            {!isLoading && filtered.length === 0 && (
              <TableStateRow colSpan={6}>
                <EmptyState
                  compact
                  icon={Search}
                  title={onlySuspended && !search ? "No hay cuentas suspendidas" : "Sin resultados"}
                  description={onlySuspended && !search ? undefined : "Probá con otro nombre, email o negocio."}
                />
              </TableStateRow>
            )}
            {filtered.map((u) => {
              const canTouch =
                isAdmin && u.id !== me?.id && (isSuper || !u.internal_level);
              return (
                <tr key={u.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar name={u.full_name || u.email} size={32} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{u.full_name ?? <NoData />}</div>
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {u.memberships.length === 0 ? (
                      <NoData />
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.memberships.map((m, i) => (
                          <Badge
                            key={i}
                            tone="neutral"
                            className="font-medium text-foreground"
                            title={`${ROLE_LABELS[m.role] ?? m.role} · ${m.status}`}
                          >
                            {m.tenantName}
                            <span className="text-muted-foreground">
                              {ROLE_LABELS[m.role] ?? m.role}
                            </span>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    {u.internal_level ? (
                      <Badge tone="brand">
                        {LEVEL_LABELS[u.internal_level] ?? u.internal_level}
                      </Badge>
                    ) : (
                      <NoData />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.suspended_at ? (
                      <Badge tone="danger" title={`Suspendido ${formatRelative(u.suspended_at)}`}>
                        Suspendido
                      </Badge>
                    ) : (
                      <Badge tone="success">Activa</Badge>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap px-4 py-3 tabular-nums text-muted-foreground lg:table-cell">
                    {new Date(u.created_at).toLocaleDateString("es-AR")}
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {canTouch && (
                          <button
                            type="button"
                            onClick={() => toggle(u)}
                            disabled={setActive.isPending}
                            aria-label={u.suspended_at ? `Reactivar ${u.email}` : `Suspender ${u.email}`}
                            title={u.suspended_at ? "Reactivar cuenta" : "Suspender cuenta"}
                            className={
                              u.suspended_at
                                ? "grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-success/15 hover:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                : "grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
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
      </TableWrap>

      <ConfirmDialog
        open={toSuspend !== null}
        onOpenChange={(o) => !o && setToSuspend(null)}
        title="Suspender cuenta"
        description={
          toSuspend
            ? `${toSuspend.email} no va a poder iniciar sesión hasta que la reactives.`
            : undefined
        }
        confirmLabel="Suspender"
        danger
        loading={setActive.isPending}
        onConfirm={() => {
          if (!toSuspend) return;
          doToggle(toSuspend, false);
          setToSuspend(null);
        }}
      />
    </>
  );
}
