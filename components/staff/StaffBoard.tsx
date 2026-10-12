"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRightLeft,
  CalendarClock,
  History,
  IdCard,
  LayoutGrid,
  MapPin,
  MoreHorizontal,
  Pencil,
  ShieldAlert,
  Star,
  UserCheck,
  UserPlus,
  Users,
  UserX,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { SectionHeader } from "@/components/ui/PageHeader";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/Dropdown";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { StaffBranchesModal } from "@/components/branches/StaffBranchesModal";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { EYEBROW, FLAT_PANEL, SOLID_CTA } from "@/components/security/styles";
import { EditMemberModal, InviteMemberModal, NewProfileModal } from "@/components/staff/MemberModals";
import { RehireModal, StaffStatusModal, type StatusFormKind } from "@/components/staff/StatusModals";
import { ROLE_LABELS } from "@/components/staff/staffForms";
import { useBranches, useStaffAssignments } from "@/modules/branches/hooks";
import {
  allowedStoreIds,
  assignmentsOf,
  assignmentStatus,
  formatDay,
  KIND_LABEL,
  periodLabel,
  todayAR,
  type Branch,
  type StaffAssignment,
  type StaffRole,
} from "@/modules/branches/logic";
import { useStaffEvents, useStaffPeople, useStaffStatusMutations } from "@/modules/staff/hooks";
import type { StaffPersonRow, StatusEventRow } from "@/modules/staff/api";
import {
  availableActions,
  canManageStaff,
  EVENT_LABEL,
  LEAVE_LABEL,
  staffErrorMessage,
  STATUS_LABEL,
  statusChipText,
  TERMINATION_LABEL,
  upcomingEvents,
  type LeaveType,
  type StaffStatus,
  type TerminationType,
} from "@/lib/staff/status";
import { capitalizeName } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type Filter = "all" | StaffStatus;
type View = "branches" | "grid";

const STATUS_TONE: Record<StaffStatus, BadgeTone> = {
  active: "success",
  suspended: "danger",
  on_leave: "info",
  terminated: "neutral",
};

const keyOf = (p: StaffPersonRow) => (p.user_id ? `u:${p.user_id}` : `p:${p.profile_id}`);

// Abre el invitado desde el acceso rápido del Panel del dueño: ?invitar=1 (o el
// hash #invitar de links viejos). B-02: antes el modal era un componente
// definido dentro de otro y se remontaba cerrado en cada render.
function useInviteTrigger(open: () => void) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (params.get("invitar") === "1") {
      open();
      const next = new URLSearchParams(params.toString());
      next.delete("invitar");
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}#equipo` as never, { scroll: false });
    }
  }, [params, open, router, pathname]);
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash !== "#invitar") return;
      window.history.replaceState(null, "", "#equipo");
      open();
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [open]);
}

