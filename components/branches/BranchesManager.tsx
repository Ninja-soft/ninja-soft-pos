"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Clock,
  CreditCard,
  FileSearch,
  ImageIcon,
  LayoutGrid,
  MapPin,
  MonitorSmartphone,
  MoreHorizontal,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  Printer,
  Receipt,
  SlidersHorizontal,
  Star,
  Store,
  Users,
  Wallet,
  Copy,
  BookmarkPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from "@/components/ui/Dropdown";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { StoreFormModal } from "@/components/branches/StoreFormModal";
import { CopySetupModal, SaveTemplateModal, StoreTemplatesModal } from "@/components/branches/StoreSetup";
import { RegisterFormModal } from "@/components/branches/RegisterFormModal";
import { CashMonitor } from "@/components/cash/CashMonitor";
import { StaffBoard } from "@/components/staff/StaffBoard";
import { EYEBROW, FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { useBranchLogos, useBranchMutations, useBranches, useBranchScope, useStaffAssignments } from "@/modules/branches/hooks";
import {
  allowedStoreIds,
  assignmentsOf,
  branchErrorMessage,
  REGISTER_KIND_LABEL,
  summarizeOpeningHours,
  todayAR,
  WEEK_DAYS,
  type Branch,
  type BranchRegister,
  type StaffRole,
} from "@/modules/branches/logic";
import { useCashMonitor } from "@/modules/cash/hooks";
import type { MonitorShift } from "@/modules/cash/api";
import { useOwnerStats } from "@/modules/dashboard/ownerStats";
import { useStaffPeople } from "@/modules/staff/hooks";
import { useAuditSearch } from "@/modules/security/hooks";
import { useLimit } from "@/modules/saas/gating";
import { auditActionLabel } from "@/lib/security/auditLabels";
import { capitalizeName, formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Confirm = { kind: "archive-store"; branch: Branch } | { kind: "archive-register"; register: BranchRegister } | null;
type Tab = "resumen" | "cajas" | "personal" | "configuracion" | "historial";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

// Logo de la sucursal (logo_url, lo administra Configuración de la sucursal) o
// iniciales sobre el color de la sucursal.
export function BranchLogo({ branch, logo, size = 48 }: { branch: Branch; logo?: string | null; size?: number }) {
  return logo ? (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={branch.name} className="h-full w-full object-contain" />
    </span>
  ) : (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-md font-display font-bold text-foreground"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: branch.color ? `${branch.color}2e` : "var(--muted)",
        color: branch.color ?? undefined,
      }}
    >
      {initials(branch.short_name || branch.name)}
    </span>
  );
}

function StatusPill({ branch }: { branch: Branch }) {
  if (branch.deleted_at) return <Badge tone="neutral">Archivada</Badge>;
  if (!branch.is_active) return <Badge tone="warning">Pausada</Badge>;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden /> Activa
    </span>
  );
}

