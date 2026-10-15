"use client";

// =============================================================================
// Cobranzas › Mora y punitorios › Configuración (F20-9 · ADR-128, spec docs/40
// §10.3, §10.5, §11 y §22 #4, #5, #6 y #10).
//   · Interruptores: punitorios (arrancan apagados), con débito automático,
//     escalera, promesas del cliente y qué se limita con la restricción blanda.
//   · Políticas de punitorios (tasa, gracia, diario o por mes empezado, tope,
//     mínimo y ND) con vista previa del simulador, y la política de cada plan.
//   · Escalera de mora con su línea de tiempo y editor de pasos.
//   · Feriados (no se vence ni avanza en día no hábil).
// Sólo super_admin edita (el servidor lo valida); el resto mira.
// =============================================================================

import { useMemo, useState } from "react";
import {
  Ban,
  BellRing,
  CalendarOff,
  CircleAlert,
  FileX2,
  Hand,
  Lock,
  Pencil,
  Percent,
  Plus,
  Settings2,
  Trash2,
  Archive,
  Route as RouteIcon,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { ReasonField } from "@/components/internal/billing/LedgerModals";
import { InterestSimulator, SimulationResult, toPolicy } from "@/components/internal/billing/InterestSimulator";
import { formatCents, formatDay, parsePesosToCents } from "@/lib/billing/ledger";
import {
  INTEREST_BILL_MODE_LABELS,
  INTEREST_METHOD_LABELS,
  formatBp,
  parsePercentToBp,
  type InterestBillMode,
  type InterestMethod,
} from "@/lib/billing/interest";
import {
  DUNNING_ACTION_HELP,
  DUNNING_ACTION_LABELS,
  DUNNING_CHANNEL_LABELS,
  RESTRICT_AREAS,
  RESTRICT_AREA_KEYS,
  renderStepText,
  type DunningAction,
  type DunningChannel,
} from "@/lib/billing/mora";
import {
  moraErrorMessage,
  useMoraConfig,
  useMoraConfigMutations,
  type DunningLadderRow,
  type DunningStepRow,
  type InterestPolicyRow,
  type MoraConfig,
  type MoraSettings,
} from "@/modules/billing/mora";

export const ACTION_ICONS: Record<DunningAction, typeof BellRing> = {
  notify: BellRing,
  past_due: CircleAlert,
  soft_restrict: Lock,
  suspend: Ban,
  mark_uncollectible: FileX2,
};

const reasonOk = (r: string) => r.trim().length >= 5 && r.trim().length <= 500;

// ── Interruptores ───────────────────────────────────────────────────────────

function SettingsCard({ cfg }: { cfg: MoraConfig }) {
  const s = cfg.settings;
  const [open, setOpen] = useState(false);
  const policy = cfg.policies.find((p) => p.id === s.default_interest_policy_id);
  const ladder = cfg.ladders.find((l) => l.id === s.default_dunning_ladder_id);
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Punitorios",
      value: s.interest_enabled ? (
        <Badge tone="success">Prendidos{s.interest_since ? ` desde el ${formatDay(s.interest_since)}` : ""}</Badge>
      ) : (
        <Badge tone="neutral">Apagados</Badge>
      ),
    },
    { label: "Con débito automático", value: s.interest_on_mp ? "Sí, también devengan" : "No, sólo cuenta corriente y manual" },
    { label: "Política por defecto", value: policy ? `${policy.name} · ${formatBp(policy.monthly_rate_bp)} mensual` : "Sin política" },
    { label: "Escalera de mora", value: s.dunning_enabled ? ladder?.name ?? "Sin escalera" : <Badge tone="warning">Apagada</Badge> },
    {
      label: "Promesas del cliente",
      value: s.promise_self_enabled
        ? `Hasta ${s.promise_max_days} días · el staff hasta ${s.promise_staff_max_days} · se bloquean con ${s.promise_max_broken} incumplidas en 90 días`
        : `Sólo el staff (hasta ${s.promise_staff_max_days} días)`,
    },
    {
      label: "Restricción parcial limita",
      value: s.soft_restrict_areas.length
        ? s.soft_restrict_areas.map((a) => RESTRICT_AREAS[a as keyof typeof RESTRICT_AREAS]?.label ?? a).join(", ")
        : "Nada (sólo el aviso)",
    },
  ];
  return (
    <section>
      <SectionHeader
        title="Interruptores"
        icon={Settings2}
        description="Los punitorios arrancan apagados. La escalera reemplaza a la suspensión fija a los 3 días."
        actions={
          cfg.can_configure ? (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <Pencil size={15} aria-hidden /> Editar
            </Button>
          ) : undefined
        }
      />
      <dl className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="font-medium sm:text-right">{r.value}</dd>
          </div>
        ))}
      </dl>
      <SettingsModal open={open} onOpenChange={setOpen} cfg={cfg} />
    </section>
  );
}

