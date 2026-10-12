"use client";

import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Clock,
  MapPin,
  MoreHorizontal,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  Receipt,
  Star,
  Users,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { StoreFormModal } from "@/components/branches/StoreFormModal";
import { RegisterFormModal } from "@/components/branches/RegisterFormModal";
import { StaffBranchesModal } from "@/components/branches/StaffBranchesModal";
import {
  useBranchMutations,
  useBranches,
  useBranchScope,
  useStaffAssignments,
  useStaffDirectory,
  type StaffPerson,
} from "@/modules/branches/hooks";
import {
  allowedStoreIds,
  assignmentsOf,
  assignmentStatus,
  branchErrorMessage,
  KIND_LABEL,
  liveRegisters,
  periodLabel,
  REGISTER_KIND_LABEL,
  summarizeOpeningHours,
  todayAR,
  type Branch,
  type BranchRegister,
} from "@/modules/branches/logic";
import { useLimit } from "@/modules/saas/gating";
import { cn } from "@/lib/utils/cn";

type Confirm =
  | { kind: "archive-store"; branch: Branch }
  | { kind: "archive-register"; register: BranchRegister }
  | null;

// Configuración · Sucursales y cajas (F17 · H89 + H91). La primera sucursal y
// su primera caja son BASE; la segunda sucursal pide `multi_sucursal` y la
// segunda caja de una sucursal pide `multi_caja`. El servidor rechaza igual
// (triggers con feature y límite del plan): esto sólo anticipa con el aviso.
export function BranchesManager() {
  const { toast } = useToast();
  const { data: branches, isLoading } = useBranches();
  const scope = useBranchScope();
  const m = useBranchMutations();
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";
  const maxStores = useLimit("max_stores");
  const maxRegisters = useLimit("max_registers_per_store");
  const storeGate = useFeatureGate("multi_sucursal", "Multi-sucursal");
  const registerGate = useFeatureGate("multi_caja", "Multi-caja");

  const [showArchived, setShowArchived] = useState(false);
  const [storeModal, setStoreModal] = useState<{ open: boolean; branch: Branch | null }>({ open: false, branch: null });
  const [regModal, setRegModal] = useState<{ open: boolean; register: BranchRegister | null; storeId: string }>({
    open: false,
    register: null,
    storeId: "",
  });
  const [confirm, setConfirm] = useState<Confirm>(null);

  const list = useMemo(
    () =>
      [...(branches ?? [])].sort(
        (a, b) =>
          Number(Boolean(a.deleted_at)) - Number(Boolean(b.deleted_at)) ||
          Number(b.is_default) - Number(a.is_default) ||
          a.sort - b.sort ||
          a.created_at.localeCompare(b.created_at),
      ),
    [branches],
  );
  const live = list.filter((b) => !b.deleted_at);
  const archived = list.filter((b) => b.deleted_at);
  const visible = showArchived ? list : live;

  function newStore() {
    const open = () => setStoreModal({ open: true, branch: null });
    if (live.length >= 1) storeGate.run(open);
    else open();
  }
  function newRegister(b: Branch) {
    const open = () => setRegModal({ open: true, register: null, storeId: b.id });
    if (b.registers.some((r) => !r.deleted_at)) registerGate.run(open);
    else open();
  }

  async function run(p: Promise<unknown>, ok: string) {
    try {
      await p;
      toast({ title: ok, variant: "success" });
    } catch (e) {
      toast({ title: branchErrorMessage(e), variant: "error" });
    }
  }

  async function onConfirm(reason: string) {
    if (!confirm) return;
    if (confirm.kind === "archive-store") {
      await run(m.archiveStore.mutateAsync({ id: confirm.branch.id, reason: reason || null }), "Sucursal archivada");
    } else {
      await run(m.archiveRegister.mutateAsync({ id: confirm.register.id, reason: reason || null }), "Caja archivada");
    }
    setConfirm(null);
  }

  return (
    <section className="space-y-4">
      {/* El título y la bajada los pone SettingsSection (Configuración). */}
      {canManage && (
        <div>
          <Button size="sm" onClick={newStore}>
            <Plus size={16} /> Nueva sucursal
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {live.length} {live.length === 1 ? "sucursal" : "sucursales"}
          {maxStores !== null ? ` de ${maxStores} en tu plan` : ""}
          {maxRegisters !== null ? ` · hasta ${maxRegisters} ${maxRegisters === 1 ? "caja" : "cajas"} por sucursal` : ""}
        </span>
        {archived.length > 0 && (
          <label className="flex items-center gap-2">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} label="Ver archivadas" />
            Ver archivadas ({archived.length})
          </label>
        )}
      </div>

      {isLoading ? (
        <SpinnerBlock className="py-10" />
      ) : (
        <div className="space-y-3">
          {visible.map((b) => (
            <BranchCard
              key={b.id}
              branch={b}
              canManage={canManage}
              maxRegisters={maxRegisters}
              onEdit={() => setStoreModal({ open: true, branch: b })}
              onSetDefault={() => run(m.setDefaultStore.mutateAsync(b.id), `${b.name} es la sucursal principal`)}
              onTogglePause={() =>
                run(
                  m.updateStore.mutateAsync({ id: b.id, patch: { is_active: !b.is_active } }),
                  b.is_active ? "Sucursal pausada" : "Sucursal activa",
                )
              }
              onArchive={() => setConfirm({ kind: "archive-store", branch: b })}
              onRestore={() => storeGate.run(() => run(m.restoreStore.mutateAsync(b.id), "Sucursal restaurada"))}
              onAddRegister={() => newRegister(b)}
              onEditRegister={(r) => setRegModal({ open: true, register: r, storeId: b.id })}
              onToggleRegister={(r) =>
                run(
                  m.updateRegister.mutateAsync({ id: r.id, patch: { is_active: !r.is_active } }),
                  r.is_active ? "Caja pausada" : "Caja activa",
                )
              }
              onArchiveRegister={(r) => setConfirm({ kind: "archive-register", register: r })}
              onRestoreRegister={(r) => run(m.restoreRegister.mutateAsync(r.id), "Caja restaurada")}
            />
          ))}
        </div>
      )}

      <StaffByBranch branches={live} canManage={canManage} />

      <StoreFormModal
        open={storeModal.open}
        onOpenChange={(o) => setStoreModal((s) => ({ ...s, open: o }))}
        branch={storeModal.branch}
      />
      <RegisterFormModal
        open={regModal.open}
        onOpenChange={(o) => setRegModal((s) => ({ ...s, open: o }))}
        register={regModal.register}
        storeId={regModal.storeId}
        branches={live}
      />
      <ConfirmDialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "archive-store" ? `Archivar ${confirm.branch.name}` : "Archivar la caja"}
        description={
          confirm?.kind === "archive-store"
            ? "Deja de aparecer para vender y en los selectores. Sus ventas, turnos y cierres quedan en el historial y la podés restaurar."
            : "Deja de aparecer en el POS. Sus turnos y cierres quedan en el historial."
        }
        confirmLabel="Archivar"
        danger
        withReason
        reasonPlaceholder="Ej.: cierre del local"
        loading={m.archiveStore.isPending || m.archiveRegister.isPending}
        onConfirm={onConfirm}
      />
      {storeGate.modal}
      {registerGate.modal}
    </section>
  );
}

