"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { IdCard, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { SOLID_CTA } from "@/components/security/styles";
import {
  AvatarPicker,
  BranchAssignPicker,
  MemberPreview,
  RolePicker,
  type AssignableRole,
} from "@/components/staff/staffForms";
import { useBranchContext } from "@/modules/branches/hooks";
import type { StaffPersonRow } from "@/modules/staff/api";

// Código de error de una Edge Function (el cuerpo JSON de la respuesta).
async function edgeError(err: unknown): Promise<string | null> {
  const ctx = (err as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.clone().json()) as { error?: string; detail?: string };
      return body.error ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

const INVITE_ERRORS: Record<string, string> = {
  already_member: "Esa persona ya es parte del equipo.",
  member_terminated: "Esa persona está de baja: usá Reingreso desde su ficha.",
  limit_reached: "Llegaste al máximo de usuarios de tu plan.",
  forbidden_role: "Sólo el dueño puede sumar encargados.",
  invalid_email: "Revisá el email.",
  store_not_found: "Una de las sucursales ya no existe.",
  forbidden: "No tenés permiso para invitar.",
};

function useRefreshStaff() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["staff"] });
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
    qc.invalidateQueries({ queryKey: ["cashier-profiles"] });
    qc.invalidateQueries({ queryKey: ["branches"] });
    qc.invalidateQueries({ queryKey: ["owner-stats"] });
  };
}

// Invitar usuario (F17 · H113): email, nombre, rol, sucursal base y
// adicionales con rol por sucursal, avatar. La Edge invite_user valida todo,
// no pisa miembros existentes y deja el negocio activo del invitado.
export function InviteMemberModal({
  open,
  onOpenChange,
  tenantId,
  isOwner,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  isOwner: boolean;
}) {
  const { toast } = useToast();
  const refresh = useRefreshStaff();
  const ctx = useBranchContext();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AssignableRole>("cashier");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>([]);
  const [branchRole, setBranchRole] = useState<"same" | AssignableRole>("same");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    // Por defecto, la sucursal que se está mirando (o la principal).
    if (ctx.isMulti && !home) setHome(ctx.filterStoreId ?? ctx.allowed[0]?.id ?? null);
  }, [open, ctx.isMulti, ctx.filterStoreId, ctx.allowed, home]);

  function reset() {
    setEmail("");
    setName("");
    setAvatar(null);
    setRole("cashier");
    setHome(null);
    setExtras([]);
    setBranchRole("same");
  }

  const m = useMutation({
    mutationFn: async () => {
      const storeIds = ctx.isMulti && home ? [home, ...extras] : [];
      const { data, error: err } = await createClient().functions.invoke("invite_user", {
        body: {
          email: email.trim().toLowerCase(),
          role,
          display_name: name.trim(),
          avatar,
          ...(storeIds.length > 0 ? { store_ids: storeIds } : {}),
          ...(storeIds.length > 0 && branchRole !== "same" ? { store_role: branchRole } : {}),
        },
      });
      if (err) {
        const code = await edgeError(err);
        throw new Error(code ?? "invite_failed");
      }
      return data as { existed: boolean; branches_error?: string | null };
    },
    onSuccess: (d) => {
      toast({
        variant: "success",
        title: d?.existed ? "Usuario agregado" : "Invitación enviada",
        description: d?.existed ? "Ya tenía cuenta; ahora es parte del equipo." : "Le mandamos un email para definir su contraseña.",
      });
      if (d?.branches_error) {
        toast({ variant: "error", title: "No se pudieron asignar las sucursales", description: "Asignalas desde su ficha." });
      }
      reset();
      refresh();
      onOpenChange(false);
    },
    onError: (e) => setError(INVITE_ERRORS[(e as Error).message] ?? "No se pudo invitar. Revisá el email."),
  });

  const branchNames = ctx.isMulti
    ? [home, ...extras].filter(Boolean).map((id) => ctx.allowed.find((b) => b.id === id)?.short_name || ctx.allowed.find((b) => b.id === id)?.name || "")
    : [];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Invitar usuario"
      description="Tendrá su propio acceso con email y contraseña, y su propia caja."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="invite-member-form" className={SOLID_CTA} loading={m.isPending}>
            <UserPlus size={16} /> Enviar invitación
          </Button>
        </>
      }
    >
      <form
        id="invite-member-form"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate();
        }}
        className="space-y-5"
      >
        <MemberPreview name={name} email={email} avatar={avatar} role={role} branches={branchNames} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Email"
            type="email"
            required
            autoComplete="off"
            placeholder="persona@ejemplo.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Nombre"
            required
            placeholder="Ej. Ana Pérez"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
          <RolePicker value={role} onChange={setRole} allowManager={isOwner} />
        </div>
        {ctx.isMulti && ctx.allowed.length > 1 && (
          <>
            <BranchAssignPicker
              branches={ctx.allowed}
              home={home}
              extras={extras}
              onChange={(v) => {
                setHome(v.home);
                setExtras(v.extras);
              }}
            />
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol en esas sucursales</span>
              <Segmented
                size="sm"
                value={branchRole}
                onChange={setBranchRole}
                aria-label="Rol por sucursal"
                options={[
                  { value: "same", label: "El mismo" },
                  ...(isOwner ? [{ value: "manager" as const, label: "Encargado" }] : []),
                  { value: "cashier", label: "Cajero" },
                  { value: "viewer", label: "Solo lectura" },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Sólo opera en estas sucursales. Después lo podés trasladar o darle coberturas desde su ficha.
              </p>
            </div>
          </>
        )}
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
          <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
        </div>
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}
InviteMemberModal.displayName = "InviteMemberModal";

// Editar nombre, rol y avatar de un usuario con cuenta.
export function EditMemberModal({
  person,
  onOpenChange,
  tenantId,
  isOwner,
  isSelf,
}: {
  person: StaffPersonRow | null;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
  isOwner: boolean;
  isSelf: boolean;
}) {
  const { toast } = useToast();
  const refresh = useRefreshStaff();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AssignableRole>("cashier");
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    if (!person) return;
    setName(person.name ?? "");
    setRole((["manager", "cashier", "viewer"].includes(person.role ?? "") ? person.role : "cashier") as AssignableRole);
    setAvatar(person.avatar);
  }, [person]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await createClient().functions.invoke("member_admin", {
        body: {
          action: person?.kind === "profile" ? "update_profile" : "update_member",
          ...(person?.kind === "profile" ? { profile_id: person.profile_id } : { user_id: person?.user_id }),
          display_name: name.trim(),
          ...(isSelf || person?.kind === "profile" || person?.role === "owner" ? {} : { role }),
          avatar,
        },
      });
      if (error) throw new Error((await edgeError(error)) ?? "update_failed");
    },
    onSuccess: () => {
      toast({ variant: "success", title: "Guardado" });
      refresh();
      onOpenChange(false);
    },
    onError: (e) =>
      toast({
        variant: "error",
        title: (e as Error).message === "forbidden_role" ? "Sólo el dueño cambia a un encargado" : "No se pudo guardar",
      }),
  });

  return (
    <Modal
      open={Boolean(person)}
      onOpenChange={onOpenChange}
      title={person ? `Editar a ${person.name}` : "Editar"}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="edit-member-form" className={SOLID_CTA} loading={save.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <form
        id="edit-member-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-5"
      >
        <Input label="Nombre" required value={name} onChange={(e) => setName(e.target.value)} />
        {person?.kind === "user" && !isSelf && person.role !== "owner" && (isOwner || person.role !== "manager") && (
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
            <RolePicker value={role} onChange={setRole} allowManager={isOwner} />
          </div>
        )}
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
          <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
        </div>
      </form>
    </Modal>
  );
}
EditMemberModal.displayName = "EditMemberModal";

