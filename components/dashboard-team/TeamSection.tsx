"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Pencil, IdCard, Check, ImagePlus, Users, MapPin } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Avatar, AVATAR_ICONS, AVATAR_PRESETS } from "@/components/ui/Avatar";
import { useAvatarUpload } from "@/components/account/AvatarUploader";
import { ChoiceCard, CHOICE_ON } from "@/components/ui/ChoiceCard";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "@/components/ui/Spinner";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { StaffBranchesModal } from "@/components/branches/StaffBranchesModal";
import { useBranchContext, useBranches, useStaffAssignments, type StaffPerson } from "@/modules/branches/hooks";
import { allowedStoreIds, assignmentsOf, todayAR, type StaffRole } from "@/modules/branches/logic";

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

const ROLE_OPTIONS: { value: AssignableRole; label: string; desc: string }[] = [
  { value: "manager", label: "Encargado", desc: "Opera todo: ventas, caja y stock. No cambia el plan." },
  { value: "cashier", label: "Cajero", desc: "Vende y cobra en el POS con su propia caja." },
  { value: "viewer", label: "Solo lectura", desc: "Ve reportes y comprobantes, no modifica nada." },
];

// Selector de rol como tarjetas con una línea que explica qué puede hacer.
function RolePicker({
  value,
  onChange,
}: {
  value: AssignableRole;
  onChange: (v: AssignableRole) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Rol" className="grid gap-2 sm:grid-cols-3">
      {ROLE_OPTIONS.map((o) => (
        <ChoiceCard
          key={o.value}
          selected={value === o.value}
          onClick={() => onChange(o.value)}
          title={o.label}
          description={o.desc}
          className="p-3 pr-8"
        />
      ))}
    </div>
  );
}

// Insignia de check compacta para tiles chicos (la de .choice-check es para cards).
function TileCheck() {
  return (
    <span
      aria-hidden
      className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-ninja-flame text-white shadow-sm"
    >
      <Check size={10} strokeWidth={3.5} />
    </span>
  );
}

const TILE =
  "relative grid aspect-square w-full place-items-center rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const tileClass = (on: boolean) =>
  cn(
    TILE,
    on
      ? cn(CHOICE_ON, "text-foreground")
      : "bg-muted text-muted-foreground hover:bg-secondary hover:text-foreground",
  );

