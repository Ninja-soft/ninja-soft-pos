"use client";

// =============================================================================
// Historia 360 de la cobranza de un negocio (F20-11 · H136 · ADR-131, spec
// §10.6): cargos, pagos, imputaciones, punitorios, condonaciones, promesas,
// pasos de la escalera, avisos, transferencias informadas, cambios de plan y
// de modalidad, notas de gestión, cobrador y conciliación, en un solo lugar.
// Notas de gestión con "gestionar"; cobrador con "asignar".
// =============================================================================

import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  BadgePercent,
  Ban,
  Bell,
  CalendarClock,
  CircleAlert,
  Download,
  FileText,
  Gavel,
  HandCoins,
  Handshake,
  History,
  Landmark,
  Layers,
  MessageSquarePlus,
  NotebookPen,
  Receipt,
  Repeat,
  Scale,
  Undo2,
  UserRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { AssignCollectorDialog } from "@/components/internal/billing/AssignCollectorDialog";
import { cn } from "@/lib/utils/cn";
import { EXCLUSION_LABELS, billingErrorMessage, formatCents, formatDay, todayAR } from "@/lib/billing/ledger";
import { addDays } from "@/lib/billing/interest";
import {
  NOTE_KIND_LABELS,
  NOTE_OUTCOME_LABELS,
  TIMELINE_GROUP_LABELS,
  describeEvent,
  filterTimeline,
  timelineXlsxSheet,
  type EventIcon,
  type EventTone,
  type NoteKind,
  type NoteOutcome,
  type Timeline360Event,
  type TimelineGroup,
} from "@/lib/billing/collection360";
import { useBillingAccess } from "@/modules/billing/ledger";
import { useCobranza360Mutations, useCollectors, useTimeline } from "@/modules/billing/cobranza360";

const ICONS: Record<EventIcon, LucideIcon> = {
  charge: Receipt,
  void: Ban,
  payment: Wallet,
  reversal: Undo2,
  bonus: BadgePercent,
  allocation: ArrowLeftRight,
  interest: Scale,
  waiver: HandCoins,
  promise: Handshake,
  dunning: Gavel,
  notice: Bell,
  transfer: Landmark,
  plan: Layers,
  mode: Repeat,
  note: NotebookPen,
  collector: UserRound,
  recon: FileText,
};

const TONE_ICON: Record<EventTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  brand: "bg-ninja-flame/15 text-ninja-flameSoft",
};

type GroupFilter = "all" | TimelineGroup;

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function NoteForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const { toast } = useToast();
  const { addNote } = useCobranza360Mutations();
  const today = todayAR();
  const [kind, setKind] = useState<NoteKind>("call");
  const [outcome, setOutcome] = useState<NoteOutcome | "none">("contacted");
  const [body, setBody] = useState("");
  const [next, setNext] = useState("");
  const len = body.trim().length;
  const nextOk = !next || (next >= today && next <= addDays(today, 180));
  const ok = len >= 3 && len <= 2000 && nextOk;

  async function submit() {
    if (!ok) return;
    try {
      await addNote.mutateAsync({ tenantId, kind, outcome: outcome === "none" ? null : outcome, body: body.trim(), nextActionAt: next || null });
      toast({ title: "Gestión registrada", variant: "success" });
      setBody("");
      setNext("");
      onDone();
    } catch (e) {
      toast({ title: "No se pudo guardar la nota", description: billingErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-3 rounded-xl bg-muted/50 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Select<NoteKind>
          label="Gestión"
          value={kind}
          onChange={setKind}
          options={(Object.keys(NOTE_KIND_LABELS) as NoteKind[]).map((k) => ({ value: k, label: NOTE_KIND_LABELS[k] }))}
        />
        <Select<NoteOutcome | "none">
          label="Resultado"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "none", label: "Sin resultado" },
            ...(Object.keys(NOTE_OUTCOME_LABELS) as NoteOutcome[]).map((k) => ({ value: k, label: NOTE_OUTCOME_LABELS[k] })),
          ]}
        />
      </div>
      <div>
        <label htmlFor={`note-body-${tenantId}`} className="mb-2 block text-sm font-medium text-muted-foreground">
          Qué pasó
        </label>
        <textarea
          id={`note-body-${tenantId}`}
          rows={3}
          maxLength={2000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Ej.: hablé con el dueño, dice que transfiere el viernes."
          className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
        />
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">{len}/2000</p>
      </div>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,220px)_auto] sm:justify-between">
        <Input
          label="Próxima acción (opcional)"
          type="date"
          min={today}
          max={addDays(today, 180)}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={nextOk ? undefined : "Desde hoy y dentro de los 180 días"}
        />
        <Button onClick={submit} disabled={!ok} loading={addNote.isPending}>
          Guardar gestión
        </Button>
      </div>
    </div>
  );
}