// Personal (F17 · H113): tablero visual por sucursal con estados, ficha con
// historial (estados y traslados), alta, licencias, suspensiones, bajas y
// reingresos. Todo lo valida y audita el servidor.
export function StaffBoard({
  currentUserId,
  tenantId,
  myRole,
  storeFilter = null,
  hideHeader = false,
}: {
  currentUserId: string;
  tenantId: string;
  myRole: StaffRole | null;
  /** Sólo el personal de esta sucursal (detalle de sucursal). */
  storeFilter?: string | null;
  hideHeader?: boolean;
}) {
  const canManage = myRole === "owner" || myRole === "manager";
  const isOwner = myRole === "owner";
  const { data: people, isLoading } = useStaffPeople();
  const { data: events = [] } = useStaffEvents(canManage);
  const { data: branches = [] } = useBranches();
  const { data: assignments = [] } = useStaffAssignments();
  const live = useMemo(() => branches.filter((b) => !b.deleted_at), [branches]);
  const multi = live.length > 1;
  const today = todayAR();
  const branchGate = useFeatureGate("multi_sucursal", "Multi-sucursal");

  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<View>("branches");
  const [q, setQ] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [editing, setEditing] = useState<StaffPersonRow | null>(null);
  const [detail, setDetail] = useState<StaffPersonRow | null>(null);
  const [statusForm, setStatusForm] = useState<{ person: StaffPersonRow; kind: StatusFormKind } | null>(null);
  const [rehire, setRehire] = useState<StaffPersonRow | null>(null);
  const [branchesOf, setBranchesOf] = useState<StaffPersonRow | null>(null);

  const openInvite = useCallback(() => setInviteOpen(true), []);
  useInviteTrigger(openInvite);

  const scopeOf = useCallback(
    (p: StaffPersonRow) => {
      const mine = assignmentsOf(assignments, { userId: p.user_id, profileId: p.profile_id });
      const ids = allowedStoreIds({ role: (p.role ?? "cashier") as StaffRole, stores: branches, assignments: mine, today });
      const liveIds = ids.filter((id) => live.some((b) => b.id === id));
      const home = mine.find((a) => a.kind === "home" && assignmentStatus(a, today) === "active")?.store_id ?? null;
      const cover = mine.find((a) => a.kind === "cover" && assignmentStatus(a, today) === "active") ?? null;
      return { ids: liveIds, home, cover, mine };
    },
    [assignments, branches, live, today],
  );

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (people ?? []).filter((p) => {
      if (filter !== "all" && p.state.status !== filter) return false;
      if (term && !`${p.name} ${p.email ?? ""}`.toLowerCase().includes(term)) return false;
      if (storeFilter && p.state.status !== "terminated" && !scopeOf(p).ids.includes(storeFilter)) return false;
      return true;
    });
  }, [people, filter, q, storeFilter, scopeOf]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, suspended: 0, on_leave: 0, terminated: 0 };
    for (const p of people ?? []) {
      c.all += 1;
      c[p.state.status] += 1;
    }
    return c;
  }, [people]);

  const eventsOf = useCallback(
    (p: StaffPersonRow) =>
      events.filter((e) => (p.user_id ? e.user_id === p.user_id : e.cashier_profile_id === p.profile_id)),
    [events],
  );

  const canManageP = (p: StaffPersonRow) =>
    canManageStaff({
      actorRole: myRole,
      actorId: currentUserId,
      targetRole: p.kind === "profile" ? null : p.role,
      targetId: p.user_id,
    });

  const actions = {
    detail: setDetail,
    edit: setEditing,
    status: (person: StaffPersonRow, kind: StatusFormKind) => setStatusForm({ person, kind }),
    rehire: setRehire,
    branches: (p: StaffPersonRow) => branchGate.run(() => setBranchesOf(p)),
  };

  const grouped = useMemo(() => {
    if (!multi || view !== "branches" || storeFilter) return null;
    const active = list.filter((p) => p.state.status !== "terminated");
    return live.map((b) => ({
      branch: b,
      people: active.filter((p) => p.role === "owner" || scopeOf(p).ids.includes(b.id)),
    }));
  }, [multi, view, storeFilter, list, live, scopeOf]);
  const terminated = list.filter((p) => p.state.status === "terminated");

  return (
    <section>
      {!hideHeader && (
        <SectionHeader
          title="Equipo"
          icon={Users}
          description="Quiénes trabajan en tu negocio, en qué sucursal y en qué estado."
          actions={
            canManage ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => setProfileOpen(true)}>
                  <IdCard size={16} /> Perfil sin cuenta
                </Button>
                <Button size="sm" className={SOLID_CTA} onClick={openInvite}>
                  <UserPlus size={16} /> Invitar usuario
                </Button>
              </>
            ) : undefined
          }
        />
      )}

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          aria-label="Estado"
          options={[
            { value: "all", label: `Todos ${counts.all}` },
            { value: "active", label: `Activos ${counts.active}` },
            { value: "on_leave", label: `Licencia ${counts.on_leave}` },
            { value: "suspended", label: `Suspendidos ${counts.suspended}` },
            { value: "terminated", label: `Baja ${counts.terminated}` },
          ]}
        />
        <div className="flex flex-1 items-center gap-2">
          <SearchField value={q} onValueChange={setQ} placeholder="Buscar por nombre o email" className="lg:max-w-xs" />
          {multi && !storeFilter && (
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              aria-label="Vista"
              iconOnlyOnMobile
              options={[
                { value: "branches", label: "Por sucursal", icon: <MapPin size={14} /> },
                { value: "grid", label: "Todos", icon: <LayoutGrid size={14} /> },
              ]}
            />
          )}
        </div>
      </div>

      <div className="mt-4 space-y-6">
        {isLoading ? (
          <SpinnerBlock className="py-10" />
        ) : list.length === 0 ? (
          <div className={FLAT_PANEL}>
            <EmptyState
              compact
              icon={Users}
              title={q || filter !== "all" ? "Nadie con ese filtro" : "Acá vas a ver a tu equipo"}
              description={canManage && !q && filter === "all" ? "Invitá a alguien con su email o creá un perfil sin cuenta." : undefined}
            />
          </div>
        ) : grouped ? (
          <>
            {grouped.map((g) => (
              <div key={g.branch.id}>
                <div className="mb-2 flex items-center gap-2">
                  <BranchDot branch={g.branch} className="h-3 w-3" />
                  <h3 className="font-display text-sm font-semibold">{g.branch.name}</h3>
                  {g.branch.is_default && <Star size={12} className="text-muted-foreground" aria-label="Principal" />}
                  <span className="text-xs text-muted-foreground">{g.people.length}</span>
                </div>
                {g.people.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
                    Nadie trabaja hoy en esta sucursal.
                  </p>
                ) : (
                  <PeopleGrid
                    people={g.people}
                    branches={live}
                    scopeOf={scopeOf}
                    eventsOf={eventsOf}
                    currentUserId={currentUserId}
                    canManageP={canManageP}
                    multi={multi}
                    storeId={g.branch.id}
                    actions={actions}
                  />
                )}
              </div>
            ))}
            {terminated.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <UserX size={14} className="text-muted-foreground" aria-hidden />
                  <h3 className="font-display text-sm font-semibold text-muted-foreground">De baja</h3>
                  <span className="text-xs text-muted-foreground">{terminated.length}</span>
                </div>
                <PeopleGrid
                  people={terminated}
                  branches={live}
                  scopeOf={scopeOf}
                  eventsOf={eventsOf}
                  currentUserId={currentUserId}
                  canManageP={canManageP}
                  multi={multi}
                  actions={actions}
                />
              </div>
            )}
          </>
        ) : (
          <PeopleGrid
            people={list}
            branches={live}
            scopeOf={scopeOf}
            eventsOf={eventsOf}
            currentUserId={currentUserId}
            canManageP={canManageP}
            multi={multi}
            actions={actions}
          />
        )}
      </div>

      <InviteMemberModal open={inviteOpen} onOpenChange={setInviteOpen} tenantId={tenantId} isOwner={isOwner} />
      <NewProfileModal open={profileOpen} onOpenChange={setProfileOpen} tenantId={tenantId} />
      <EditMemberModal
        person={editing}
        onOpenChange={(o) => !o && setEditing(null)}
        tenantId={tenantId}
        isOwner={isOwner}
        isSelf={editing?.user_id === currentUserId}
      />
      <StaffStatusModal
        person={statusForm?.person ?? null}
        kind={statusForm?.kind ?? "suspension"}
        events={statusForm ? eventsOf(statusForm.person) : []}
        onClose={() => setStatusForm(null)}
      />
      <RehireModal person={rehire} onClose={() => setRehire(null)} isOwner={isOwner} />
      <StaffBranchesModal
        open={Boolean(branchesOf)}
        onOpenChange={(o) => !o && setBranchesOf(null)}
        person={
          branchesOf
            ? {
                key: keyOf(branchesOf),
                userId: branchesOf.user_id,
                profileId: branchesOf.profile_id,
                name: branchesOf.name,
                role: branchesOf.role as StaffRole | null,
              }
            : null
        }
      />
      <StaffDetailModal
        person={detail}
        onClose={() => setDetail(null)}
        branches={branches}
        assignments={detail ? scopeOf(detail).mine : []}
        events={detail ? eventsOf(detail) : []}
        canManage={detail ? canManageP(detail) : false}
        multi={multi}
        actions={actions}
      />
      {branchGate.modal}
    </section>
  );
}
StaffBoard.displayName = "StaffBoard";