// Sucursales al invitar (F17 · H91): chips multi-selección. La primera elegida
// queda como base y el resto como acceso adicional. Sin elegir ninguna rigen
// las reglas de siempre (encargado = todas; cajero = la principal).
function InviteBranchesPicker({
  branches,
  value,
  onChange,
}: {
  branches: { id: string; name: string; short_name: string | null }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-muted-foreground">Sucursales</span>
      <div className="flex flex-wrap gap-2">
        {branches.map((b) => {
          const on = value.includes(b.id);
          const idx = value.indexOf(b.id);
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(b.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? cn(CHOICE_ON, "text-foreground")
                  : "bg-muted text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <MapPin size={14} aria-hidden />
              {b.short_name || b.name}
              {idx === 0 && <span className="text-[11px] text-muted-foreground">(base)</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        La primera que elijas queda como su sucursal base; las demás, como acceso adicional. Si no
        elegís ninguna, un encargado ve todas y un cajero, la principal.
      </p>
    </div>
  );
}

// Grilla de avatares: iniciales + iconos + foto propia (subir / la ya subida),
// todos como tiles iguales. La vista previa vive fuera (encabezado del modal).
function AvatarPicker({
  value,
  onChange,
  name,
  tenantId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  name: string;
  tenantId: string;
}) {
  const isUrl = !!value && /^https?:\/\//.test(value);
  // Recordamos la última foto para poder volver a elegirla tras probar un icono.
  const [photo, setPhoto] = useState<string | null>(isUrl ? value : null);
  const upload = useAvatarUpload({
    value: isUrl ? value : photo,
    onChange: (url) => {
      setPhoto(url);
      onChange(url);
    },
    name,
    bucket: "tenant-assets",
    pathPrefix: `${tenantId}/members`,
  });

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Avatar"
        className="grid grid-cols-7 gap-1.5 sm:grid-cols-10"
      >
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          onClick={() => onChange(null)}
          className={tileClass(value === null)}
          title="Iniciales"
          aria-label="Iniciales"
        >
          <Avatar name={name || "?"} size={26} />
          {value === null && <TileCheck />}
        </button>
        {AVATAR_PRESETS.map((key) => {
          const Icon = AVATAR_ICONS[key];
          const on = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(key)}
              className={tileClass(on)}
              title={key}
              aria-label={key}
            >
              {Icon ? <Icon size={20} strokeWidth={1.9} /> : null}
              {on && <TileCheck />}
            </button>
          );
        })}
        {photo && (
          <button
            type="button"
            role="radio"
            aria-checked={value === photo}
            onClick={() => onChange(photo)}
            className={cn(tileClass(value === photo), "p-1")}
            title="Foto propia"
            aria-label="Foto propia"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo} alt="" className="h-full w-full rounded object-cover" />
            {value === photo && <TileCheck />}
          </button>
        )}
        <button
          type="button"
          onClick={upload.openPicker}
          disabled={upload.uploading}
          className={cn(
            TILE,
            "border border-dashed border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50",
          )}
          title={photo ? "Subir otra foto" : "Subir foto"}
          aria-label={photo ? "Subir otra foto" : "Subir foto"}
        >
          {upload.uploading ? <Spinner /> : <ImagePlus size={20} strokeWidth={1.9} />}
        </button>
      </div>
      {isUrl && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Foto propia</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={upload.openViewer}
            className="font-medium text-foreground hover:underline"
          >
            Ver
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={upload.download}
            disabled={upload.downloading}
            className="font-medium text-foreground hover:underline disabled:opacity-50"
          >
            Descargar
          </button>
        </div>
      )}
      {upload.dialogs}
    </div>
  );
}