function BranchCard({
  branch: b,
  canManage,
  maxRegisters,
  onEdit,
  onSetDefault,
  onTogglePause,
  onArchive,
  onRestore,
  onAddRegister,
  onEditRegister,
  onToggleRegister,
  onArchiveRegister,
  onRestoreRegister,
}: {
  branch: Branch;
  canManage: boolean;
  maxRegisters: number | null;
  onEdit: () => void;
  onSetDefault: () => void;
  onTogglePause: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onAddRegister: () => void;
  onEditRegister: (r: BranchRegister) => void;
  onToggleRegister: (r: BranchRegister) => void;
  onArchiveRegister: (r: BranchRegister) => void;
  onRestoreRegister: (r: BranchRegister) => void;
}) {
  const archived = Boolean(b.deleted_at);
  const regs = [...b.registers].sort(
    (x, y) => Number(Boolean(x.deleted_at)) - Number(Boolean(y.deleted_at)) || x.sort - y.sort || x.created_at.localeCompare(y.created_at),
  );
  const liveRegs = regs.filter((r) => !r.deleted_at);
  const atLimit = maxRegisters !== null && liveRegs.length >= maxRegisters;
  const address = [b.address, b.city, b.province].filter(Boolean).join(", ");

  return (
    <Card className={cn(archived && "opacity-70")}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <BranchDot branch={b} className="mt-1.5 h-3 w-3" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-display text-base font-semibold">{b.name}</h3>
              {b.code && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{b.code}</span>}
              {b.is_default && !archived && <Badge tone="brand">Principal</Badge>}
              {!b.is_active && !archived && <Badge tone="warning">Pausada</Badge>}
              {archived && <Badge tone="neutral">Archivada</Badge>}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {address && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={12} aria-hidden /> {address}
                </span>
              )}
              {b.phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone size={12} aria-hidden /> {b.phone}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Clock size={12} aria-hidden /> {summarizeOpeningHours(b.opening_hours)}
              </span>
              {b.afip_pos_number && (
                <span className="inline-flex items-center gap-1">
                  <Receipt size={12} aria-hidden /> PV {String(b.afip_pos_number).padStart(5, "0")}
                </span>
              )}
            </div>
            {archived && b.archived_reason && (
              <p className="mt-1 text-xs text-muted-foreground">Motivo: {b.archived_reason}</p>
            )}
          </div>
          {canManage && (
            <Dropdown>
              <DropdownTrigger asChild>
                <button
                  type="button"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Acciones de ${b.name}`}
                >
                  <MoreHorizontal size={18} />
                </button>
              </DropdownTrigger>
              <DropdownContent>
                {archived ? (
                  <DropdownItem onSelect={onRestore}>
                    <ArchiveRestore size={15} /> Restaurar
                  </DropdownItem>
                ) : (
                  <>
                    <DropdownItem onSelect={onEdit}>
                      <Pencil size={15} /> Editar datos
                    </DropdownItem>
                    {!b.is_default && b.is_active && (
                      <DropdownItem onSelect={onSetDefault}>
                        <Star size={15} /> Hacer principal
                      </DropdownItem>
                    )}
                    <DropdownItem onSelect={onTogglePause}>
                      {b.is_active ? <Pause size={15} /> : <Play size={15} />}
                      {b.is_active ? "Pausar" : "Reactivar"}
                    </DropdownItem>
                    {!b.is_default && (
                      <>
                        <DropdownSeparator />
                        <DropdownItem onSelect={onArchive} className="text-destructive">
                          <Archive size={15} /> Archivar
                        </DropdownItem>
                      </>
                    )}
                  </>
                )}
              </DropdownContent>
            </Dropdown>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Cajas ({liveRegs.length})
            </span>
            {canManage && !archived && (
              <button
                type="button"
                onClick={onAddRegister}
                disabled={atLimit}
                title={atLimit ? "Llegaste al máximo de cajas por sucursal de tu plan" : undefined}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Plus size={13} /> Agregar caja
              </button>
            )}
          </div>
          <ul className="divide-y divide-border">
            {regs.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">Sin cajas.</li>}
            {regs.map((r) => {
              const rArchived = Boolean(r.deleted_at);
              return (
                <li key={r.id} className={cn("flex items-center gap-3 px-3 py-2.5", rArchived && "opacity-60")}>
                  <span
                    aria-hidden
                    className={cn("h-2 w-2 shrink-0 rounded-full", r.is_active && !rArchived ? "bg-success" : "bg-muted-foreground/50")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.name}</span>
                      {r.code && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{r.code}</span>}
                      <span className="text-xs text-muted-foreground">{REGISTER_KIND_LABEL[r.kind]}</span>
                      {!r.is_active && !rArchived && <Badge tone="warning">Pausada</Badge>}
                      {rArchived && <Badge tone="neutral">Archivada</Badge>}
                    </div>
                    {(r.device_notes || r.printer_notes) && (
                      <div className="truncate text-xs text-muted-foreground">
                        {[r.device_notes, r.printer_notes].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                  {canManage && !archived && (
                    <Dropdown>
                      <DropdownTrigger asChild>
                        <button
                          type="button"
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                          aria-label={`Acciones de ${r.name}`}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                      </DropdownTrigger>
                      <DropdownContent>
                        {rArchived ? (
                          <DropdownItem onSelect={() => onRestoreRegister(r)}>
                            <ArchiveRestore size={15} /> Restaurar
                          </DropdownItem>
                        ) : (
                          <>
                            <DropdownItem onSelect={() => onEditRegister(r)}>
                              <Pencil size={15} /> Editar
                            </DropdownItem>
                            <DropdownItem onSelect={() => onToggleRegister(r)}>
                              {r.is_active ? <Pause size={15} /> : <Play size={15} />}
                              {r.is_active ? "Pausar" : "Reactivar"}
                            </DropdownItem>
                            <DropdownSeparator />
                            <DropdownItem onSelect={() => onArchiveRegister(r)} className="text-destructive">
                              <Archive size={15} /> Archivar
                            </DropdownItem>
                          </>
                        )}
                      </DropdownContent>
                    </Dropdown>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// Personal por sucursal: quién trabaja hoy en cada una y los movimientos
// programados (traslados y coberturas). Gestionar cada persona abre su ficha.
function StaffByBranch({ branches, canManage }: { branches: Branch[]; canManage: boolean }) {
  const { data: people = [] } = useStaffDirectory();
  const { data: assignments = [] } = useStaffAssignments();
  const { data: all = [] } = useBranches();
  const gate = useFeatureGate("multi_sucursal", "Multi-sucursal");
  const [person, setPerson] = useState<StaffPerson | null>(null);
  const today = todayAR();

  if (branches.length < 2) return null;

  const byStore = new Map<string, StaffPerson[]>();
  for (const p of people) {
    const mine = assignmentsOf(assignments, { userId: p.userId, profileId: p.profileId });
    const ids = allowedStoreIds({ role: p.role ?? "cashier", stores: all, assignments: mine, today });
    if (p.role === "owner") continue;
    for (const id of ids) byStore.set(id, [...(byStore.get(id) ?? []), p]);
  }
  const upcoming = assignments
    .filter((a) => assignmentStatus(a, today) === "scheduled")
    .sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  const nameOf = (a: { user_id: string | null; cashier_profile_id: string | null }) =>
    people.find((p) => (a.user_id ? p.userId === a.user_id : p.profileId === a.cashier_profile_id))?.name ?? "Persona";
  const storeName = (id: string) => all.find((b) => b.id === id)?.name ?? "Sucursal";

  return (
    <div className="space-y-3 pt-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Users size={15} aria-hidden /> Personal por sucursal
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {branches.map((b) => (
          <Card key={b.id}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <BranchDot branch={b} /> {b.name}
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {liveRegisters(b.registers).length} {liveRegisters(b.registers).length === 1 ? "caja" : "cajas"}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(byStore.get(b.id) ?? []).length === 0 && (
                  <span className="text-xs text-muted-foreground">Sin personal asignado hoy.</span>
                )}
                {(byStore.get(b.id) ?? []).map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    disabled={!canManage}
                    onClick={() => gate.run(() => setPerson(p))}
                    className="h-8 rounded-full bg-muted px-3 text-xs font-medium transition hover:bg-fg-10 disabled:cursor-default"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {upcoming.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarClock size={15} aria-hidden /> Movimientos programados
            </div>
            <ul className="mt-2 divide-y divide-border">
              {upcoming.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-medium">{nameOf(a)}</span>
                  <span className="text-muted-foreground">→ {storeName(a.store_id)}</span>
                  <span className="text-xs text-muted-foreground">
                    {KIND_LABEL[a.kind]} · {periodLabel(a.valid_from, a.valid_until)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <StaffBranchesModal open={Boolean(person)} onOpenChange={(o) => !o && setPerson(null)} person={person} />
      {gate.modal}
    </div>
  );
}