// Configuración · Sucursales y cajas (F17 · H89 + H91, rediseño ADR-051).
// Tablero de sucursales con lo que importa para operar (cajas abiertas,
// personal de hoy, ventas de hoy) y detalle por sucursal con pestañas. La
// primera sucursal y caja son BASE; la segunda pide `multi_sucursal` y la
// segunda caja de una sucursal `multi_caja` (el servidor rechaza igual).
export function BranchesManager() {
  const { toast } = useToast();
  const { data: branches, isLoading } = useBranches();
  const { data: logos = {} } = useBranchLogos();
  const scope = useBranchScope();
  const m = useBranchMutations();
  const canManage = scope.data?.role === "owner" || scope.data?.role === "manager";
  const maxStores = useLimit("max_stores");
  const maxRegisters = useLimit("max_registers_per_store");
  const storeGate = useFeatureGate("multi_sucursal", "Multi-sucursal");
  const registerGate = useFeatureGate("multi_caja", "Multi-caja");
  const { data: shifts = [] } = useCashMonitor(null, canManage);
  const { data: stats } = useOwnerStats(null);
  const { data: people = [] } = useStaffPeople(canManage);
  const { data: assignments = [] } = useStaffAssignments();

  const [showArchived, setShowArchived] = useState(false);
  const [storeModal, setStoreModal] = useState<{ open: boolean; branch: Branch | null }>({ open: false, branch: null });
  const [regModal, setRegModal] = useState<{ open: boolean; register: BranchRegister | null; storeId: string }>({
    open: false,
    register: null,
    storeId: "",
  });
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [detail, setDetail] = useState<{ id: string; tab: Tab } | null>(null);
  // Plantillas y "Copiar de" (F17 · ADR-057).
  const [copyTo, setCopyTo] = useState<Branch | null>(null);
  const [saveTpl, setSaveTpl] = useState<Branch | null>(null);
  const [tplList, setTplList] = useState(false);

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
  const today = todayAR();

  const staffCount = (storeId: string) =>
    people.filter((p) => {
      if (p.state.status !== "active") return false;
      if (p.role === "owner") return false;
      const mine = assignmentsOf(assignments, { userId: p.user_id, profileId: p.profile_id });
      return allowedStoreIds({ role: (p.role ?? "cashier") as StaffRole, stores: branches ?? [], assignments: mine, today }).includes(storeId);
    }).length;

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

  const storeActions = {
    edit: (b: Branch) => setStoreModal({ open: true, branch: b }),
    setDefault: (b: Branch) => run(m.setDefaultStore.mutateAsync(b.id), `${b.name} es la sucursal principal`),
    togglePause: (b: Branch) =>
      run(m.updateStore.mutateAsync({ id: b.id, patch: { is_active: !b.is_active } }), b.is_active ? "Sucursal pausada" : "Sucursal activa"),
    archive: (b: Branch) => setConfirm({ kind: "archive-store", branch: b }),
    restore: (b: Branch) => storeGate.run(() => run(m.restoreStore.mutateAsync(b.id), "Sucursal restaurada")),
    copyFrom: (b: Branch) => storeGate.run(() => setCopyTo(b)),
    saveTemplate: (b: Branch) => storeGate.run(() => setSaveTpl(b)),
  };
  const registerActions = {
    add: newRegister,
    edit: (r: BranchRegister) => setRegModal({ open: true, register: r, storeId: r.store_id }),
    toggle: (r: BranchRegister) =>
      run(m.updateRegister.mutateAsync({ id: r.id, patch: { is_active: !r.is_active } }), r.is_active ? "Caja pausada" : "Caja activa"),
    archive: (r: BranchRegister) => setConfirm({ kind: "archive-register", register: r }),
    restore: (r: BranchRegister) => run(m.restoreRegister.mutateAsync(r.id), "Caja restaurada"),
  };

  const detailBranch = detail ? (list.find((b) => b.id === detail.id) ?? null) : null;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{live.length}</span> {live.length === 1 ? "sucursal" : "sucursales"}
            {maxStores !== null ? ` de ${maxStores} en tu plan` : ""}
          </span>
          {maxRegisters !== null && <span>Hasta {maxRegisters} {maxRegisters === 1 ? "caja" : "cajas"} por sucursal</span>}
          {archived.length > 0 && (
            <label className="flex items-center gap-2">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} label="Ver archivadas" />
              Archivadas ({archived.length})
            </label>
          )}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {live.length > 1 && (
              <Button size="sm" variant="secondary" onClick={() => storeGate.run(() => setTplList(true))}>
                Plantillas
              </Button>
            )}
            <Button size="sm" className={SOLID_CTA} onClick={newStore}>
              <Plus size={16} /> Nueva sucursal
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <SpinnerBlock className="py-10" />
      ) : visible.length === 0 ? (
        <div className={FLAT_PANEL}>
          <EmptyState icon={Store} title="Todavía no cargaste sucursales" description="Creá tu primera sucursal con su caja para empezar a vender." />
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((b) => {
            const open = shifts.filter((s) => s.store_id === b.id);
            const regs = b.registers.filter((r) => !r.deleted_at);
            const sales = stats?.by_store.find((s) => s.store_id === b.id);
            const address = [b.address, b.city].filter(Boolean).join(", ");
            return (
              <li key={b.id}>
                <article className={cn(FLAT_PANEL, "flex h-full flex-col", b.deleted_at && "opacity-70")}>
                  <div className="flex items-start gap-3 p-4">
                    <BranchLogo branch={b} logo={logos[b.id]} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="truncate font-display text-base font-semibold">{b.name}</h3>
                        {b.code && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{b.code}</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StatusPill branch={b} />
                        {b.is_default && !b.deleted_at && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Sucursal principal: la que ven por defecto los cajeros sin sucursal asignada">
                            <Star size={12} aria-hidden /> Principal
                          </span>
                        )}
                      </div>
                    </div>
                    {canManage && <StoreMenu branch={b} actions={storeActions} />}
                  </div>

                  <div className="space-y-1 px-4 text-xs text-muted-foreground">
                    <p className="flex items-center gap-1.5 truncate">
                      <MapPin size={12} className="shrink-0" aria-hidden /> {address || "Sin dirección cargada"}
                    </p>
                    <p className="flex items-center gap-1.5 truncate">
                      <Clock size={12} className="shrink-0" aria-hidden /> {summarizeOpeningHours(b.opening_hours)}
                    </p>
                  </div>

                  {!b.deleted_at && (
                    <div className="mt-4 grid grid-cols-3 gap-2 px-4">
                      <Metric label={canManage ? "Abiertas" : "Cajas"} value={canManage ? `${open.length}/${regs.length}` : String(regs.length)} />
                      <Metric label="Personal" value={canManage ? String(staffCount(b.id)) : "Sin datos"} />
                      <Metric label="Hoy" value={sales ? formatCurrency(sales.today_total) : "Sin datos"} />
                    </div>
                  )}

                  {!b.deleted_at && regs.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 px-4">
                      {regs.map((r) => {
                        const s = open.find((x) => x.register_id === r.id);
                        return (
                          <span
                            key={r.id}
                            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"
                            title={s ? `Abierta por ${s.opened_by_name}` : r.is_active ? "Libre" : "Pausada"}
                          >
                            <span
                              aria-hidden
                              className={cn("h-1.5 w-1.5 rounded-full", s ? "bg-success" : r.is_active ? "bg-muted-foreground/50" : "bg-warning")}
                            />
                            {r.name}
                            {s && <span className="text-muted-foreground">· {capitalizeName(s.opened_by_name).split(" ")[0]}</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="mt-auto flex items-center gap-2 border-t border-border p-3 pt-3">
                    <Button size="sm" variant="ghost" className="flex-1 justify-between" onClick={() => setDetail({ id: b.id, tab: "resumen" })}>
                      Ver sucursal <ChevronRight size={16} aria-hidden />
                    </Button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <BranchDetailModal
        branch={detailBranch}
        tab={detail?.tab ?? "resumen"}
        onTab={(t) => setDetail((d) => (d ? { ...d, tab: t } : d))}
        onClose={() => setDetail(null)}
        logo={detailBranch ? logos[detailBranch.id] : null}
        shifts={shifts}
        canManage={canManage}
        maxRegisters={maxRegisters}
        storeActions={storeActions}
        registerActions={registerActions}
        currentUserId={scope.data?.userId ?? ""}
        tenantId={scope.data?.tenantId ?? ""}
        myRole={scope.data?.role ?? null}
        salesToday={detailBranch ? stats?.by_store.find((s) => s.store_id === detailBranch.id) : undefined}
      />

      <StoreFormModal open={storeModal.open} onOpenChange={(o) => setStoreModal((s) => ({ ...s, open: o }))} branch={storeModal.branch} />
      <CopySetupModal open={copyTo !== null} onOpenChange={(o) => !o && setCopyTo(null)} target={copyTo} branches={live} />
      <SaveTemplateModal open={saveTpl !== null} onOpenChange={(o) => !o && setSaveTpl(null)} from={saveTpl} />
      <StoreTemplatesModal open={tplList} onOpenChange={setTplList} />
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted px-2.5 py-2">
      <p className="truncate font-display text-base font-bold tabular-nums leading-tight">{value}</p>
      <p className="truncate text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

type StoreActions = {
  edit: (b: Branch) => void;
  setDefault: (b: Branch) => void;
  togglePause: (b: Branch) => void;
  archive: (b: Branch) => void;
  restore: (b: Branch) => void;
  copyFrom: (b: Branch) => void;
  saveTemplate: (b: Branch) => void;
};
type RegisterActions = {
  add: (b: Branch) => void;
  edit: (r: BranchRegister) => void;
  toggle: (r: BranchRegister) => void;
  archive: (r: BranchRegister) => void;
  restore: (r: BranchRegister) => void;
};

function StoreMenu({ branch: b, actions }: { branch: Branch; actions: StoreActions }) {
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          type="button"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Acciones de ${b.name}`}
        >
          <MoreHorizontal size={18} />
        </button>
      </DropdownTrigger>
      <DropdownContent align="end">
        {b.deleted_at ? (
          <DropdownItem onSelect={() => actions.restore(b)}>
            <ArchiveRestore size={15} /> Restaurar
          </DropdownItem>
        ) : (
          <>
            <DropdownItem onSelect={() => actions.edit(b)}>
              <Pencil size={15} /> Editar datos
            </DropdownItem>
            {!b.is_default && b.is_active && (
              <DropdownItem onSelect={() => actions.setDefault(b)}>
                <Star size={15} /> Hacer principal
              </DropdownItem>
            )}
            <DropdownItem onSelect={() => actions.togglePause(b)}>
              {b.is_active ? <Pause size={15} /> : <Play size={15} />}
              {b.is_active ? "Pausar" : "Reactivar"}
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={() => actions.copyFrom(b)}>
              <Copy size={15} /> Copiar configuración de...
            </DropdownItem>
            <DropdownItem onSelect={() => actions.saveTemplate(b)}>
              <BookmarkPlus size={15} /> Guardar como plantilla
            </DropdownItem>
            {!b.is_default && (
              <>
                <DropdownSeparator />
                <DropdownItem onSelect={() => actions.archive(b)} className="text-destructive">
                  <Archive size={15} /> Archivar
                </DropdownItem>
              </>
            )}
          </>
        )}
      </DropdownContent>
    </Dropdown>
  );
}

const CONFIG_LINKS: { seccion: string; label: string; desc: string; icon: React.ElementType }[] = [
  { seccion: "marca", label: "Logo y datos del ticket", desc: "Logo propio de la sucursal y encabezado de los comprobantes.", icon: ImageIcon },
  { seccion: "pagos", label: "Medios de pago", desc: "Qué medios se aceptan acá, recargos y números de comercio.", icon: CreditCard },
  { seccion: "hardware", label: "Terminales y lectores", desc: "Point, posnet y lectores de cada caja.", icon: MonitorSmartphone },
  { seccion: "impresion", label: "Impresoras", desc: "Ticketera de cada caja, copias y comandas.", icon: Printer },
  { seccion: "tickets", label: "Tickets", desc: "Plantilla de ticket y leyendas de la sucursal.", icon: Receipt },
  { seccion: "operacion", label: "Operación", desc: "Redondeo, stock negativo y cierre de caja.", icon: SlidersHorizontal },
];

function BranchDetailModal({
  branch,
  tab,
  onTab,
  onClose,
  logo,
  shifts,
  canManage,
  maxRegisters,
  storeActions,
  registerActions,
  currentUserId,
  tenantId,
  myRole,
  salesToday,
}: {
  branch: Branch | null;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  logo: string | null | undefined;
  shifts: MonitorShift[];
  canManage: boolean;
  maxRegisters: number | null;
  storeActions: StoreActions;
  registerActions: RegisterActions;
  currentUserId: string;
  tenantId: string;
  myRole: StaffRole | null;
  salesToday: { today_total: number; today_count: number; yesterday_total: number } | undefined;
}) {
  if (!branch) return <Modal open={false} onOpenChange={() => undefined} />;
  const regs = [...branch.registers].sort(
    (x, y) => Number(Boolean(x.deleted_at)) - Number(Boolean(y.deleted_at)) || x.sort - y.sort || x.created_at.localeCompare(y.created_at),
  );
  const liveRegs = regs.filter((r) => !r.deleted_at);
  const atLimit = maxRegisters !== null && liveRegs.length >= maxRegisters;
  const archived = Boolean(branch.deleted_at);

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={branch.name}
      className="sm:max-w-3xl"
      header={
        <div className="flex items-center gap-3">
          <BranchLogo branch={branch} logo={logo} size={52} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{branch.name}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <StatusPill branch={branch} />
              {branch.is_default && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Star size={12} aria-hidden /> Principal
                </span>
              )}
              {branch.code && <span className="font-mono text-xs text-muted-foreground">{branch.code}</span>}
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="slim-scrollbar -mx-1 overflow-x-auto px-1">
          <Segmented
            size="sm"
            value={tab}
            onChange={onTab}
            aria-label="Sección de la sucursal"
            options={[
              { value: "resumen", label: "Resumen", icon: <LayoutGrid size={14} /> },
              { value: "cajas", label: "Cajas", icon: <Wallet size={14} /> },
              ...(canManage ? [{ value: "personal" as const, label: "Personal", icon: <Users size={14} /> }] : []),
              { value: "configuracion", label: "Configuración", icon: <SlidersHorizontal size={14} /> },
              ...(canManage ? [{ value: "historial" as const, label: "Historial", icon: <FileSearch size={14} /> }] : []),
            ]}
          />
        </div>

        {tab === "resumen" && (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Ventas hoy" value={salesToday ? formatCurrency(salesToday.today_total) : "Sin datos"} />
              <Metric label="Tickets hoy" value={salesToday ? String(salesToday.today_count) : "Sin datos"} />
              <Metric label="Ayer" value={salesToday ? formatCurrency(salesToday.yesterday_total) : "Sin datos"} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 text-sm">
                <p className={EYEBROW}>Datos</p>
                <p className="flex items-start gap-2">
                  <MapPin size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                  {[branch.address, branch.city, branch.province, branch.postal_code].filter(Boolean).join(", ") || "Sin dirección"}
                </p>
                {branch.phone && (
                  <p className="flex items-center gap-2">
                    <Phone size={15} className="shrink-0 text-muted-foreground" aria-hidden /> {branch.phone}
                  </p>
                )}
                {branch.afip_pos_number && (
                  <p className="flex items-center gap-2">
                    <Receipt size={15} className="shrink-0 text-muted-foreground" aria-hidden /> Punto de venta{" "}
                    {String(branch.afip_pos_number).padStart(5, "0")}
                  </p>
                )}
                {canManage && !archived && (
                  <Button size="sm" variant="secondary" className="mt-1" onClick={() => storeActions.edit(branch)}>
                    <Pencil size={15} /> Editar datos
                  </Button>
                )}
              </div>
              <div className="text-sm">
                <p className={EYEBROW}>Horario</p>
                <dl className="mt-2 divide-y divide-border rounded-md border border-border">
                  {WEEK_DAYS.map((d) => {
                    const r = branch.opening_hours[d.key] ?? [];
                    return (
                      <div key={d.key} className="flex justify-between px-3 py-1.5">
                        <dt className="text-muted-foreground">{d.label}</dt>
                        <dd className="tabular-nums">{r.length ? r.map((x) => `${x.from} a ${x.to}`).join(", ") : "Cerrado"}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            </div>
            {canManage && !archived && (
              <div>
                <p className={cn(EYEBROW, "mb-3")}>Cajas abiertas ahora</p>
                <CashMonitor compact storeId={branch.id} />
              </div>
            )}
          </div>
        )}

        {tab === "cajas" && (
          <div className="space-y-3">
            {canManage && !archived && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {liveRegs.length} {liveRegs.length === 1 ? "caja" : "cajas"}
                  {maxRegisters !== null ? ` de ${maxRegisters} en tu plan` : ""}
                </p>
                <Button size="sm" variant="secondary" disabled={atLimit} onClick={() => registerActions.add(branch)}>
                  <Plus size={15} /> Agregar caja
                </Button>
              </div>
            )}
            <ul className="space-y-2">
              {regs.map((r) => {
                const s = shifts.find((x) => x.register_id === r.id);
                const rArchived = Boolean(r.deleted_at);
                return (
                  <li key={r.id} className={cn(FLAT_PANEL, "flex items-center gap-3 p-3", rArchived && "opacity-60")}>
                    <span
                      className={cn(
                        "grid h-10 w-10 shrink-0 place-items-center rounded-md",
                        s ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Wallet size={18} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold">{r.name}</span>
                        {r.code && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{r.code}</span>}
                        <span className="text-xs text-muted-foreground">{REGISTER_KIND_LABEL[r.kind]}</span>
                        {!r.is_active && !rArchived && <Badge tone="warning">Pausada</Badge>}
                        {rArchived && <Badge tone="neutral">Archivada</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {s
                          ? `Abierta por ${capitalizeName(s.opened_by_name)} desde las ${new Date(s.opened_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`
                          : r.is_active && !rArchived
                            ? "Libre"
                            : ""}
                        {[r.device_notes, r.printer_notes].filter(Boolean).length > 0 &&
                          ` · ${[r.device_notes, r.printer_notes].filter(Boolean).join(" · ")}`}
                      </p>
                    </div>
                    {canManage && !archived && (
                      <Dropdown>
                        <DropdownTrigger asChild>
                          <button
                            type="button"
                            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={`Acciones de ${r.name}`}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </DropdownTrigger>
                        <DropdownContent align="end">
                          {rArchived ? (
                            <DropdownItem onSelect={() => registerActions.restore(r)}>
                              <ArchiveRestore size={15} /> Restaurar
                            </DropdownItem>
                          ) : (
                            <>
                              <DropdownItem onSelect={() => registerActions.edit(r)}>
                                <Pencil size={15} /> Editar
                              </DropdownItem>
                              <DropdownItem onSelect={() => registerActions.toggle(r)}>
                                {r.is_active ? <Pause size={15} /> : <Play size={15} />}
                                {r.is_active ? "Pausar" : "Reactivar"}
                              </DropdownItem>
                              <DropdownSeparator />
                              <DropdownItem onSelect={() => registerActions.archive(r)} className="text-destructive">
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
        )}

        {tab === "personal" && canManage && (
          <Suspense fallback={null}>
            <StaffBoard currentUserId={currentUserId} tenantId={tenantId} myRole={myRole} storeFilter={branch.id} hideHeader />
          </Suspense>
        )}

        {tab === "configuracion" && (
          <div className="space-y-3">
            <Callout tone="neutral">
              Lo que no cambies acá se hereda del negocio. Cada pantalla abre con esta sucursal elegida.
            </Callout>
            <ul className="grid gap-2 sm:grid-cols-2">
              {CONFIG_LINKS.map((c) => (
                <li key={c.seccion}>
                  <Link
                    href={`/configuracion?seccion=${c.seccion}&sucursal=${branch.id}` as never}
                    className={cn(FLAT_PANEL, "flex h-full items-start gap-3 p-3 transition-colors hover:bg-muted/50")}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted">
                      <c.icon size={17} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{c.label}</span>
                      <span className="block text-xs text-muted-foreground">{c.desc}</span>
                    </span>
                    <ChevronRight size={16} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "historial" && canManage && <BranchHistory storeId={branch.id} />}
      </div>
    </Modal>
  );
}

function BranchHistory({ storeId }: { storeId: string }) {
  const { data, error, isLoading } = useAuditSearch({ store: storeId, limit: 30, offset: 0 });
  if (isLoading) return <SpinnerBlock className="py-8" />;
  if (error) {
    return (
      <Callout tone="neutral" title="El historial completo está en Seguridad y auditoría">
        {/feature_not_in_plan/.test(error instanceof Error ? error.message : "")
          ? "El visor de auditoría está en planes superiores; el registro se guarda igual."
          : "No pudimos cargar el historial."}
      </Callout>
    );
  }
  const rows = data?.rows ?? [];
  if (rows.length === 0) return <EmptyState compact icon={FileSearch} title="Sin movimientos registrados" />;
  return (
    <div className="space-y-3">
      <ol className="relative space-y-3 border-l border-border pl-5">
        {rows.map((r) => (
          <li key={r.id} className="relative">
            <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-muted-foreground/60" aria-hidden />
            <p className="text-sm font-medium">{auditActionLabel(r.action)}</p>
            <p className="text-xs text-muted-foreground">
              {new Date(r.created_at).toLocaleString("es-AR")} · {r.actor_name ? capitalizeName(r.actor_name) : "Sistema"}
              {r.reason ? ` · ${r.reason}` : ""}
            </p>
          </li>
        ))}
      </ol>
      <Link href={"/configuracion?seccion=seguridad" as never} className="inline-flex items-center gap-1 text-sm font-semibold hover:underline">
        Ver toda la auditoría <ChevronRight size={14} aria-hidden />
      </Link>
    </div>
  );
}
