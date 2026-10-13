"use client";

// Score de activación y cuentas trabadas (F15 · H71 · ADR-089). El staff ve
// qué negocios no llegaron a la primera venta (u otros motivos) y les dispara
// un recorrido o una sugerencia correctiva, con motivo y vigencia (auditado).
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { useToast } from "@/components/ui/Toast";
import { formatRelative } from "@/lib/utils/format";
import { VERTICAL_LABELS } from "@/lib/verticals/config";
import { SEGMENT_PLAN_LABELS } from "@/lib/internal/segments";
import { ROLE_LABELS } from "@/lib/onboarding/schema";
import {
  ACTIVATION_LEVEL_LABELS,
  activationScore,
  stuckAccounts,
  type ActivationLevel,
  type StuckAccount,
} from "@/lib/onboarding/activationScore";
import {
  onboardingErrorMessage,
  useActivationOverview,
  useAssignCorrective,
  useCancelAssignment,
  useInternalNudges,
  useInternalTours,
  useOpenAssignments,
  type AssignmentRow,
} from "@/modules/onboarding/internal";

const LEVEL_TONE: Record<ActivationLevel, BadgeTone> = {
  activado: "success",
  en_camino: "warning",
  trabado: "danger",
};

type Kind = "tour" | "nudge";

