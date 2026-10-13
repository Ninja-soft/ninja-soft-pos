"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { createClient } from "@/lib/supabase/client";
import { formatRelative } from "@/lib/utils/format";
import { useMyStaffLevel } from "@/modules/internal/hooks";
import { useTenantMemberMutations, useTenantMembers } from "@/modules/internal/opsHooks";
import {
  MEMBER_ROLES,
  MEMBER_ROLE_LABELS,
  MEMBER_STATE_LABELS,
  canAssignRole,
  canStaffDo,
  memberActions,
  memberErrorMessage,
  memberState,
  type MemberAction,
  type MemberRole,
  type MemberRow,
} from "@/supabase/functions/_shared/tenantMembers";

const selectCls =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft";

const STATE_DOT: Record<string, string> = {
  active: "bg-success",
  pending: "bg-ninja-flameSoft",
  suspended: "bg-danger",
  inactive: "bg-muted-foreground",
};

const ACTION_LABELS: Record<MemberAction, string> = {
  invite: "Invitar",
  resend_invite: "Reenviar invitación",
  set_role: "Cambiar rol",
  suspend: "Suspender",
  reactivate: "Reactivar",
  reset_access: "Resetear acceso",
};

const ACTION_HELP: Partial<Record<MemberAction, string>> = {
  resend_invite: "Se vuelve a mandar el email de invitación.",
  suspend: "Deja de poder entrar a este negocio y se cierran sus sesiones.",
  reactivate: "Vuelve a poder entrar a este negocio.",
  reset_access: "Se cierran todas sus sesiones y le llega un email para elegir una contraseña nueva.",
};

type Pending = { member: MemberRow; action: MemberAction } | null;

