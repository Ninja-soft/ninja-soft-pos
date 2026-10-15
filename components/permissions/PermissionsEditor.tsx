"use client";

import { useMemo, useState } from "react";
import { Copy, Eye, Lock, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from "@/components/ui/Dropdown";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { RoleBadgeIcon } from "@/components/permissions/permUi";
import { RoleEditorModal, draftFromRole, type EditorMode, type RoleDraft } from "@/components/permissions/RoleEditorModal";
import { PermissionMatrix } from "@/components/permissions/PermissionMatrix";
import { PeoplePermissions } from "@/components/permissions/PeoplePermissions";
import { CompareRoles } from "@/components/permissions/CompareRoles";
import { BASE_LABEL, MODULES, moduleLevel, LEVEL_LABEL } from "@/lib/permissions/capabilities";
import { EDITABLE_TOTAL, copyName, permissionErrorMessage } from "@/lib/permissions/editor";
import { usePermissionMutations, usePermissionOverview } from "@/modules/permissions/hooks";
import type { PermRole } from "@/modules/permissions/api";
import { cn } from "@/lib/utils/cn";

type Tab = "roles" | "people" | "matrix" | "compare";

/**
 * Roles y permisos del negocio (ADR-138). Roles de sistema y propios, quién
 * tiene cada uno, matriz avanzada y comparación. Todo lo valida y audita el
 * servidor; la pantalla sólo ofrece lo que la base va a aceptar.
 */
export function PermissionsEditor() {
  const { data, isLoading, error } = usePermissionOverview();
  const [tab, setTab] = useState<Tab>("roles");
  const [editor, setEditor] = useState<{ draft: RoleDraft; readOnly: boolean; members: number; mode: EditorMode } | null>(null);
  const [deleting, setDeleting] = useState<PermRole | null>(null);
  const gate = useFeatureGate("roles_permisos", "Roles y permisos a medida");

  const names = useMemo(() => (data?.roles ?? []).map((r) => r.name), [data]);

  if (isLoading) return <SpinnerBlock className="py-16" />;
  if (error || !data) {
    return (
      <div className={FLAT_PANEL}>
        <EmptyState
          compact
          icon={ShieldCheck}
          title="No pudimos cargar los permisos"
          description={permissionErrorMessage(error)}
        />
      </div>
    );
  }

  const ownerEdits = data.is_owner;
  const system = data.roles.filter((r) => r.system);
  const custom = data.roles.filter((r) => !r.system);

  const openRole = (r: PermRole, mode: EditorMode = "simple") =>
    setEditor({ draft: draftFromRole(r), readOnly: r.system || !ownerEdits, members: r.members, mode });
  const newRole = (from?: PermRole) =>
    gate.run(() =>
      setEditor({
        draft: from
          ? { ...draftFromRole(from), id: null, name: copyName(from.name, names), template: from.key }
          : { id: null, name: "", description: "", color: "teal", icon: "user", base: "cashier", capabilities: [], template: null },
        readOnly: false,
        members: 0,
        mode: "simple",
      }),
    );

  return (
    <div className="space-y-6">
      {!data.feature && (
        <Callout
          tone="neutral"
          icon={Lock}
          title="Tu plan usa los roles de sistema"
          actions={
            ownerEdits ? (
              <Button size="sm" variant="secondary" onClick={() => gate.run(() => undefined)}>
                Ver planes
              </Button>
            ) : undefined
          }
        >
          Dueño, Encargado, Cajero, Solo lectura, Vendedor y Auditor funcionan en todos los planes. Para crear roles propios,
          dar un rol distinto por sucursal con roles propios y conceder o quitar permisos puntuales, pasá a Business.
        </Callout>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          scrollOnMobile
          size="sm"
          value={tab}
          onChange={setTab}
          aria-label="Vista"
          options={[
            { value: "roles", label: "Roles" },
            { value: "people", label: data.can_manage ? "Personas" : "Mis permisos" },
            { value: "matrix", label: "Matriz" },
            { value: "compare", label: "Comparar" },
          ]}
        />
        {ownerEdits && tab === "roles" && (
          <Button size="sm" className={SOLID_CTA} onClick={() => newRole()}>
            <Plus size={16} /> Nuevo rol
          </Button>
        )}
      </div>

      {tab === "roles" && (
        <div className="space-y-6">
          <RoleGroup title="Roles propios" empty={ownerEdits ? "Creá uno de cero o duplicá Cajero o Encargado para empezar." : "Todavía no hay roles propios."}>
            {custom.map((r) => (
              <RoleCard key={r.id} role={r} onOpen={openRole} onDuplicate={ownerEdits ? newRole : undefined} onDelete={ownerEdits ? setDeleting : undefined} />
            ))}
          </RoleGroup>
          <RoleGroup title="Roles de sistema">
            {system.map((r) => (
              <RoleCard key={r.id} role={r} onOpen={openRole} onDuplicate={ownerEdits && r.base !== "owner" ? newRole : undefined} />
            ))}
          </RoleGroup>
        </div>
      )}

      {tab === "people" && <PeoplePermissions data={data} />}
      {tab === "matrix" && <PermissionMatrix roles={data.roles} editable={ownerEdits && data.feature} />}
      {tab === "compare" && <CompareRoles roles={data.roles} />}

      <RoleEditorModal
        open={Boolean(editor)}
        onOpenChange={(o) => !o && setEditor(null)}
        initial={editor?.draft ?? null}
        readOnly={editor?.readOnly ?? true}
        members={editor?.members ?? 0}
        initialMode={editor?.mode ?? "simple"}
        takenNames={names.filter((n) => n !== (editor?.draft.id ? editor.draft.name : ""))}
      />
      <DeleteRoleModal role={deleting} roles={data.roles} onClose={() => setDeleting(null)} />
      {gate.modal}
    </div>
  );
}
PermissionsEditor.displayName = "PermissionsEditor";

function RoleGroup({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode[] }) {
  return (
    <section>
      <h3 className="mb-2 font-display text-sm font-semibold">{title}</h3>
      {children.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
      )}
    </section>
  );
}

function RoleCard({
  role,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  role: PermRole;
  onOpen: (r: PermRole, mode?: EditorMode) => void;
  onDuplicate?: (r: PermRole) => void;
  onDelete?: (r: PermRole) => void;
}) {
  const isOwner = role.base === "owner";
  const total = isOwner ? EDITABLE_TOTAL : role.capabilities.length;
  const strong = MODULES.filter((m) => !isOwner && moduleLevel(role.capabilities, m.key, role.base) !== "none");
  return (
    <li className={cn(FLAT_PANEL, "flex h-full flex-col p-3.5")}>
      <div className="flex items-start gap-3">
        <RoleBadgeIcon color={role.color} icon={role.icon} />
        <button type="button" onClick={() => onOpen(role)} className="min-w-0 flex-1 text-left">
          <p className="truncate font-semibold hover:underline">{role.name}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{role.description || `Nivel base ${BASE_LABEL[role.base]}`}</p>
        </button>
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              type="button"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Acciones de ${role.name}`}
            >
              <MoreHorizontal size={18} />
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            <DropdownItem onSelect={() => onOpen(role)}>
              {role.system ? <Eye size={15} /> : <Pencil size={15} />} {role.system ? "Ver permisos" : "Editar"}
            </DropdownItem>
            {!role.system && (
              <DropdownItem onSelect={() => onOpen(role, "advanced")}>
                <Pencil size={15} /> Editar en modo avanzado
              </DropdownItem>
            )}
            {onDuplicate && (
              <DropdownItem onSelect={() => onDuplicate(role)}>
                <Copy size={15} /> Duplicar
              </DropdownItem>
            )}
            {onDelete && (
              <>
                <DropdownSeparator />
                <DropdownItem onSelect={() => onDelete(role)} className="text-destructive">
                  <Trash2 size={15} /> Borrar
                </DropdownItem>
              </>
            )}
          </DropdownContent>
        </Dropdown>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{role.system ? "Sistema" : "Propio"}</Badge>
        {!isOwner && <Badge tone="neutral">Nivel {BASE_LABEL[role.base]}</Badge>}
        <Badge tone="neutral">
          <Users size={11} aria-hidden /> {role.members}
        </Badge>
        <Badge tone="neutral">{isOwner ? "Todo" : `${total} permisos`}</Badge>
      </div>
      {strong.length > 0 && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
          {strong
            .map((m) => `${m.label}: ${LEVEL_LABEL[moduleLevel(role.capabilities, m.key, role.base) as keyof typeof LEVEL_LABEL]}`)
            .join(" · ")}
        </p>
      )}
    </li>
  );
}

function DeleteRoleModal({ role, roles, onClose }: { role: PermRole | null; roles: PermRole[]; onClose: () => void }) {
  const { toast } = useToast();
  const m = usePermissionMutations();
  const targets = roles.filter((r) => r.id !== role?.id && r.base !== "owner");
  const [to, setTo] = useState<string | null>(null);
  const fallback = targets.find((r) => r.system && r.base === role?.base)?.id ?? targets[0]?.id ?? null;
  const target = to ?? fallback;

  async function confirm() {
    if (!role || !target) return;
    try {
      const n = await m.deleteRole.mutateAsync({ id: role.id, reassignTo: target });
      toast({
        variant: "success",
        title: `Rol ${role.name} borrado`,
        description: n > 0 ? `${n === 1 ? "1 persona pasó" : `${n} personas pasaron`} a ${roles.find((r) => r.id === target)?.name}.` : undefined,
      });
      setTo(null);
      onClose();
    } catch (e) {
      toast({ variant: "error", title: permissionErrorMessage(e) });
    }
  }

  return (
    <Modal
      open={Boolean(role)}
      onOpenChange={(o) => {
        if (!o) {
          setTo(null);
          onClose();
        }
      }}
      title={role ? `Borrar ${role.name}` : "Borrar rol"}
      description="El rol queda en la historia de auditoría. Quienes lo tienen pasan al rol que elijas."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={confirm} loading={m.deleteRole.isPending} disabled={!target}>
            Borrar y reasignar
          </Button>
        </div>
      }
    >
      {role && (
        <div className="space-y-3">
          <p className="text-sm">
            {role.members === 0
              ? "Nadie tiene este rol ahora."
              : `${role.members === 1 ? "1 persona tiene" : `${role.members} personas tienen`} este rol, también en sucursales.`}
          </p>
          <Select
            label="Pasan a"
            value={target}
            onChange={setTo}
            options={targets.map((r) => ({ value: r.id, label: r.name, description: `${r.system ? "Sistema" : "Propio"} · nivel ${BASE_LABEL[r.base]}` }))}
          />
        </div>
      )}
    </Modal>
  );
}