type Actions = {
  detail: (p: StaffPersonRow) => void;
  edit: (p: StaffPersonRow) => void;
  status: (p: StaffPersonRow, k: StatusFormKind) => void;
  rehire: (p: StaffPersonRow) => void;
  branches: (p: StaffPersonRow) => void;
};

function PeopleGrid({
  people,
  branches,
  scopeOf,
  eventsOf,
  currentUserId,
  canManageP,
  multi,
  storeId,
  actions,
}: {
  people: StaffPersonRow[];
  branches: Branch[];
  scopeOf: (p: StaffPersonRow) => { ids: string[]; home: string | null; cover: StaffAssignment | null };
  eventsOf: (p: StaffPersonRow) => StatusEventRow[];
  currentUserId: string;
  canManageP: (p: StaffPersonRow) => boolean;
  multi: boolean;
  storeId?: string;
  actions: Actions;
}) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {people.map((p) => (
        <li key={keyOf(p)}>
          <PersonCard
            p={p}
            branches={branches}
            scope={scopeOf(p)}
            upcoming={upcomingEvents(eventsOf(p), todayAR())[0] ?? null}
            isMe={p.user_id === currentUserId}
            canManage={canManageP(p)}
            multi={multi}
            storeId={storeId}
            actions={actions}
          />
        </li>
      ))}
    </ul>
  );
}