function SettingsModal({ open, onOpenChange, cfg }: { open: boolean; onOpenChange: (o: boolean) => void; cfg: MoraConfig }) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const [d, setD] = useState<MoraSettings>(cfg.settings);
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setD(cfg.settings);
    setReason("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const set = <K extends keyof MoraSettings>(k: K, v: MoraSettings[K]) => setD((x) => ({ ...x, [k]: v }));
  const num = (v: string) => Number(v.replace(/[^\d]/g, "") || 0);
  const valid =
    d.promise_max_days >= 1 && d.promise_max_days <= 60 && d.promise_staff_max_days >= 1 && d.promise_staff_max_days <= 90 &&
    d.promise_max_broken >= 1 && d.promise_max_broken <= 10;
  const policies = cfg.policies.filter((p) => !p.archived_at && p.is_active !== false);
  const ladders = cfg.ladders.filter((l) => !l.archived_at && l.is_active);

  async function save() {
    try {
      await m.setSettings.mutateAsync({
        data: {
          interest_enabled: d.interest_enabled,
          interest_on_mp: d.interest_on_mp,
          default_interest_policy_id: d.default_interest_policy_id,
          dunning_enabled: d.dunning_enabled,
          default_dunning_ladder_id: d.default_dunning_ladder_id,
          promise_self_enabled: d.promise_self_enabled,
          promise_max_days: d.promise_max_days,
          promise_staff_max_days: d.promise_staff_max_days,
          promise_max_broken: d.promise_max_broken,
          soft_restrict_areas: d.soft_restrict_areas,
        },
        reason: reason.trim(),
      });
      toast({ title: "Configuración de mora guardada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: moraErrorMessage(e), variant: "error" });
    }
  }

  const toggle = (k: "interest_enabled" | "interest_on_mp" | "dunning_enabled" | "promise_self_enabled", label: string, help: string) => (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/50 px-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>
      </div>
      <Switch checked={d[k]} onCheckedChange={(v) => set(k, v)} label={label} />
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Mora y punitorios"
      description="Rige para lo que se devengue y ejecute desde ahora. Apagar los punitorios corta hacia adelante."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid || !reasonOk(reason)} loading={m.setSettings.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {toggle("interest_enabled", "Punitorios", "Al prenderlos se devenga desde hoy: no aparecen punitorios de días anteriores.")}
        {toggle("interest_on_mp", "También con débito automático", "Si está apagado, sólo devengan los negocios en cuenta corriente o manual.")}
        <Select
          label="Política por defecto"
          value={d.default_interest_policy_id}
          onChange={(v) => set("default_interest_policy_id", v)}
          options={policies.map((p) => ({ value: p.id, label: `${p.name} · ${formatBp(p.monthly_rate_bp)} mensual` }))}
          hint="La usan los negocios y planes sin política propia."
        />
        {toggle("dunning_enabled", "Escalera de mora", "Avisos, pago pendiente, restricción parcial y suspensión según los días de atraso.")}
        <Select
          label="Escalera por defecto"
          value={d.default_dunning_ladder_id}
          onChange={(v) => set("default_dunning_ladder_id", v)}
          options={ladders.map((l) => ({ value: l.id, label: l.name }))}
        />
        {toggle("promise_self_enabled", "El cliente puede cargar su promesa", "Voy a pagar el día… desde Mi suscripción, una por deuda.")}
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label="Días máx. (cliente)" inputMode="numeric" value={String(d.promise_max_days)} onChange={(e) => set("promise_max_days", num(e.target.value))} error={d.promise_max_days >= 1 && d.promise_max_days <= 60 ? undefined : "1 a 60"} />
          <Input label="Días máx. (staff)" inputMode="numeric" value={String(d.promise_staff_max_days)} onChange={(e) => set("promise_staff_max_days", num(e.target.value))} error={d.promise_staff_max_days >= 1 && d.promise_staff_max_days <= 90 ? undefined : "1 a 90"} />
          <Input label="Incumplidas que bloquean" inputMode="numeric" value={String(d.promise_max_broken)} onChange={(e) => set("promise_max_broken", num(e.target.value))} error={d.promise_max_broken >= 1 && d.promise_max_broken <= 10 ? undefined : "1 a 10"} hint="En 90 días" />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">La restricción parcial limita</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {RESTRICT_AREA_KEYS.map((a) => {
              const on = d.soft_restrict_areas.includes(a);
              return (
                <label key={a} className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium">{RESTRICT_AREAS[a].label}</span>
                    <span className="block text-xs text-muted-foreground">{RESTRICT_AREAS[a].help}</span>
                  </span>
                  <Switch
                    checked={on}
                    label={RESTRICT_AREAS[a].label}
                    onCheckedChange={(v) =>
                      set("soft_restrict_areas", v ? [...d.soft_restrict_areas, a] : d.soft_restrict_areas.filter((x) => x !== a))
                    }
                  />
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Vender, cobrar, la caja y el panel del dueño nunca se limitan.</p>
        </div>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: arrancamos con punitorios del 5 % mensual" />
      </div>
    </Modal>
  );
}

// ── Políticas ───────────────────────────────────────────────────────────────

const EMPTY_POLICY: InterestPolicyRow = {
  id: "",
  name: "",
  monthly_rate_bp: 300,
  grace_days: 0,
  method: "daily_prorata",
  cap_bp: null,
  min_amount_cents: 0,
  bill_mode: "on_collection",
};

function PolicyModal({
  open,
  onOpenChange,
  initial,
  holidays,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: InterestPolicyRow | null;
  holidays: string[];
}) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const base = initial ?? EMPTY_POLICY;
  const [name, setName] = useState(base.name);
  const [rate, setRate] = useState(String(base.monthly_rate_bp / 100).replace(".", ","));
  const [grace, setGrace] = useState(String(base.grace_days));
  const [method, setMethod] = useState<InterestMethod>(base.method);
  const [cap, setCap] = useState(base.cap_bp === null ? "" : String(base.cap_bp / 100).replace(".", ","));
  const [min, setMin] = useState(base.min_amount_cents ? String(base.min_amount_cents / 100).replace(".", ",") : "");
  const [bill, setBill] = useState<InterestBillMode>(base.bill_mode);
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setName(base.name);
    setRate(String(base.monthly_rate_bp / 100).replace(".", ","));
    setGrace(String(base.grace_days));
    setMethod(base.method);
    setCap(base.cap_bp === null ? "" : String(base.cap_bp / 100).replace(".", ","));
    setMin(base.min_amount_cents ? String(base.min_amount_cents / 100).replace(".", ",") : "");
    setBill(base.bill_mode);
    setReason("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const rateBp = parsePercentToBp(rate);
  const capBp = cap.trim() === "" ? null : parsePercentToBp(cap);
  const minCents = min.trim() === "" ? 0 : parsePesosToCents(min);
  const graceN = Number(grace);
  const nameOk = name.trim().length >= 2 && name.trim().length <= 80;
  const valid =
    nameOk && rateBp !== null && rateBp <= 10000 && Number.isInteger(graceN) && graceN >= 0 && graceN <= 90 &&
    (cap.trim() === "" || (capBp !== null && capBp <= 100000)) && minCents !== null;
  const preview = valid
    ? toPolicy({ monthly_rate_bp: rateBp!, grace_days: graceN, method, cap_bp: capBp, min_amount_cents: minCents ?? 0 })
    : null;

  async function save() {
    if (!valid) return;
    try {
      await m.savePolicy.mutateAsync({
        id: initial?.id ?? null,
        data: { name: name.trim(), monthly_rate_bp: rateBp!, grace_days: graceN, method, cap_bp: capBp, min_amount_cents: minCents ?? 0, bill_mode: bill },
        reason: reason.trim(),
      });
      toast({ title: initial ? "Política guardada" : "Política creada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: moraErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={initial ? "Editar política de punitorios" : "Nueva política de punitorios"}
      description="Un cambio rige para las deudas que empiecen a devengar desde ahora: las que ya devengan conservan su política."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid || !reasonOk(reason)} loading={m.savePolicy.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Estándar 3 %" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Tasa mensual (%)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} error={rateBp === null || rateBp > 10000 ? "De 0 a 100 %" : undefined} />
          <Input label="Días de gracia" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/[^\d]/g, ""))} error={Number.isInteger(graceN) && graceN <= 90 ? undefined : "0 a 90"} hint="Desde el vencimiento" />
          <Input label="Tope total (% del capital)" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Sin tope" error={cap.trim() !== "" && (capBp === null || capBp > 100000) ? "Porcentaje inválido" : undefined} />
          <Input label="Mínimo por mes ($)" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" hint="Debajo, el mes pasa al siguiente" error={minCents === null ? "Importe inválido" : undefined} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Cálculo</p>
          <Segmented<InterestMethod>
            value={method}
            onChange={setMethod}
            fill
            scrollOnMobile
            aria-label="Cálculo"
            options={[
              { value: "daily_prorata", label: "Diario" },
              { value: "per_month_started", label: "Por mes empezado" },
            ]}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">{INTEREST_METHOD_LABELS[method]}. Interés simple, nunca sobre punitorios.</p>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Nota de débito</p>
          <Segmented<InterestBillMode>
            value={bill}
            onChange={setBill}
            fill
            scrollOnMobile
            aria-label="Nota de débito"
            options={[
              { value: "on_collection", label: "Al cobrarlo" },
              { value: "monthly", label: "Al cierre del mes" },
            ]}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {INTEREST_BILL_MODE_LABELS[bill]}. Queda pendiente hasta que exista la factura con CAE (H130).
          </p>
        </div>
        {preview && <SimulationResult policy={preview} capitalCents={5000000} days={45} holidays={holidays} />}
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: tasa acordada con el contador" />
      </div>
    </Modal>
  );
}

function PoliciesCard({ cfg }: { cfg: MoraConfig }) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const [editing, setEditing] = useState<InterestPolicyRow | "new" | null>(null);
  const [archiving, setArchiving] = useState<InterestPolicyRow | null>(null);
  const [planChange, setPlanChange] = useState<{ planId: string; planName: string; policyId: string | null } | null>(null);
  const holidays = cfg.holidays.map((h) => h.day);
  const visible = cfg.policies.filter((p) => !p.archived_at);
  const policyOptions = [
    { value: "__default", label: "La de por defecto" },
    ...visible.map((p) => ({ value: p.id, label: `${p.name} · ${formatBp(p.monthly_rate_bp)}` })),
  ];

  return (
    <section className="space-y-6">
      <div>
        <SectionHeader
          title="Políticas de punitorios"
          icon={Percent}
          description="Asignables por plan o por negocio (en su ficha). Sin asignar, rige la de por defecto."
          actions={
            cfg.can_configure ? (
              <Button size="sm" onClick={() => setEditing("new")}>
                <Plus size={15} aria-hidden /> Nueva política
              </Button>
            ) : undefined
          }
        />
        {visible.length === 0 ? (
          <div className="mt-3 rounded-xl border border-border bg-card">
            <EmptyState compact icon={Percent} title="Sin políticas" description="Creá una para poder prender los punitorios." />
          </div>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {visible.map((p) => (
              <li key={p.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {p.name}
                      {cfg.settings.default_interest_policy_id === p.id && <Badge tone="brand">Por defecto</Badge>}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatBp(p.monthly_rate_bp)} mensual · {p.grace_days} días de gracia ·{" "}
                      {p.method === "daily_prorata" ? "diario" : "por mes empezado"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Tope {formatBp(p.cap_bp)} · mínimo {formatCents(p.min_amount_cents)} · ND{" "}
                      {p.bill_mode === "on_collection" ? "al cobrarlo" : "mensual"}
                      {p.tenants ? ` · ${p.tenants} negocio${p.tenants === 1 ? "" : "s"} con esta política` : ""}
                    </p>
                  </div>
                  {cfg.can_configure && (
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="sm" className="h-9 w-9 px-0" aria-label={`Editar ${p.name}`} onClick={() => setEditing(p)}>
                        <Pencil size={15} aria-hidden />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-9 w-9 px-0" aria-label={`Archivar ${p.name}`} onClick={() => setArchiving(p)}>
                        <Archive size={15} aria-hidden />
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <SectionHeader title="Política por plan" icon={RouteIcon} description="Gana a la de por defecto; la del negocio gana a la del plan." />
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {cfg.plans.map((pl) => (
            <li key={pl.plan_id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm font-medium">{pl.name}</span>
              <div className="sm:w-72">
                <Select
                  aria-label={`Política del plan ${pl.name}`}
                  value={pl.policy_id ?? "__default"}
                  disabled={!cfg.can_configure}
                  onChange={(v) => setPlanChange({ planId: pl.plan_id, planName: pl.name, policyId: v === "__default" ? null : v })}
                  options={policyOptions}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <InterestSimulator policies={cfg.policies} holidays={holidays} />

      <PolicyModal
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={editing && editing !== "new" ? editing : null}
        holidays={holidays}
      />
      <ReasonDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archivar política"
        description={archiving ? `${archiving.name}: los negocios y planes que la usaban pasan a la siguiente que corresponda. Lo ya devengado no cambia.` : undefined}
        confirmLabel="Archivar"
        danger
        loading={m.archivePolicy.isPending}
        onConfirm={async (reason) => {
          if (!archiving) return;
          try {
            await m.archivePolicy.mutateAsync({ id: archiving.id, reason });
            toast({ title: "Política archivada", variant: "success" });
            setArchiving(null);
          } catch (e) {
            toast({ title: "No se pudo archivar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
      <ReasonDialog
        open={planChange !== null}
        onOpenChange={(o) => !o && setPlanChange(null)}
        title="Política del plan"
        description={planChange ? `Plan ${planChange.planName}. Rige para las deudas que empiecen a devengar desde ahora.` : undefined}
        confirmLabel="Guardar"
        loading={m.assignPlan.isPending}
        onConfirm={async (reason) => {
          if (!planChange) return;
          try {
            await m.assignPlan.mutateAsync({ planId: planChange.planId, policyId: planChange.policyId, reason });
            toast({ title: "Política del plan guardada", variant: "success" });
            setPlanChange(null);
          } catch (e) {
            toast({ title: "No se pudo guardar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}

// ── Escalera ────────────────────────────────────────────────────────────────

/** Línea de tiempo de la escalera: vertical en mobile, horizontal desde sm. */
export function LadderTimeline({ steps, executed }: { steps: DunningStepRow[]; executed?: ReadonlySet<string> }) {
  const sorted = [...steps].filter((s) => s.is_active).sort((a, b) => a.offset_days - b.offset_days || a.position - b.position);
  if (sorted.length === 0) return <p className="text-sm text-muted-foreground">La escalera no tiene pasos activos.</p>;
  return (
    <ol className="relative grid gap-3 sm:grid-flow-col sm:auto-cols-fr sm:gap-2">
      {sorted.map((s) => {
        const Icon = ACTION_ICONS[s.action];
        const done = executed?.has(s.id);
        return (
          <li key={s.id} className="flex gap-3 sm:flex-col sm:gap-2">
            <div className="flex flex-col items-center sm:flex-row">
              <span
                className={
                  done
                    ? "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--pos-solid)] text-white"
                    : "grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-foreground"
                }
                aria-hidden
              >
                <Icon size={16} />
              </span>
              <span className="mt-1 w-px flex-1 bg-border sm:ml-1 sm:mt-0 sm:h-px sm:w-auto" aria-hidden />
            </div>
            <div className="min-w-0 pb-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {s.offset_days === 0 ? "Día del vencimiento" : `Día ${s.offset_days}`}
              </p>
              <p className="text-sm font-medium">{DUNNING_ACTION_LABELS[s.action]}</p>
              <p className="truncate text-xs text-muted-foreground" title={s.title}>
                {s.title}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.requires_no_promise && (
                  <Badge tone="info" title="Una promesa vigente frena este paso">
                    <Hand size={12} aria-hidden /> Frena con promesa
                  </Badge>
                )}
                {done && <Badge tone="success">Hecho</Badge>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

type DraftStep = Omit<DunningStepRow, "id" | "position"> & { id: string | null; key: string };

let keySeq = 0;
const newKey = () => `n${++keySeq}`;

function LadderModal({
  open,
  onOpenChange,
  ladder,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ladder: DunningLadderRow | null;
}) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const toDraft = (l: DunningLadderRow | null): DraftStep[] =>
    (l?.steps ?? []).map((s) => ({ ...s, id: s.id, key: s.id }));
  const [name, setName] = useState(ladder?.name ?? "");
  const [steps, setSteps] = useState<DraftStep[]>(toDraft(ladder));
  const [reason, setReason] = useState("");
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setName(ladder?.name ?? "Nueva escalera");
    setSteps(toDraft(ladder));
    setReason("");
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const upd = (key: string, patch: Partial<DraftStep>) => setSteps((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const stepOk = (s: DraftStep) =>
    Number.isInteger(s.offset_days) && s.offset_days >= 0 && s.offset_days <= 365 && s.title.trim().length >= 2 &&
    s.title.trim().length <= 120 && s.body.trim().length >= 2 && s.body.trim().length <= 1000;
  const valid = name.trim().length >= 2 && steps.length > 0 && steps.length <= 20 && steps.every(stepOk);

  async function save() {
    if (!valid) return;
    const ordered = [...steps].sort((a, b) => a.offset_days - b.offset_days);
    try {
      await m.saveLadder.mutateAsync({
        id: ladder?.id ?? null,
        data: {
          name: name.trim(),
          steps: ordered.map((s) => ({
            id: s.id ?? undefined,
            offset_days: s.offset_days,
            action: s.action,
            channels: s.action === "mark_uncollectible" ? [] : s.channels,
            requires_no_promise: s.requires_no_promise,
            min_debt_cents: s.min_debt_cents,
            title: s.title.trim(),
            body: s.body.trim(),
            is_active: s.is_active,
          })),
        },
        reason: reason.trim(),
      });
      toast({ title: "Escalera guardada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: moraErrorMessage(e), variant: "error" });
    }
  }

  const sample = { monto: "$ 54.000,00", dias: 7, vence: "01/10/2026", negocio: "Kiosco Sol" };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={ladder ? "Editar escalera" : "Nueva escalera"}
      description="Días desde el vencimiento efectivo (si cae en feriado o fin de semana, el próximo día hábil). Sólo el último paso de un mismo día avisa al cliente."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!valid || !reasonOk(reason)} loading={m.saveLadder.isPending}>
            Guardar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Nombre" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <ol className="space-y-3">
          {steps.map((s, i) => (
            <li key={s.key} className="space-y-3 rounded-xl bg-muted/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">Paso {i + 1}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Activo</span>
                  <Switch checked={s.is_active} onCheckedChange={(v) => upd(s.key, { is_active: v })} label={`Paso ${i + 1} activo`} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 px-0"
                    aria-label={`Quitar paso ${i + 1}`}
                    onClick={() => setSteps((xs) => xs.filter((x) => x.key !== s.key))}
                  >
                    <Trash2 size={15} aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                <Input
                  label="Día"
                  inputMode="numeric"
                  value={String(s.offset_days)}
                  onChange={(e) => upd(s.key, { offset_days: Number(e.target.value.replace(/[^\d]/g, "") || 0) })}
                  error={s.offset_days <= 365 ? undefined : "0 a 365"}
                />
                <Select<DunningAction>
                  label="Acción"
                  value={s.action}
                  onChange={(v) => upd(s.key, { action: v })}
                  options={(Object.keys(DUNNING_ACTION_LABELS) as DunningAction[]).map((a) => ({
                    value: a,
                    label: DUNNING_ACTION_LABELS[a],
                    description: DUNNING_ACTION_HELP[a],
                  }))}
                />
              </div>
              <Input label="Título del aviso" value={s.title} maxLength={120} onChange={(e) => upd(s.key, { title: e.target.value })} />
              <div>
                <label htmlFor={`step-body-${s.key}`} className="mb-2 block text-sm font-medium text-muted-foreground">
                  Texto del aviso
                </label>
                <textarea
                  id={`step-body-${s.key}`}
                  rows={2}
                  maxLength={1000}
                  value={s.body}
                  onChange={(e) => upd(s.key, { body: e.target.value })}
                  className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ninja-flameSoft"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Podés usar {"{monto}"}, {"{dias}"}, {"{vence}"} y {"{negocio}"}. Vista previa: {renderStepText(s.body, sample)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                {s.action !== "mark_uncollectible" &&
                  (["email", "in_app"] as DunningChannel[]).map((c) => (
                    <label key={c} className="flex items-center gap-2">
                      <Switch
                        checked={s.channels.includes(c)}
                        label={DUNNING_CHANNEL_LABELS[c]}
                        onCheckedChange={(v) => upd(s.key, { channels: v ? [...s.channels, c] : s.channels.filter((x) => x !== c) })}
                      />
                      {DUNNING_CHANNEL_LABELS[c]}
                    </label>
                  ))}
                <label className="flex items-center gap-2">
                  <Switch checked={s.requires_no_promise} label="Frena con promesa" onCheckedChange={(v) => upd(s.key, { requires_no_promise: v })} />
                  Frena con promesa
                </label>
              </div>
            </li>
          ))}
        </ol>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setSteps((xs) => [
              ...xs,
              {
                id: null,
                key: newKey(),
                offset_days: (xs.at(-1)?.offset_days ?? 0) + 1,
                action: "notify",
                channels: ["email", "in_app"],
                requires_no_promise: false,
                min_debt_cents: 0,
                title: "Recordatorio de pago",
                body: "Tenés {monto} vencidos hace {dias} días. Pagá desde tu panel.",
                is_active: true,
              },
            ])
          }
          disabled={steps.length >= 20}
        >
          <Plus size={15} aria-hidden /> Agregar paso
        </Button>
        <ReasonField value={reason} onChange={setReason} placeholder="Ej.: suspendemos a los 12 días en vez de 10" />
      </div>
    </Modal>
  );
}

function LaddersCard({ cfg }: { cfg: MoraConfig }) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const [editing, setEditing] = useState<DunningLadderRow | "new" | null>(null);
  const [archiving, setArchiving] = useState<DunningLadderRow | null>(null);
  const visible = cfg.ladders.filter((l) => !l.archived_at);
  return (
    <section>
      <SectionHeader
        title="Escalera de mora"
        icon={RouteIcon}
        description="Reemplaza a la suspensión fija a los 3 días. No avanza en fines de semana ni feriados."
        actions={
          cfg.can_configure ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              <Plus size={15} aria-hidden /> Nueva escalera
            </Button>
          ) : undefined
        }
      />
      <div className="mt-3 space-y-3">
        {visible.map((l) => (
          <div key={l.id} className="rounded-xl border border-border bg-card p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {l.name}
                {cfg.settings.default_dunning_ladder_id === l.id && <Badge tone="brand">Por defecto</Badge>}
                {l.tenants > 0 && <Badge tone="neutral">{l.tenants} negocio{l.tenants === 1 ? "" : "s"}</Badge>}
              </p>
              {cfg.can_configure && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(l)}>
                    <Pencil size={15} aria-hidden /> Editar
                  </Button>
                  {cfg.settings.default_dunning_ladder_id !== l.id && (
                    <Button variant="ghost" size="sm" className="h-9 w-9 px-0" aria-label={`Archivar ${l.name}`} onClick={() => setArchiving(l)}>
                      <Archive size={15} aria-hidden />
                    </Button>
                  )}
                </div>
              )}
            </div>
            <LadderTimeline steps={l.steps} />
          </div>
        ))}
      </div>
      <LadderModal open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} ladder={editing && editing !== "new" ? editing : null} />
      <ReasonDialog
        open={archiving !== null}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archivar escalera"
        description={archiving ? `${archiving.name}: los negocios que la usaban pasan a la de por defecto.` : undefined}
        confirmLabel="Archivar"
        danger
        loading={m.archiveLadder.isPending}
        onConfirm={async (reason) => {
          if (!archiving) return;
          try {
            await m.archiveLadder.mutateAsync({ id: archiving.id, reason });
            toast({ title: "Escalera archivada", variant: "success" });
            setArchiving(null);
          } catch (e) {
            toast({ title: "No se pudo archivar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}

// ── Feriados ────────────────────────────────────────────────────────────────

function HolidaysCard({ cfg }: { cfg: MoraConfig }) {
  const { toast } = useToast();
  const m = useMoraConfigMutations();
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<{ day: string; name: string } | null>(null);
  const years = useMemo(() => {
    const by = new Map<string, MoraConfig["holidays"]>();
    for (const h of cfg.holidays) {
      const y = h.day.slice(0, 4);
      by.set(y, [...(by.get(y) ?? []), h]);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [cfg.holidays]);
  const currentYear = cfg.as_of.slice(0, 4);
  const [year, setYear] = useState(currentYear);
  const list = years.find(([y]) => y === year)?.[1] ?? [];
  return (
    <section>
      <SectionHeader
        title="Feriados"
        icon={CalendarOff}
        description="Un vencimiento en feriado o fin de semana pasa al próximo día hábil, y la escalera no avanza esos días."
        actions={
          cfg.can_configure ? (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <Plus size={15} aria-hidden /> Agregar feriado
            </Button>
          ) : undefined
        }
      />
      <div className="mt-3 space-y-3">
        {years.length > 1 && (
          <Segmented<string>
            value={year}
            onChange={setYear}
            scrollOnMobile
            aria-label="Año"
            options={years.map(([y]) => ({ value: y, label: y }))}
          />
        )}
        {list.length === 0 ? (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState compact icon={CalendarOff} title="Sin feriados cargados para este año" />
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {list.map((h) => (
              <li key={h.day} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="mr-3 tabular-nums text-muted-foreground">{formatDay(h.day)}</span>
                  <span className="font-medium">{h.name}</span>
                </span>
                {cfg.can_configure && (
                  <Button variant="ghost" size="sm" className="h-9 w-9 shrink-0 px-0" aria-label={`Quitar ${h.name}`} onClick={() => setDeleting(h)}>
                    <Trash2 size={15} aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <ReasonDialog
        open={adding}
        onOpenChange={(o) => {
          setAdding(o);
          if (o) {
            setDay("");
            setName("");
          }
        }}
        title="Agregar feriado"
        confirmLabel="Agregar"
        loading={m.saveHoliday.isPending}
        extra={
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Fecha" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            <Input label="Nombre" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Feriado puente" />
          </div>
        }
        onConfirm={async (reason) => {
          if (!day || name.trim().length < 2) {
            toast({ title: "Completá la fecha y el nombre", variant: "warning" });
            return;
          }
          try {
            await m.saveHoliday.mutateAsync({ day, name: name.trim(), reason });
            toast({ title: "Feriado agregado", variant: "success" });
            setAdding(false);
          } catch (e) {
            toast({ title: "No se pudo agregar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
      <ReasonDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Quitar feriado"
        description={deleting ? `${formatDay(deleting.day)} · ${deleting.name}` : undefined}
        confirmLabel="Quitar"
        danger
        loading={m.deleteHoliday.isPending}
        onConfirm={async (reason) => {
          if (!deleting) return;
          try {
            await m.deleteHoliday.mutateAsync({ day: deleting.day, reason });
            toast({ title: "Feriado quitado", variant: "success" });
            setDeleting(null);
          } catch (e) {
            toast({ title: "No se pudo quitar", description: moraErrorMessage(e), variant: "error" });
          }
        }}
      />
    </section>
  );
}

// ── Vista ───────────────────────────────────────────────────────────────────

export function MoraConfigView() {
  const { data: cfg, isLoading, error } = useMoraConfig();
  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (error || !cfg) {
    return (
      <Callout tone="warning" icon={Settings2} title="No se pudo cargar la configuración de mora">
        {moraErrorMessage(error)}
      </Callout>
    );
  }
  return (
    <div className="space-y-10">
      {!cfg.can_configure && (
        <p className="text-sm text-muted-foreground">Sólo un super admin cambia esta configuración. Vos la ves en modo lectura.</p>
      )}
      <SettingsCard cfg={cfg} />
      <PoliciesCard cfg={cfg} />
      <LaddersCard cfg={cfg} />
      <HolidaysCard cfg={cfg} />
    </div>
  );
}
MoraConfigView.displayName = "MoraConfigView";