// Nuevo perfil sin cuenta (cajero que se identifica en el POS sin email).
export function NewProfileModal({
  open,
  onOpenChange,
  tenantId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  tenantId: string;
}) {
  const { toast } = useToast();
  const refresh = useRefreshStaff();
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [pin, setPin] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await createClient().functions.invoke("member_admin", {
        body: { action: "create_profile", display_name: name.trim(), avatar, ...(pin ? { pin } : {}) },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ variant: "success", title: "Perfil creado" });
      setName("");
      setAvatar(null);
      setPin("");
      refresh();
      onOpenChange(false);
    },
    onError: () => toast({ variant: "error", title: "No se pudo crear el perfil" }),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Nuevo perfil sin cuenta"
      description="Para identificar quién vende (ej. “Cajero A”) sin darle email ni contraseña. Usa la sesión del dispositivo."
      footer={
        <>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" form="new-profile-form" className={SOLID_CTA} loading={save.isPending}>
            <IdCard size={16} /> Crear perfil
          </Button>
        </>
      }
    >
      <form
        id="new-profile-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-5"
      >
        <Input label="Nombre" required value={name} onChange={(e) => setName(e.target.value)} />
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
          <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
        </div>
        <Input
          label="PIN (opcional, para fichar en el POS)"
          inputMode="numeric"
          placeholder="Ej. 4826"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
        />
      </form>
    </Modal>
  );
}
NewProfileModal.displayName = "NewProfileModal";