export function ActivationPanel() {
  const { data, isLoading, error } = useActivationOverview();
  const { data: tours } = useInternalTours();
  const { data: nudges } = useInternalNudges();
  const { data: assignments } = useOpenAssignments();
  const [noSaleDays, setNoSaleDays] = useState(3);
  const [target, setTarget] = useState<StuckAccount | null>(null);
  const [cancelFor, setCancelFor] = useState<AssignmentRow | null>(null);

  const stuck = useMemo(
    () => (data ? stuckAccounts(data.rows, data.health, { noSaleDays }) : []),
    [data, noSaleDays],
  );
  const levels = useMemo(() => {
    const out: Record<ActivationLevel, number> = { activado: 0, en_camino: 0, trabado: 0 };
    for (const r of data?.rows ?? []) out[activationScore(r, data!.health.get(r.tenant_id) ?? null).level] += 1;
    return out;
  }, [data]);
  const names = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.tenant_id, r.name])), [data]);
  const refName = (a: AssignmentRow) =>
    a.kind === "tour"
      ? tours?.find((t) => t.id === a.tour_id)?.title ?? "Recorrido"
      : nudges?.find((n) => n.id === a.nudge_id)?.title ?? "Sugerencia";

  if (isLoading) return <SpinnerBlock />;
  if (error || !data) {
    return (
      <EmptyState
        title="No se pudo cargar la activación"
        description="Si las migraciones 20261108300100 a 20261108300300 no están aplicadas, esta vista no funciona."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        {(Object.keys(levels) as ActivationLevel[]).map((l) => (
          <div key={l} className="rounded-md border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">{ACTIVATION_LEVEL_LABELS[l]}</p>
            <p className="font-display text-2xl font-bold tabular-nums text-foreground">{levels[l]}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">Cuentas trabadas ({stuck.length})</h2>
          <p className="text-xs text-muted-foreground">
            Puntaje 0 a 100: puesta en marcha, primera venta, uso de caja, usuarios y actividad de la semana.
          </p>
        </div>
        <div className="w-48">
          <Input
            label="Sin primera venta a (días)"
            type="number"
            min={1}
            max={60}
            value={noSaleDays}
            onChange={(e) => setNoSaleDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
          />
        </div>
      </div>

      {stuck.length === 0 ? (
        <EmptyState title="Ninguna cuenta trabada" description="Todos los negocios avanzan." compact />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {stuck.map((a) => (
            <li key={a.row.tenant_id} className="flex flex-wrap items-start gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/internal/tenants/${a.row.tenant_id}` as Route}
                    className="font-semibold text-foreground hover:underline"
                  >
                    {a.row.name}
                  </Link>
                  <Badge tone={LEVEL_TONE[a.level]}>
                    {a.score} · {ACTIVATION_LEVEL_LABELS[a.level]}
                  </Badge>
                  {a.row.open_assignments > 0 && <Badge tone="info">{a.row.open_assignments} correctivo abierto</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(VERTICAL_LABELS as Record<string, string>)[a.row.industry] ?? a.row.industry} ·{" "}
                  {a.row.plan_family ? SEGMENT_PLAN_LABELS[a.row.plan_family] ?? a.row.plan_family : "Sin plan"} · alta{" "}
                  {formatRelative(a.row.created_at)} · {a.row.signals.products_count} productos · recorridos{" "}
                  {a.row.tours_completed}/{a.row.tours_started}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {a.reasons.map((r) => (
                    <li key={r.key} className="rounded-md bg-muted px-2 py-0.5 text-xs text-foreground">
                      {r.label}
                    </li>
                  ))}
                </ul>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setTarget(a)}>
                Disparar correctivo
              </Button>
            </li>
          ))}
        </ul>
      )}

      {Boolean(assignments?.length) && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold text-foreground">Correctivos abiertos</h2>
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {assignments!.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">
                    {names.get(a.tenant_id) ?? a.tenant_id.slice(0, 8)} · {refName(a)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.reason} · {a.target_role ? ROLE_LABELS[a.target_role] : "Todos los roles"} · vence{" "}
                    {formatRelative(a.expires_at)}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCancelFor(a)}>
                  Cancelar
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AssignDialog account={target} onClose={() => setTarget(null)} />
      <CancelDialog assignment={cancelFor} onClose={() => setCancelFor(null)} />
    </div>
  );
}

function AssignDialog({ account, onClose }: { account: StuckAccount | null; onClose: () => void }) {
  const { data: tours } = useInternalTours();
  const { data: nudges } = useInternalNudges();
  const assign = useAssignCorrective();
  const { toast } = useToast();
  const suggested = account?.reasons[0]?.suggest ?? null;
  const [kind, setKind] = useState<Kind>("tour");
  const [refId, setRefId] = useState<string | null>(null);
  const [role, setRole] = useState<string>("");
  const [days, setDays] = useState(14);
  const [lastFor, setLastFor] = useState<string | null>(null);

  const publishedTours = (tours ?? []).filter((t) => t.status === "published");
  const publishedNudges = (nudges ?? []).filter((n) => n.status === "published");

  // Al abrir para otra cuenta: preseleccionar el correctivo sugerido.
  if (account && lastFor !== account.row.tenant_id) {
    setLastFor(account.row.tenant_id);
    const k: Kind = suggested?.kind ?? "tour";
    setKind(k);
    const list = k === "tour" ? publishedTours : publishedNudges;
    setRefId(list.find((x) => x.key === suggested?.key)?.id ?? list[0]?.id ?? null);
    setRole("");
    setDays(14);
  }

  const options = (kind === "tour" ? publishedTours : publishedNudges).map((x) => ({ value: x.id, label: x.title }));

  return (
    <ReasonDialog
      open={Boolean(account)}
      onOpenChange={(o) => {
        if (!o) {
          setLastFor(null);
          onClose();
        }
      }}
      title={`Correctivo para ${account?.row.name ?? ""}`}
      description="Le aparece al negocio en su próximo ingreso aunque no esté en la audiencia. Se consume cuando lo completan o descartan."
      confirmLabel="Disparar"
      loading={assign.isPending}
      extra={
        <div className="space-y-3">
          <Segmented<Kind>
            value={kind}
            aria-label="Tipo de correctivo"
            options={[
              { value: "tour", label: "Recorrido" },
              { value: "nudge", label: "Sugerencia" },
            ]}
            onChange={(k) => {
              setKind(k);
              const list = k === "tour" ? publishedTours : publishedNudges;
              setRefId(list[0]?.id ?? null);
            }}
          />
          <Select<string>
            label={kind === "tour" ? "Recorrido" : "Sugerencia"}
            value={refId}
            options={options}
            onChange={setRefId}
          />
          <div className="grid grid-cols-2 gap-3">
            <Select<string>
              label="Para"
              value={role}
              options={[
                { value: "", label: "Todos los roles" },
                { value: "owner", label: ROLE_LABELS.owner! },
                { value: "manager", label: ROLE_LABELS.manager! },
                { value: "cashier", label: ROLE_LABELS.cashier! },
              ]}
              onChange={setRole}
            />
            <Input
              label="Vigencia (días)"
              type="number"
              min={1}
              max={60}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            />
          </div>
        </div>
      }
      onConfirm={(reason) => {
        if (!account || !refId) return;
        assign.mutate(
          { tenantId: account.row.tenant_id, kind, refId, reason, role: role || null, days },
          {
            onSuccess: () => {
              toast({ title: "Correctivo disparado", variant: "success" });
              setLastFor(null);
              onClose();
            },
            onError: (e) => toast({ title: onboardingErrorMessage(e.message), variant: "error" }),
          },
        );
      }}
    />
  );
}

function CancelDialog({ assignment, onClose }: { assignment: AssignmentRow | null; onClose: () => void }) {
  const cancel = useCancelAssignment();
  const { toast } = useToast();
  return (
    <ReasonDialog
      open={Boolean(assignment)}
      onOpenChange={(o) => !o && onClose()}
      title="Cancelar correctivo"
      confirmLabel="Cancelar correctivo"
      danger
      loading={cancel.isPending}
      onConfirm={(reason) => {
        if (!assignment) return;
        cancel.mutate(
          { id: assignment.id, reason },
          {
            onSuccess: () => {
              toast({ title: "Correctivo cancelado", variant: "success" });
              onClose();
            },
            onError: (e) => toast({ title: onboardingErrorMessage(e.message), variant: "error" }),
          },
        );
      }}
    />
  );
}
