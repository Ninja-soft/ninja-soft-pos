"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Landmark, ShieldPlus, Trash2, ShieldCheck, UserPlus, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableStateRow, TableWrap } from "@/components/ui/Table";
import { Switch } from "@/components/ui/Switch";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { billingErrorMessage } from "@/lib/billing/ledger";
import { useBillingConfigMutations, useStaffPermissions, type StaffBillingPermission } from "@/modules/billing/ledger";

type Level = "support" | "admin" | "super_admin";
const LEVEL_LABELS: Record<string, string> = {
  support: "Soporte",
  admin: "Admin",
  super_admin: "Super admin",
};
const LEVEL_HELP: Record<Level, string> = {
  support: "Solo lectura, más acciones de soporte acotadas y con motivo.",
  admin: "Opera negocios, planes y flags. No cambia el staff.",
  super_admin: "Todo lo anterior y además asigna niveles de staff.",
};
const LEVEL_OPTIONS: { value: Level; label: string }[] = [
  { value: "support", label: "Soporte" },
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super" },
];
type Staff = {
  id: string;
  email: string;
  full_name: string | null;
  internal_level: string | null;
};

// Permisos de cobranza sumables al nivel (ADR-115, ADR-131).
const PERMISSION_ROWS: { key: StaffBillingPermission; label: string; short: string; grant: string; revoke: string }[] = [
  {
    key: "cobranzas",
    label: "Cobranzas",
    short: "Gestionar",
    grant: "va a poder registrar pagos, bonificar, anular cargos dentro del tope, cargar notas y promesas y resolver la conciliación.",
    revoke: "deja de operar las cuentas corrientes.",
  },
  {
    key: "cobranzas_ver",
    label: "Cobranzas: sólo ver",
    short: "Sólo ver",
    grant: "va a ver la cartera de cobranza, la historia 360 y la conciliación, sin poder operar.",
    revoke: "deja de ver la cartera y la historia 360.",
  },
  {
    key: "cobranzas_asignar",
    label: "Cobranzas: asignar cobradores",
    short: "Asignar cobradores",
    grant: "va a poder asignar y cambiar el cobrador de cada negocio.",
    revoke: "deja de asignar cobradores.",
  },
];