// Vista previa del miembro: se actualiza mientras se completa el formulario.
function MemberPreview({
  name,
  email,
  avatar,
  role,
}: {
  name: string;
  email: string;
  avatar: string | null;
  role: AssignableRole;
}) {
  const n = name.trim();
  const e = email.trim();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted p-3.5">
      <Avatar name={n || e || "?"} avatar={avatar} size={48} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-semibold",
            n ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {n ? capitalizeName(n) : "Nombre del miembro"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {e || "persona@ejemplo.com"}
        </p>
      </div>
      <span className="shrink-0 rounded-md bg-background px-2 py-0.5 text-xs font-medium text-foreground">
        {ROLE_LABELS[role]}
      </span>
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

  // Personal por sucursal (F17 · H91): sólo con más de una sucursal viva.
  const { data: branches = [] } = useBranches();
  const { data: assignments = [] } = useStaffAssignments();
  const liveBranches = branches.filter((b) => !b.deleted_at);
  const multiBranch = liveBranches.length > 1;
  const branchGate = useFeatureGate("multi_sucursal", "Multi-sucursal");
  const [staffPerson, setStaffPerson] = useState<StaffPerson | null>(null);
  const today = todayAR();
  const branchesOf = (role: StaffRole | null, userId: string | null, profileId: string | null) => {
    if (role === "owner") return "Todas";
    const ids = allowedStoreIds({
      role: role ?? "cashier",
      stores: branches,
      assignments: assignmentsOf(assignments, { userId, profileId }),
      today,
    });
    const live = ids.filter((id) => liveBranches.some((b) => b.id === id));
    if (live.length === liveBranches.length) return "Todas";
    return live
      .map((id) => {
        const b = liveBranches.find((x) => x.id === id);
        return b?.short_name || b?.name || "";
      })
      .join(", ");
  };
  const openBranches = (p: StaffPerson) => branchGate.run(() => setStaffPerson(p));

  // Nombre visible: capitaliza el nombre real; el email se muestra tal cual.
  const memberName = (m: Member) => {
    const human = m.display_name || m.full_name;
    if (human) return capitalizeName(human);
    return m.email || "Miembro";
  };

  return (
    <section>
      <SectionHeader
        title="Equipo"
        icon={Users}
        description="Quiénes usan tu NinjaPos y con qué permisos."
        actions={
          canManage ? (
            <>
              <ProfileDialog tenantId={tenantId} onDone={refresh} />
              <InviteDialog onDone={refresh} />
            </>
          ) : undefined
        }
      />

      {/* Usuarios con login */}
      <Card className="mt-3">
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Miembro</th>
                <th className="px-4 py-3">Rol</th>
                {multiBranch && <th className="px-4 py-3">Sucursales</th>}
                <th className="px-4 py-3">Estado</th>
                {canManage && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr>
                  <td colSpan={multiBranch ? 5 : 4} className="text-center px-4 py-6 text-muted-foreground">
                    <Spinner />
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan={multiBranch ? 5 : 4} className="px-4 py-6 text-muted-foreground">
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
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{memberName(m)}</span>
                            {m.user_id === currentUserId && (
                              <span className="shrink-0 rounded-full bg-ninja-flame/12 px-1.5 py-0.5 text-[10px] font-semibold text-ninja-flameSoft">
                                vos
                              </span>
                            )}
                          </div>
                          {m.email && memberName(m) !== m.email && (
                            <div className="truncate text-xs text-muted-foreground">
                              {m.email}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{ROLE_LABELS[m.role] ?? m.role}</td>
                    {multiBranch && (
                      <td className="px-4 py-3 text-muted-foreground">
                        {branchesOf(m.role as StaffRole, m.user_id, null)}
                      </td>
                    )}
                    <td className="px-4 py-3 text-muted-foreground">
                      {STATUS_LABELS[m.status] ?? m.status}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        {multiBranch && m.role !== "owner" && (
                          <button
                            type="button"
                            onClick={() =>
                              openBranches({
                                key: `u:${m.user_id}`,
                                userId: m.user_id,
                                profileId: null,
                                name: memberName(m),
                                role: m.role as StaffRole,
                              })
                            }
                            className="mr-1 inline-grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
                            title="Sucursales y traslados"
                            aria-label={`Sucursales y traslados de ${memberName(m)}`}
                          >
                            <MapPin size={16} />
                          </button>
                        )}
                        {(m.user_id === currentUserId || m.role !== "owner") && (
                          <EditMemberDialog
                            member={m}
                            isSelf={m.user_id === currentUserId}
                            onDone={refresh}
                          />
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
                            <span className="font-medium">
                              {capitalizeName(p.display_name)}
                            </span>
                          </div>
                        </td>
                        {multiBranch && (
                          <td className="px-4 py-3 text-muted-foreground">
                            {branchesOf(null, null, p.id)}
                          </td>
                        )}
                        <td className="px-4 py-3 text-muted-foreground">
                          {STATUS_LABELS[p.status] ?? p.status}
                        </td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            {multiBranch && (
                              <button
                                type="button"
                                onClick={() =>
                                  openBranches({
                                    key: `p:${p.id}`,
                                    userId: null,
                                    profileId: p.id,
                                    name: capitalizeName(p.display_name),
                                    role: null,
                                  })
                                }
                                className="mr-1 inline-grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                title="Sucursales y traslados"
                                aria-label={`Sucursales y traslados de ${p.display_name}`}
                              >
                                <MapPin size={16} />
                              </button>
                            )}
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

      <StaffBranchesModal
        open={Boolean(staffPerson)}
        onOpenChange={(o) => !o && setStaffPerson(null)}
        person={staffPerson}
      />
      {branchGate.modal}
    </section>
  );

  // --- Diálogos (closures sobre supabase/toast) ---

  function InviteDialog({ onDone }: { onDone: () => void }) {
    const [open, setOpen] = useState(false);
    // Acceso rápido del panel: el link "#invitar" abre este diálogo. Limpiamos
    // el hash al abrir para que se pueda volver a usar.
    useEffect(() => {
      function fromHash() {
        if (window.location.hash !== "#invitar") return;
        window.history.replaceState(null, "", "#equipo");
        setOpen(true);
      }
      fromHash();
      window.addEventListener("hashchange", fromHash);
      return () => window.removeEventListener("hashchange", fromHash);
    }, []);
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [role, setRole] = useState<AssignableRole>("cashier");
    const [avatar, setAvatar] = useState<string | null>(null);
    const branchCtx = useBranchContext();
    const [storeIds, setStoreIds] = useState<string[]>([]);

    const m = useMutation({
      mutationFn: async () => {
        const { data, error } = await supabase.functions.invoke("invite_user", {
          body: {
            email: email.trim().toLowerCase(),
            role,
            display_name: name.trim(),
            avatar,
            ...(branchCtx.isMulti && storeIds.length > 0 ? { store_ids: storeIds } : {}),
          },
        });
        if (error) throw error;
        return data as { existed: boolean; branches_error?: string | null };
      },
      onSuccess: (d) => {
        toast({
          variant: "success",
          title: d?.existed ? "Usuario agregado" : "Invitación enviada",
          description: d?.existed
            ? "Ya tenía cuenta; ahora es parte del equipo."
            : "Le mandamos un email para definir su contraseña.",
        });
        if (d?.branches_error) {
          toast({
            variant: "error",
            title: "No se pudieron asignar las sucursales",
            description: "Asignalas desde Personal por sucursal.",
          });
        }
        setOpen(false);
        setEmail("");
        setName("");
        setAvatar(null);
        setRole("cashier");
        setStoreIds([]);
        qc.invalidateQueries({ queryKey: ["branches"] });
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
          description="Tendrá su propio acceso con email y contraseña."
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" form="invite-user-form" loading={m.isPending}>
                <UserPlus size={16} /> Enviar invitación
              </Button>
            </>
          }
        >
          <form
            id="invite-user-form"
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate();
            }}
            className="space-y-5"
          >
            <MemberPreview name={name} email={email} avatar={avatar} role={role} />
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
              hint="Puede ser real o genérico, ej. “Cajero A”."
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
              <RolePicker value={role} onChange={setRole} />
            </div>
            {branchCtx.isMulti && branchCtx.allowed.length > 1 && (
              <InviteBranchesPicker branches={branchCtx.allowed} value={storeIds} onChange={setStoreIds} />
            )}
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
            </div>
          </form>
        </Modal>
      </>
    );
  }

  function EditMemberDialog({
    member,
    isSelf,
    onDone,
  }: {
    member: Member;
    isSelf: boolean;
    onDone: () => void;
  }) {
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
            // No se cambia el propio rol desde acá.
            ...(isSelf ? {} : { role }),
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
            {!isSelf && (
              <div>
                <span className="mb-2 block text-sm font-medium text-muted-foreground">Rol</span>
                <RolePicker value={role} onChange={setRole} />
              </div>
            )}
            <div>
              <span className="mb-2 block text-sm font-medium text-muted-foreground">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
            </div>
            <div className="flex items-center justify-between pt-1">
              {isSelf ? (
                <span />
              ) : (
                <Button
                  type="button"
                  variant={member.status === "suspended" ? "secondary" : "ghost"}
                  onClick={() => toggleStatus.mutate()}
                  disabled={toggleStatus.isPending}
                  className={member.status !== "suspended" ? "text-destructive" : ""}
                >
                  {member.status === "suspended" ? "Reactivar" : "Suspender"}
                </Button>
              )}
              <Button type="submit" loading={save.isPending}>
                Guardar
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
              <AvatarPicker value={avatar} onChange={setAvatar} name={name} tenantId={tenantId} />
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
              <Button type="submit" loading={save.isPending}>
                {editing ? "Guardar" : "Crear perfil"}
              </Button>
            </div>
          </form>
        </Modal>
      </>
    );
  }
}