// Miembros del negocio desde el panel interno (ADR-084): invitar, reenviar la
// invitación, cambiar rol, suspender o reactivar y resetear el acceso, siempre
// con motivo y auditado. La RPC y la Edge validan todo de nuevo.
export function TenantMembersCard({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const { level } = useMyStaffLevel();
  const { data: me } = useQuery({
    queryKey: ["my-user-id"],
    queryFn: () => createClient().auth.getUser().then((r) => r.data.user?.id ?? null),
    staleTime: 5 * 60 * 1000,
  });
  const { data: members, isLoading, error } = useTenantMembers(tenantId);
  const mut = useTenantMemberMutations(tenantId);

  const [pending, setPending] = useState<Pending>(null);
  const [newRole, setNewRole] = useState<MemberRole>("cashier");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invName, setInvName] = useState("");
  const [invRole, setInvRole] = useState<MemberRole>("cashier");

  const activeOwners = useMemo(
    () => (members ?? []).filter((m) => m.role === "owner" && m.status === "active").length,
    [members],
  );
  const canInvite = canStaffDo(level, "invite");
  const inviteRoles = MEMBER_ROLES.filter((r) => r !== "owner" || (level === "super_admin" && activeOwners === 0));

  function fail(e: unknown) {
    toast({
      title: "No se pudo completar",
      description: memberErrorMessage(e instanceof Error ? e.message : null),
      variant: "error",
    });
  }

  function run(reason: string) {
    if (!pending) return;
    const { member, action } = pending;
    const done = (title: string) => {
      setPending(null);
      toast({ title, variant: "success" });
    };
    if (action === "set_role") {
      mut.admin.mutate(
        { userId: member.user_id, action, role: newRole, reason },
        { onSuccess: () => done("Rol actualizado"), onError: fail },
      );
    } else if (action === "suspend" || action === "reactivate") {
      mut.admin.mutate(
        { userId: member.user_id, action, reason },
        { onSuccess: () => done(action === "suspend" ? "Miembro suspendido" : "Miembro reactivado"), onError: fail },
      );
    } else if (action === "resend_invite" || action === "reset_access") {
      mut.edge.mutate(
        { userId: member.user_id, action, reason },
        {
          onSuccess: (r) =>
            done(
              action === "resend_invite"
                ? "Invitación reenviada"
                : r.emailSent
                  ? "Acceso reseteado y email enviado"
                  : "Sesiones cerradas; el email no salió, reintentá",
            ),
          onError: fail,
        },
      );
    }
  }

  const busy = mut.admin.isPending || mut.edge.isPending || mut.invite.isPending;
  const roleOptions = pending
    ? MEMBER_ROLES.filter((r) => canAssignRole(level, pending.member.role, r))
    : [];
  const email = invEmail.trim().toLowerCase();
  const inviteOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  return (
    <>
      <Card className="mt-3">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-sm text-muted-foreground">
              Cuentas con acceso a este negocio. Todo cambio pide motivo y queda en la auditoría.
            </p>
            {canInvite && (
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus size={15} /> Invitar usuario
              </Button>
            )}
          </div>
          {isLoading && <p className="px-5 pb-4 text-sm text-muted-foreground">Cargando miembros…</p>}
          {error && (
            <p className="px-5 pb-4 text-sm text-muted-foreground">
              No se pudieron cargar los miembros ({error instanceof Error ? error.message : "error"}).
            </p>
          )}
          {members && members.length === 0 && (
            <p className="px-5 pb-4 text-sm text-muted-foreground">Este negocio no tiene miembros.</p>
          )}
          <ul className="divide-y divide-border border-t border-border">
            {(members ?? []).map((m) => {
              const st = memberState(m);
              const actions = memberActions(level, m, me ?? null, activeOwners);
              return (
                <li key={m.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {m.display_name || m.full_name || m.email}
                      {m.is_staff && <span className="ml-2 text-xs text-ninja-flameSoft">staff NinjaSoft</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {m.email} · {MEMBER_ROLE_LABELS[m.role] ?? m.role} · último ingreso{" "}
                      {formatRelative(m.last_sign_in_at)}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className={`h-2 w-2 rounded-full ${STATE_DOT[st]}`} />
                    {MEMBER_STATE_LABELS[st]}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {actions.map((a) => (
                      <Button
                        key={a}
                        size="sm"
                        variant={a === "suspend" ? "ghost" : "secondary"}
                        disabled={busy}
                        onClick={() => {
                          setNewRole(
                            MEMBER_ROLES.find((r) => canAssignRole(level, m.role, r)) ?? "cashier",
                          );
                          setPending({ member: m, action: a });
                        }}
                      >
                        {ACTION_LABELS[a]}
                      </Button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(o) => !o && setPending(null)}
        title={pending ? `${ACTION_LABELS[pending.action]}: ${pending.member.email}` : ""}
        description={pending ? ACTION_HELP[pending.action] : undefined}
        confirmLabel={pending ? ACTION_LABELS[pending.action] : "Confirmar"}
        danger={pending?.action === "suspend"}
        loading={busy}
        extra={
          pending?.action === "set_role" ? (
            <div>
              <label htmlFor="member-role" className="mb-2 block text-sm font-medium text-muted-foreground">
                Rol nuevo
              </label>
              <select
                id="member-role"
                className={selectCls}
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as MemberRole)}
              >
                {roleOptions.map((r) => (
                  <option key={r} value={r} className="bg-popover text-popover-foreground">
                    {MEMBER_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          ) : undefined
        }
        onConfirm={run}
      />

      <ReasonDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="Invitar usuario al negocio"
        description="Si la cuenta no existe se le manda una invitación por email; si existe, se suma con el rol elegido."
        confirmLabel={inviteOk ? "Invitar" : "Completá el email"}
        loading={mut.invite.isPending}
        extra={
          <div className="space-y-3">
            <Input
              label="Email"
              type="email"
              value={invEmail}
              onChange={(e) => setInvEmail(e.target.value)}
              autoComplete="off"
            />
            <Input
              label="Nombre visible (opcional)"
              value={invName}
              onChange={(e) => setInvName(e.target.value)}
              maxLength={80}
            />
            <div>
              <label htmlFor="invite-role" className="mb-2 block text-sm font-medium text-muted-foreground">
                Rol
              </label>
              <select
                id="invite-role"
                className={selectCls}
                value={invRole}
                onChange={(e) => setInvRole(e.target.value as MemberRole)}
              >
                {inviteRoles.map((r) => (
                  <option key={r} value={r} className="bg-popover text-popover-foreground">
                    {MEMBER_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        }
        onConfirm={(reason) => {
          if (!inviteOk) {
            toast({ title: "Email inválido", variant: "error" });
            return;
          }
          mut.invite.mutate(
            { email, role: invRole, displayName: invName.trim(), reason },
            {
              onSuccess: (r) => {
                setInviteOpen(false);
                setInvEmail("");
                setInvName("");
                toast({
                  title: r.invited ? "Invitación enviada" : "Usuario sumado al negocio",
                  variant: "success",
                });
              },
              onError: fail,
            },
          );
        }}
      />
    </>
  );
}
