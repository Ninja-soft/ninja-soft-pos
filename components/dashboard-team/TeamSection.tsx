"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Pencil, IdCard } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Avatar, AVATAR_ICONS, AVATAR_PRESETS } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils/cn";

const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño",
  manager: "Encargado",
  cashier: "Cajero",
  viewer: "Solo lectura",
};
const STATUS_LABELS: Record<string, string> = {
  active: "Activo",
  suspended: "Suspendido",
  invited: "Invitado",
};
type AssignableRole = "manager" | "cashier" | "viewer";

type Member = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  display_name: string | null;
  role: string;
  status: string;
  avatar: string | null;
};
type Profile = {
  id: string;
  display_name: string;
  avatar: string | null;
  status: string;
};

function AvatarPicker({
  value,
  onChange,
  name,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  name: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        className={cn(
          "grid h-9 w-9 place-items-center rounded-full ring-2 transition",
          value === null ? "ring-ninja-flame" : "ring-transparent",
        )}
        title="Iniciales"
      >
        <Avatar name={name || "?"} size={32} />
      </button>
      {AVATAR_PRESETS.map((key) => {
        const Icon = AVATAR_ICONS[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "grid h-9 w-9 place-items-center rounded-full ring-2 transition hover:bg-muted",
              value === key ? "ring-ninja-flame" : "ring-transparent",
            )}
            title={key}
          >
            {Icon ? <Icon size={18} /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TeamSection({
  currentUserId,
  tenantId,
  canManage,
}: {
  currentUserId: string;
  tenantId: string;
  canManage: boolean;
}) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: members = [], isLoading } = useQuery({
    queryKey: ["tenant-members", tenantId],
    queryFn: async (): Promise<Member[]> => {
      const { data, error } = await supabase.rpc("tenant_members");
      if (error) {
        const { data: tu } = await supabase
          .from("tenant_users")
          .select("user_id, role, status, display_name, avatar")
          .eq("tenant_id", tenantId)
          .order("joined_at", { ascending: true });
        return (tu ?? []).map((m) => ({
          user_id: m.user_id,
          email: null,
          full_name: null,
          display_name: m.display_name,
          role: m.role,
          status: m.status,
          avatar: m.avatar,
        }));
      }
      return data as Member[];
    },
  });

  const { data: profiles = [] } = useQuery({
    queryKey: ["cashier-profiles", tenantId],
    queryFn: async (): Promise<Profile[]> => {
      const { data } = await supabase
        .from("cashier_profiles")
        .select("id, display_name, avatar, status")
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      return (data ?? []) as Profile[];
    },
  });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["tenant-members"] });
    qc.invalidateQueries({ queryKey: ["cashier-profiles"] });
  }

  const memberName = (m: Member) =>
    m.display_name || m.full_name || m.email || "Miembro";

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading as="h2">Equipo</Heading>
        {canManage && (
          <div className="flex gap-2">
            <ProfileDialog tenantId={tenantId} onDone={refresh} />
            <InviteDialog onDone={refresh} />
          </div>
        )}
      </div>

      {/* Usuarios con login */}
      <Card className="mt-3">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Miembro</th>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Estado</th>
                {canManage && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted-foreground">
                    Cargando…
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-muted-foreground">
                    Todavía no hay miembros.
                  </td>
                </tr>
              ) : (
                members.map((m) => (
                  <tr key={m.user_id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar name={memberName(m)} avatar={m.avatar} size={34} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {memberName(m)}
                            {m.user_id === currentUserId && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                (vos)
                              </span>
                            )}
                          </div>
                          {m.email && m.display_name && (
                            <div className="truncate text-xs text-muted-foreground">
                              {m.email}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{ROLE_LABELS[m.role] ?? m.role}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {STATUS_LABELS[m.status] ?? m.status}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        {m.user_id !== currentUserId && m.role !== "owner" && (
                          <EditMemberDialog member={m} onDone={refresh} />
                        )}
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Perfiles sin login */}
      {(profiles.length > 0 || canManage) && (
        <div className="mt-6">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <IdCard size={15} /> Perfiles sin cuenta (cajeros)
          </h3>
          <Card className="mt-2">
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  {profiles.length === 0 ? (
                    <tr>
                      <td className="px-4 py-5 text-muted-foreground">
                        Creá perfiles tipo “Cajero A” para identificar quién vende,
                        sin darles cuenta ni email.
                      </td>
                    </tr>
                  ) : (
                    profiles.map((p) => (
                      <tr key={p.id}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Avatar name={p.display_name} avatar={p.avatar} size={34} />
                            <span className="font-medium">{p.display_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {STATUS_LABELS[p.status] ?? p.status}
                        </td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            <ProfileDialog
                              tenantId={tenantId}
                              profile={p}
                              onDone={refresh}
                            />
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );

  // --- Diálogos (closures sobre supabase/toast) ---

  function InviteDialog({ onDone }: { onDone: () => void }) {
    const [open, setOpen] = useState(false);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [role, setRole] = useState<AssignableRole>("cashier");
    const [avatar, setAvatar] = useState<string | null>(null);

    const m = useMutation({
      mutationFn: async () => {
        const { data, error } = await supabase.functions.invoke("invite_user", {
          body: {
            email: email.trim().toLowerCase(),
            role,
            display_name: name.trim(),
            avatar,
          },
        });
        if (error) throw error;
        return data as { existed: boolean };
      },
      onSuccess: (d) => {
        toast({
          variant: "success",
          title: d?.existed ? "Usuario agregado" : "Invitación enviada",
          description: d?.existed
            ? "Ya tenía cuenta; ahora es parte del equipo."
            : "Le mandamos un email para definir su contraseña.",
        });
        setOpen(false);
        setEmail("");
        setName("");
        setAvatar(null);
        setRole("cashier");
        onDone();
      },
      onError: () =>
        toast({ variant: "error", title: "No se pudo invitar", description: "Revisá el email." }),
    });

    return (
      <>
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus size={16} /> Invitar usuario
        </Button>
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Invitar usuario"
          description="Con cuenta y contraseña propias."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
            className="space-y-5"
          >
            <Input
              label="Email"
              type="email"
              required
              placeholder="persona@ejemplo.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Nombre (real o genérico, ej. “Cajero A”)"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
              <Segmented<AssignableRole>
                value={role}
                onChange={setRole}
                options={[
                  { value: "manager", label: "Encargado" },
                  { value: "cashier", label: "Cajero" },
                  { value: "viewer", label: "Solo lectura" },
                ]}
              />
            </div>
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={m.isPending}>
                {m.isPending ? "Enviando…" : "Enviar invitación"}
              </Button>
            </div>
          </form>
        </Modal>
      </>
    );
  }

  function EditMemberDialog({ member, onDone }: { member: Member; onDone: () => void }) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(member.display_name ?? "");
    const [role, setRole] = useState<AssignableRole>(
      (["manager", "cashier", "viewer"].includes(member.role)
        ? member.role
        : "cashier") as AssignableRole,
    );
    const [avatar, setAvatar] = useState<string | null>(member.avatar);

    const save = useMutation({
      mutationFn: async () => {
        const { error } = await supabase.functions.invoke("member_admin", {
          body: {
            action: "update_member",
            user_id: member.user_id,
            display_name: name.trim(),
            role,
            avatar,
          },
        });
        if (error) throw error;
      },
      onSuccess: () => {
        toast({ variant: "success", title: "Miembro actualizado" });
        setOpen(false);
        onDone();
      },
      onError: () => toast({ variant: "error", title: "No se pudo actualizar" }),
    });

    const toggleStatus = useMutation({
      mutationFn: async () => {
        const status = member.status === "suspended" ? "active" : "suspended";
        const { error } = await supabase.functions.invoke("member_admin", {
          body: { action: "set_member_status", user_id: member.user_id, status },
        });
        if (error) throw error;
      },
      onSuccess: () => {
        toast({ variant: "success", title: "Estado actualizado" });
        setOpen(false);
        onDone();
      },
      onError: () => toast({ variant: "error", title: "No se pudo cambiar el estado" }),
    });

    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Editar miembro"
        >
          <Pencil size={15} />
        </button>
        <Modal open={open} onOpenChange={setOpen} title={`Editar a ${name || member.email || "miembro"}`}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="space-y-5"
          >
            <Input label="Nombre" required value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
              <Segmented<AssignableRole>
                value={role}
                onChange={setRole}
                options={[
                  { value: "manager", label: "Encargado" },
                  { value: "cashier", label: "Cajero" },
                  { value: "viewer", label: "Solo lectura" },
                ]}
              />
            </div>
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <Button
                type="button"
                variant={member.status === "suspended" ? "secondary" : "ghost"}
                onClick={() => toggleStatus.mutate()}
                disabled={toggleStatus.isPending}
                className={member.status !== "suspended" ? "text-destructive" : ""}
              >
                {member.status === "suspended" ? "Reactivar" : "Suspender"}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Guardando…" : "Guardar"}
              </Button>
            </div>
          </form>
        </Modal>
      </>
    );
  }

  function ProfileDialog({
    tenantId: _tid,
    profile,
    onDone,
  }: {
    tenantId: string;
    profile?: Profile;
    onDone: () => void;
  }) {
    const editing = !!profile;
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(profile?.display_name ?? "");
    const [avatar, setAvatar] = useState<string | null>(profile?.avatar ?? null);
    const [pin, setPin] = useState("");

    const save = useMutation({
      mutationFn: async () => {
        const body = editing
          ? {
              action: "update_profile",
              profile_id: profile!.id,
              display_name: name.trim(),
              avatar,
              ...(pin ? { pin } : {}),
            }
          : {
              action: "create_profile",
              display_name: name.trim(),
              avatar,
              ...(pin ? { pin } : {}),
            };
        const { error } = await supabase.functions.invoke("member_admin", { body });
        if (error) throw error;
      },
      onSuccess: () => {
        toast({ variant: "success", title: editing ? "Perfil actualizado" : "Perfil creado" });
        setOpen(false);
        if (!editing) {
          setName("");
          setAvatar(null);
        }
        setPin("");
        onDone();
      },
      onError: () => toast({ variant: "error", title: "No se pudo guardar el perfil" }),
    });

    const toggleStatus = useMutation({
      mutationFn: async () => {
        const status = profile!.status === "suspended" ? "active" : "suspended";
        const { error } = await supabase.functions.invoke("member_admin", {
          body: { action: "set_profile_status", profile_id: profile!.id, status },
        });
        if (error) throw error;
      },
      onSuccess: () => {
        toast({ variant: "success", title: "Estado actualizado" });
        setOpen(false);
        onDone();
      },
      onError: () => toast({ variant: "error", title: "No se pudo cambiar el estado" }),
    });

    return (
      <>
        {editing ? (
          <button
            onClick={() => setOpen(true)}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Editar perfil"
          >
            <Pencil size={15} />
          </button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <IdCard size={16} /> Perfil sin login
          </Button>
        )}
        <Modal
          open={open}
          onOpenChange={setOpen}
          title={editing ? `Editar ${name}` : "Nuevo perfil sin login"}
          description="Etiqueta para identificar quién vende (ej. “Cajero A”). Sin email ni cuenta."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            className="space-y-5"
          >
            <Input label="Nombre" required value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} />
            </div>
            <Input
              label="PIN (opcional, para fichar en el POS)"
              inputMode="numeric"
              placeholder={editing ? "Dejar vacío para no cambiar" : "Ej. 1234"}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
            />
            <div className="flex items-center justify-between pt-1">
              {editing ? (
                <Button
                  type="button"
                  variant={profile!.status === "suspended" ? "secondary" : "ghost"}
                  onClick={() => toggleStatus.mutate()}
                  disabled={toggleStatus.isPending}
                  className={profile!.status !== "suspended" ? "text-destructive" : ""}
                >
                  {profile!.status === "suspended" ? "Reactivar" : "Suspender"}
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Guardando…" : editing ? "Guardar" : "Crear perfil"}
              </Button>
            </div>
          </form>
        </Modal>
      </>
    );
  }
}