function PersonCard({
  p,
  branches,
  scope,
  upcoming,
  isMe,
  canManage,
  multi,
  storeId,
  actions,
}: {
  p: StaffPersonRow;
  branches: Branch[];
  scope: { ids: string[]; home: string | null; cover: StaffAssignment | null };
  upcoming: { kind: StatusEventRow["kind"]; starts_on: string } | null;
  isMe: boolean;
  canManage: boolean;
  multi: boolean;
  storeId?: string;
  actions: Actions;
}) {
  const st = p.state.status;
  const avail = availableActions(st);
  const byId = new Map(branches.map((b) => [b.id, b]));
  const extraHere = storeId && scope.home && scope.home !== storeId && !scope.cover;
  const coverHere = storeId && scope.cover?.store_id === storeId;
  return (
    <article className={cn(FLAT_PANEL, "flex h-full flex-col p-3.5", st === "terminated" && "opacity-75")}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => actions.detail(p)} className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Ficha de ${p.name}`}>
          <Avatar name={p.name} avatar={p.avatar} size={44} />
        </button>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => actions.detail(p)} className="flex max-w-full items-center gap-1.5 text-left">
            <span className="truncate font-semibold hover:underline">{capitalizeName(p.name)}</span>
            {isMe && <Badge tone="neutral" className="px-1.5 py-0 text-[10px]">vos</Badge>}
          </button>
          <p className="truncate text-xs text-muted-foreground">
            {p.kind === "profile" ? "Perfil sin cuenta" : (ROLE_LABELS[p.role ?? ""] ?? p.role)}
            {p.email ? ` · ${p.email}` : ""}
          </p>
        </div>
        {(canManage || isMe) && (
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`Acciones de ${p.name}`}
              >
                <MoreHorizontal size={18} />
              </button>
            </DropdownTrigger>
            <DropdownContent align="end">
              <DropdownItem onSelect={() => actions.detail(p)}>
                <History size={15} /> Ficha e historial
              </DropdownItem>
              <DropdownItem onSelect={() => actions.edit(p)}>
                <Pencil size={15} /> Editar datos
              </DropdownItem>
              {canManage && multi && st !== "terminated" && (
                <DropdownItem onSelect={() => actions.branches(p)}>
                  <ArrowRightLeft size={15} /> Sucursales y traslados
                </DropdownItem>
              )}
              {canManage && (
                <>
                  <DropdownSeparator />
                  {avail.includes("leave") && (
                    <DropdownItem onSelect={() => actions.status(p, "leave")}>
                      <CalendarClock size={15} /> Licencia
                    </DropdownItem>
                  )}
                  {avail.includes("suspend") && (
                    <DropdownItem onSelect={() => actions.status(p, "suspension")}>
                      <ShieldAlert size={15} /> Suspender
                    </DropdownItem>
                  )}
                  {avail.includes("lift") && (
                    <DropdownItem onSelect={() => actions.detail(p)}>
                      <UserCheck size={15} /> {st === "on_leave" ? "Terminar la licencia" : "Levantar la suspensión"}
                    </DropdownItem>
                  )}
                  {avail.includes("rehire") && (
                    <DropdownItem onSelect={() => actions.rehire(p)}>
                      <UserCheck size={15} /> Reingreso
                    </DropdownItem>
                  )}
                  {avail.includes("terminate") && (
                    <DropdownItem onSelect={() => actions.status(p, "termination")} className="text-destructive">
                      <UserX size={15} /> Dar de baja
                    </DropdownItem>
                  )}
                </>
              )}
            </DropdownContent>
          </Dropdown>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {st !== "active" && <Badge tone={STATUS_TONE[st]}>{statusChipText(p.state)}</Badge>}
        {st === "active" && p.membership_status === "invited" && <Badge tone="info">Invitación pendiente</Badge>}
        {coverHere && <Badge tone="info">Cubre hasta {formatDay(scope.cover!.valid_until)}</Badge>}
        {extraHere && <Badge tone="neutral">Adicional</Badge>}
        {multi && !storeId && st !== "terminated" &&
          (p.role === "owner" || scope.ids.length === branches.length ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              <MapPin size={11} aria-hidden /> Todas las sucursales
            </span>
          ) : (
            scope.ids.map((id) => {
              const b = byId.get(id);
              if (!b) return null;
              return (
                <span key={id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
                  <BranchDot branch={b} className="h-2 w-2" />
                  {b.short_name || b.name}
                  {scope.home === id && <span className="text-muted-foreground">· base</span>}
                </span>
              );
            })
          ))}
      </div>
      {upcoming && st !== "terminated" && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarClock size={12} aria-hidden />
          {EVENT_LABEL[upcoming.kind]} desde el {formatDay(upcoming.starts_on)}
        </p>
      )}
    </article>
  );
}

type TimelineItem = {
  key: string;
  date: string;
  title: string;
  detail: string | null;
  tone: BadgeTone;
  icon: React.ElementType;
  state: "scheduled" | "current" | "past" | "cancelled";
  eventId?: string;
  liftable?: boolean;
};

function StaffDetailModal({
  person,
  onClose,
  branches,
  assignments,
  events,
  canManage,
  multi,
  actions,
}: {
  person: StaffPersonRow | null;
  onClose: () => void;
  branches: Branch[];
  assignments: StaffAssignment[];
  events: StatusEventRow[];
  canManage: boolean;
  multi: boolean;
  actions: Actions;
}) {
  const { toast } = useToast();
  const m = useStaffStatusMutations();
  const today = todayAR();
  const byId = new Map(branches.map((b) => [b.id, b]));

  const items = useMemo<TimelineItem[]>(() => {
    if (!person) return [];
    const out: TimelineItem[] = [];
    for (const e of events) {
      const sub =
        e.kind === "leave" && e.subtype
          ? LEAVE_LABEL[e.subtype as LeaveType]
          : e.kind === "termination" && e.subtype
            ? TERMINATION_LABEL[e.subtype as TerminationType]
            : null;
      const state = e.deleted_at
        ? "cancelled"
        : e.starts_on > today
          ? "scheduled"
          : e.ends_on && e.ends_on < today
            ? "past"
            : "current";
      out.push({
        key: `e:${e.id}`,
        date: e.starts_on,
        title: `${EVENT_LABEL[e.kind]}${sub ? `: ${sub}` : ""}`,
        detail: [e.kind === "rehire" ? null : periodLabel(e.starts_on, e.ends_on), e.reason].filter(Boolean).join(" · ") || null,
        tone: e.kind === "termination" ? "neutral" : e.kind === "suspension" ? "danger" : e.kind === "leave" ? "info" : "success",
        icon: e.kind === "termination" ? UserX : e.kind === "suspension" ? ShieldAlert : e.kind === "leave" ? CalendarClock : UserCheck,
        state,
        eventId: e.id,
        liftable: canManage && (e.kind === "suspension" || e.kind === "leave") && (state === "current" || state === "scheduled"),
      });
    }
    for (const a of assignments) {
      const st = assignmentStatus(a, today);
      const b = byId.get(a.store_id);
      out.push({
        key: `a:${a.id}`,
        date: a.valid_from,
        title: `${KIND_LABEL[a.kind]}: ${b?.name ?? "Sucursal"}`,
        detail: [periodLabel(a.valid_from, a.valid_until), a.reason].filter(Boolean).join(" · "),
        tone: "neutral",
        icon: ArrowRightLeft,
        state: st === "cancelled" ? "cancelled" : st === "scheduled" ? "scheduled" : st === "ended" ? "past" : "current",
      });
    }
    if (person.joined_at) {
      out.push({
        key: "joined",
        date: person.joined_at.slice(0, 10),
        title: "Alta en el equipo",
        detail: person.kind === "profile" ? "Perfil sin cuenta" : (ROLE_LABELS[person.role ?? ""] ?? null),
        tone: "success",
        icon: UserPlus,
        state: "past",
      });
    }
    return out.sort((x, y) => y.date.localeCompare(x.date));
  }, [person, events, assignments, today, byId, canManage]);

  async function lift(eventId: string) {
    try {
      const r = await m.endStatus.mutateAsync({ id: eventId, reason: null });
      toast({ variant: "success", title: r === "cancelled" ? "Cancelado" : "Levantado desde hoy" });
    } catch (e) {
      toast({ variant: "error", title: staffErrorMessage(e) });
    }
  }

  if (!person) return <Modal open={false} onOpenChange={() => undefined} />;
  const st = person.state.status;
  const avail = availableActions(st);

  return (
    <Modal
      open={Boolean(person)}
      onOpenChange={(o) => !o && onClose()}
      title={person.name}
      header={
        <div className="flex items-center gap-3">
          <Avatar name={person.name} avatar={person.avatar} size={52} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{capitalizeName(person.name)}</p>
            <p className="truncate text-sm text-muted-foreground">
              {person.kind === "profile" ? "Perfil sin cuenta" : ROLE_LABELS[person.role ?? ""]}
              {person.email ? ` · ${person.email}` : ""}
            </p>
            <div className="mt-1">
              <Badge tone={STATUS_TONE[st]}>{statusChipText(person.state)}</Badge>
            </div>
          </div>
        </div>
      }
    >
      <div className="space-y-6">
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {multi && st !== "terminated" && (
              <Button size="sm" variant="secondary" onClick={() => actions.branches(person)}>
                <ArrowRightLeft size={15} /> Trasladar
              </Button>
            )}
            {avail.includes("leave") && (
              <Button size="sm" variant="secondary" onClick={() => actions.status(person, "leave")}>
                <CalendarClock size={15} /> Licencia
              </Button>
            )}
            {avail.includes("suspend") && (
              <Button size="sm" variant="secondary" onClick={() => actions.status(person, "suspension")}>
                <ShieldAlert size={15} /> Suspender
              </Button>
            )}
            {avail.includes("rehire") && (
              <Button size="sm" className={SOLID_CTA} onClick={() => actions.rehire(person)}>
                <UserCheck size={15} /> Reingreso
              </Button>
            )}
            {avail.includes("terminate") && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => actions.status(person, "termination")}>
                <UserX size={15} /> Dar de baja
              </Button>
            )}
          </div>
        )}

        <div>
          <p className={EYEBROW}>Historial</p>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Sin movimientos todavía.</p>
          ) : (
            <ol className="relative mt-3 space-y-4 border-l border-border pl-5">
              {items.map((it) => (
                <li key={it.key} className={cn("relative", it.state === "cancelled" && "opacity-50")}>
                  <span
                    className={cn(
                      "absolute -left-[29px] top-0.5 grid h-[18px] w-[18px] place-items-center rounded-full bg-background ring-1 ring-border",
                      it.state === "current" && "bg-foreground text-background ring-foreground",
                    )}
                    aria-hidden
                  >
                    <it.icon size={10} />
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("text-sm font-semibold", it.state === "cancelled" && "line-through")}>{it.title}</span>
                    {it.state === "scheduled" && <Badge tone="info">Programado</Badge>}
                    {it.state === "current" && <Badge tone={it.tone === "neutral" ? "success" : it.tone}>Vigente</Badge>}
                    {it.state === "cancelled" && <Badge tone="neutral">Cancelado</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatDay(it.date)}
                    {it.detail ? ` · ${it.detail}` : ""}
                  </p>
                  {it.liftable && it.eventId && (
                    <button
                      type="button"
                      onClick={() => lift(it.eventId!)}
                      disabled={m.endStatus.isPending}
                      className="mt-1 text-xs font-semibold text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {it.state === "scheduled" ? "Cancelar" : "Levantar desde hoy"}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Modal>
  );
}