function EventRow({
  ev,
  canVoid,
  onVoid,
}: {
  ev: Timeline360Event;
  canVoid: boolean;
  onVoid: (noteId: string) => void;
}) {
  const x = describeEvent(ev);
  const Icon = ICONS[x.icon] ?? History;
  const noteId = ev.kind === "note" && typeof ev.data.note_id === "string" && !ev.data.voided_at ? ev.data.note_id : null;
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", TONE_ICON[x.tone])} aria-hidden>
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className={cn("text-sm font-medium", ev.kind === "note" && ev.data.voided_at ? "text-muted-foreground line-through" : "")}>{x.title}</p>
          {ev.amount_cents != null && ev.amount_cents !== 0 && (
            <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCents(ev.amount_cents)}</span>
          )}
        </div>
        {x.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{x.detail}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{formatAt(ev.at)}</span>
          <span aria-hidden>·</span>
          <span>{ev.actor ?? "Sistema"}</span>
          <Badge tone="neutral" className="ml-1">
            {TIMELINE_GROUP_LABELS[ev.group] ?? ev.group}
          </Badge>
          {noteId && canVoid && (
            <button type="button" className="ml-auto text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onVoid(noteId)}>
              Anular nota
            </button>
          )}
        </p>
      </div>
    </li>
  );
}

export function Tenant360Timeline({ tenantId, compact = false }: { tenantId: string; compact?: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useTimeline(tenantId);
  const { data: access } = useBillingAccess();
  const canAssign = Boolean(access?.can_assign);
  const { data: collectors = [] } = useCollectors(canAssign);
  const { voidNote } = useCobranza360Mutations();
  const [group, setGroup] = useState<GroupFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [limit, setLimit] = useState(compact ? 30 : 80);
  const events = useMemo(() => filterTimeline(data?.events ?? [], group), [data, group]);
  const canManage = Boolean(data?.can_manage);

  async function exportIt() {
    if (!data) return;
    const { exportXlsx, xlsxFileSlug } = await import("@/lib/utils/xlsx");
    await exportXlsx(`historia-cobranza-${xlsxFileSlug(data.name)}-${todayAR()}`, [timelineXlsxSheet(events, data.name)]);
  }

  return (
    <section aria-labelledby={`t360-${tenantId}`} className="min-w-0">
      <SectionHeader
        title={<span id={`t360-${tenantId}`}>Historia de cobranza</span>}
        icon={History}
        description="Todo lo que pasó con la plata y las gestiones de este negocio, del más nuevo al más viejo."
        actions={
          <>
            {canManage && (
              <Button size="sm" variant={showForm ? "secondary" : "primary"} onClick={() => setShowForm((v) => !v)}>
                <MessageSquarePlus size={15} aria-hidden />
                {showForm ? "Cerrar nota" : "Nueva gestión"}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={exportIt} disabled={!data || events.length === 0}>
              <Download size={15} aria-hidden />
              Exportar XLSX
            </Button>
          </>
        }
      />

      {data && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Cobrador:</span>
          <span className="font-medium">{data.collector?.name ?? "Sin asignar"}</span>
          {canAssign && (
            <button type="button" className="text-sm font-medium text-ninja-flameSoft underline-offset-2 hover:underline" onClick={() => setAssigning(true)}>
              Cambiar
            </button>
          )}
          {data.exclusion && <Badge tone="neutral">{EXCLUSION_LABELS[data.exclusion] ?? "No se cobra"}</Badge>}
          {data.scheduled_change && (
            <Badge tone="info">
              <CalendarClock size={12} className="mr-1 inline" aria-hidden />
              Cambio programado para el {formatDay(data.scheduled_change.effective_on)}
            </Badge>
          )}
        </div>
      )}

      {showForm && canManage && (
        <div className="mt-3">
          <NoteForm tenantId={tenantId} onDone={() => setShowForm(false)} />
        </div>
      )}

      <div className="mt-3">
        <Segmented<GroupFilter>
          aria-label="Filtrar la historia"
          value={group}
          onChange={setGroup}
          scrollOnMobile
          size="sm"
          options={[
            { value: "all", label: "Todo" },
            { value: "plata", label: TIMELINE_GROUP_LABELS.plata },
            { value: "gestion", label: TIMELINE_GROUP_LABELS.gestion },
            { value: "mora", label: TIMELINE_GROUP_LABELS.mora },
            { value: "avisos", label: TIMELINE_GROUP_LABELS.avisos },
            { value: "plan", label: TIMELINE_GROUP_LABELS.plan },
          ]}
        />
      </div>

      <div className="mt-3">
        {error ? (
          <Callout tone="warning" icon={CircleAlert} title="No se pudo cargar la historia">
            {billingErrorMessage(error)}
          </Callout>
        ) : isLoading || !data ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : events.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState compact icon={History} title="Sin movimientos" description="Cuando haya cargos, pagos o gestiones, aparecen acá." />
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {events.slice(0, limit).map((ev) => (
                <EventRow key={ev.id} ev={ev} canVoid={canManage} onVoid={setVoiding} />
              ))}
            </ul>
            {events.length > limit && (
              <div className="mt-3 flex justify-center">
                <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + 80)}>
                  Ver más ({events.length - limit})
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ReasonDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Anular nota"
        description="La nota queda en la historia tachada, con el motivo."
        confirmLabel="Anular"
        danger
        loading={voidNote.isPending}
        onConfirm={async (reason) => {
          if (!voiding) return;
          try {
            await voidNote.mutateAsync({ noteId: voiding, reason });
            toast({ title: "Nota anulada", variant: "success" });
            setVoiding(null);
          } catch (e) {
            toast({ title: "No se pudo anular", description: billingErrorMessage(e), variant: "error" });
          }
        }}
      />

      {canAssign && (
        <AssignCollectorDialog
          open={assigning}
          onOpenChange={setAssigning}
          tenantIds={[tenantId]}
          collectors={collectors}
          currentId={data?.collector?.id ?? null}
        />
      )}
    </section>
  );
}
Tenant360Timeline.displayName = "Tenant360Timeline";