export default function InternalStaffPage() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<Level>("admin");
  const [removing, setRemoving] = useState<Staff | null>(null);
  const [cobranzasFor, setCobranzasFor] = useState<{ staff: Staff; enabled: boolean; permission: StaffBillingPermission } | null>(null);
  const { data: permissions = [] } = useStaffPermissions();
  const { setPermission } = useBillingConfigMutations();
  const hasPerm = (id: string, perm: StaffBillingPermission) => permissions.some((p) => p.user_id === id && p.permission === perm);

  const { data: me } = useQuery({
    queryKey: ["my-internal-level"],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return {
        id: user?.id ?? null,
        level: ((user?.app_metadata as { internal_level?: string } | null)
          ?.internal_level ?? null) as string | null,
      };
    },
  });

  const { data: staff = [], isLoading } = useQuery({
    queryKey: ["internal-staff"],
    queryFn: async (): Promise<Staff[]> => {
      const { data, error } = await supabase.rpc("internal_list_staff");
      if (error) throw error;
      return (data ?? []) as Staff[];
    },
  });

  const isSuper = me?.level === "super_admin";
  const noSuper = staff.every((s) => s.internal_level !== "super_admin");
  const canBootstrap = !isSuper && noSuper;

  const setLevelMut = useMutation({
    mutationFn: async (vars: { email?: string; user_id?: string; level: Level | null }) => {
      const { data, error } = await supabase.functions.invoke("staff_admin", {
        body: { action: "set_level", ...vars },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Staff actualizado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["internal-staff"] });
      qc.invalidateQueries({ queryKey: ["my-internal-level"] });
      setEmail("");
    },
    onError: (e) =>
      toast({
        title: "No se pudo actualizar",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      }),
  });

  const cols = isSuper ? 4 : 3;

  return (
    <>
      <PageHeader
        eyebrow="Operaciones"
        title="Staff NinjaSoft"
        icon={ShieldCheck}
        description={
          <>
            Quién puede operar el panel interno y con qué nivel. Solo un super admin
            asigna niveles.
          </>
        }
      />

      {canBootstrap && (
        <Callout
          className="mt-6"
          tone="warning"
          icon={ShieldPlus}
          title="Todavía no hay un super admin"
          actions={
            <Button
              size="sm"
              onClick={() =>
                setLevelMut.mutate({ user_id: me?.id ?? undefined, level: "super_admin" })
              }
              loading={setLevelMut.isPending}
            >
              <ShieldPlus size={16} /> Reclamar super admin
            </Button>
          }
        >
          Reclamá el rol de super admin para gestionar el staff.
        </Callout>
      )}

      {isSuper && (
        <Card className="mt-6">
          <CardContent className="p-4 sm:p-5">
            <SectionHeader
              title="Agregar staff"
              icon={UserPlus}
              description="La persona ya tiene que tener una cuenta en NinjaPos."
            />
            <form
              className="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                setLevelMut.mutate({ email: email.trim().toLowerCase(), level });
              }}
            >
              <div className="min-w-0 flex-1">
                <Input
                  label="Email de la cuenta"
                  type="email"
                  required
                  placeholder="persona@ninjasoft.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Segmented<Level>
                aria-label="Nivel"
                value={level}
                onChange={setLevel}
                options={LEVEL_OPTIONS}
              />
              <Button type="submit" loading={setLevelMut.isPending}>
                Agregar
              </Button>
            </form>
            <ul className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              {LEVEL_OPTIONS.map((o) => (
                <li key={o.value} className="rounded-lg bg-muted/60 px-3 py-2">
                  <span className="font-semibold text-foreground">{LEVEL_LABELS[o.value]}</span>
                  <span className="mt-0.5 block">{LEVEL_HELP[o.value]}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Landmark size={14} className="mt-0.5 shrink-0 text-ninja-flameSoft" aria-hidden />
              <span>
                <span className="font-semibold text-foreground">Cobranzas</span> es un permiso que se suma al nivel: una persona de
                Soporte con Cobranzas ve y opera las cuentas corrientes (registra pagos y bonifica dentro de su tope) sin administrar
                negocios. Admin y Super admin ya operan cobranzas por su nivel. Dos permisos finos más:{" "}
                <span className="font-semibold text-foreground">sólo ver</span> (la cartera y la historia 360, sin operar) y{" "}
                <span className="font-semibold text-foreground">asignar cobradores</span> (reparte la cartera).
              </span>
            </p>
          </CardContent>
        </Card>
      )}

      <SectionHeader
        className="mt-8"
        title="Equipo"
        icon={Users}
        description={
          isLoading
            ? undefined
            : `${staff.length} ${staff.length === 1 ? "persona" : "personas"} con acceso al panel interno.`
        }
      />
      <TableWrap className="mt-3">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Persona</th>
              <th className="px-4 py-3">Nivel</th>
              <th className="px-4 py-3">Cobranzas</th>
              {isSuper && (
                <th className="px-4 py-3">
                  <span className="sr-only">Acciones</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <TableStateRow colSpan={cols} loading />
            ) : staff.length === 0 ? (
              <TableStateRow colSpan={cols}>
                <EmptyState
                  compact
                  icon={ShieldCheck}
                  title="Todavía no hay staff"
                  description="Agregá a la primera persona con su email."
                />
              </TableStateRow>
            ) : (
              staff.map((s) => {
                const name = s.full_name || s.email;
                return (
                  <tr key={s.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={name} size={32} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="truncate">{name}</span>
                            {s.id === me?.id && <Badge tone="brand">Vos</Badge>}
                          </div>
                          {s.full_name && (
                            <div className="truncate text-xs text-muted-foreground">{s.email}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {isSuper ? (
                        <Segmented<Level>
                          size="sm"
                          aria-label={`Nivel de ${name}`}
                          value={(s.internal_level as Level) ?? "support"}
                          onChange={(v) => setLevelMut.mutate({ user_id: s.id, level: v })}
                          options={LEVEL_OPTIONS}
                        />
                      ) : (
                        <Badge tone={s.internal_level === "super_admin" ? "brand" : "neutral"}>
                          {LEVEL_LABELS[s.internal_level ?? ""] ?? s.internal_level}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {s.internal_level === "admin" || s.internal_level === "super_admin" ? (
                        <Badge tone="neutral">Por su nivel</Badge>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {PERMISSION_ROWS.map((p) =>
                            isSuper ? (
                              <div key={p.key} className="flex items-center gap-2">
                                <Switch
                                  checked={hasPerm(s.id, p.key)}
                                  onCheckedChange={(v) => setCobranzasFor({ staff: s, enabled: v, permission: p.key })}
                                  label={`${p.label} para ${name}`}
                                />
                                <span className="text-xs text-muted-foreground">{p.short}</span>
                              </div>
                            ) : hasPerm(s.id, p.key) ? (
                              <Badge key={p.key} tone="success">
                                {p.short}
                              </Badge>
                            ) : null,
                          )}
                          {!isSuper && !PERMISSION_ROWS.some((p) => hasPerm(s.id, p.key)) && <Badge tone="neutral">No</Badge>}
                        </div>
                      )}
                    </td>
                    {isSuper && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setRemoving(s)}
                          className="ml-auto grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/15 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Quitar a ${name} del staff`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </TableWrap>

      <ReasonDialog
        open={cobranzasFor !== null}
        onOpenChange={(o) => !o && setCobranzasFor(null)}
        title={
          cobranzasFor
            ? `${cobranzasFor.enabled ? "Dar" : "Quitar"} permiso ${PERMISSION_ROWS.find((p) => p.key === cobranzasFor.permission)?.label ?? "Cobranzas"}`
            : "Permiso de cobranzas"
        }
        description={
          cobranzasFor
            ? `${cobranzasFor.staff.full_name || cobranzasFor.staff.email} ${
                cobranzasFor.enabled
                  ? PERMISSION_ROWS.find((p) => p.key === cobranzasFor.permission)?.grant ?? ""
                  : PERMISSION_ROWS.find((p) => p.key === cobranzasFor.permission)?.revoke ?? ""
              }`
            : undefined
        }
        confirmLabel={cobranzasFor?.enabled ? "Dar permiso" : "Quitar permiso"}
        loading={setPermission.isPending}
        onConfirm={async (reason) => {
          if (!cobranzasFor) return;
          try {
            await setPermission.mutateAsync({
              userId: cobranzasFor.staff.id,
              enabled: cobranzasFor.enabled,
              reason,
              permission: cobranzasFor.permission,
            });
            toast({ title: cobranzasFor.enabled ? "Permiso otorgado" : "Permiso quitado", variant: "success" });
            setCobranzasFor(null);
          } catch (e) {
            toast({ title: "No se pudo cambiar el permiso", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Quitar del staff"
        description={
          removing
            ? `${removing.full_name || removing.email} deja de tener acceso al panel interno. Su cuenta de NinjaPos sigue igual.`
            : undefined
        }
        confirmLabel="Quitar acceso"
        danger
        loading={setLevelMut.isPending}
        onConfirm={() => {
          if (removing) setLevelMut.mutate({ user_id: removing.id, level: null });
          setRemoving(null);
        }}
      />
    </>
  );
}
