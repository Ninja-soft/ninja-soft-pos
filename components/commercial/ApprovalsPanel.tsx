"use client";

// Bandeja de aprobaciones comerciales (F14 · H63, ADR-092). El dueño aprueba o
// rechaza lo que propuso un encargado; el encargado ve sus solicitudes y
// puede cancelarlas. La política la edita sólo el dueño.

import { useEffect, useState } from "react";
import { Check, ShieldCheck, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { useToast } from "@/components/ui/Toast";
import { fmtDateTime, selectCls } from "@/components/stock/transfers/shared";
import { cn } from "@/lib/utils/cn";
import {
  ENTITY_LABEL,
  REQUEST_STATUS_LABEL,
  effectiveStatus,
  fieldLabel,
  formatValue,
  governanceErrorMessage,
  type Governance,
  type PromoMode,
  type RequestStatus,
  type SurchargeMode,
} from "@/lib/commercial/governance";
import {
  useChangeRequests,
  useCommercialMutations,
  useGovernance,
  type ChangeRequest,
} from "@/modules/commercial/api";

const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

export function ApprovalsPanel({ role, userId }: { role: string | null; userId: string | null }) {
  const isOwner = role === "owner";
  const [view, setView] = useState<"pending" | "all">("pending");
  const { data: gov } = useGovernance();
  const { data: requests = [], isLoading } = useChangeRequests(view);
  const m = useCommercialMutations();
  const { toast } = useToast();
  const [rejecting, setRejecting] = useState<ChangeRequest | null>(null);

  async function approve(r: ChangeRequest) {
    try {
      const res = await m.decide.mutateAsync({ id: r.id, approve: true });
      toast({
        title: res.status === "expired" ? "La solicitud venció" : "Aprobado y aplicado",
        variant: res.status === "expired" ? "error" : "success",
      });
    } catch (e) {
      toast({ title: "No se pudo aprobar", description: governanceErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-6">
      {gov && !gov.enabled && (
        <Callout tone="info" icon={ShieldCheck} title="El circuito de aprobación está apagado">
          {isOwner
            ? "Prendelo abajo para que los cambios de tus encargados en promociones de alto impacto y recargos esperen tu aprobación."
            : "El dueño todavía no lo prendió: tus cambios se aplican directo."}
        </Callout>
      )}

      <section className="border-t-2 border-ninja-flame pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Solicitudes</h2>
          <Segmented<"pending" | "all">
            aria-label="Solicitudes"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "pending", label: "Pendientes" },
              { value: "all", label: "Todas" },
            ]}
          />
        </div>

        {!isLoading && requests.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={ShieldCheck}
            title={view === "pending" ? "Nada para revisar" : "Sin solicitudes"}
            description="Cuando un encargado proponga un cambio que necesita aprobación, aparece acá."
          />
        ) : (
          <ul className="mt-3 space-y-3">
            {requests.map((r) => {
              const st = effectiveStatus(r.status, r.expires_at);
              const keys = Object.keys(r.proposed ?? {});
              const mine = userId != null && r.requested_by === userId;
              return (
                <li key={r.id} className="rounded-lg bg-card p-4 ring-1 ring-border">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {ENTITY_LABEL[r.entity_type]}: {r.entity_label ?? "Sin nombre"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {r.kind === "create" ? "Alta" : "Cambio"} propuesto por {r.requested_name ?? "un encargado"} ·{" "}
                        {fmtDateTime(r.requested_at)}
                        {st === "pending" ? ` · vence ${fmtDateTime(r.expires_at)}` : ""}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[st]}>{REQUEST_STATUS_LABEL[st]}</Badge>
                  </div>

                  <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]">
                    {keys.map((k) => (
                      <div key={k} className="contents">
                        <dt className="text-muted-foreground">{fieldLabel(k)}</dt>
                        <dd className="min-w-0 break-words">
                          {r.kind === "update" && (
                            <span className="text-muted-foreground line-through">{formatValue(r.before_data?.[k])}</span>
                          )}
                          {r.kind === "update" ? " " : ""}
                          <span className="font-medium">{formatValue(r.proposed[k])}</span>
                        </dd>
                      </div>
                    ))}
                    {r.impact?.pct != null && (
                      <div className="contents">
                        <dt className="text-muted-foreground">Impacto estimado</dt>
                        <dd className="font-medium">{formatValue(r.impact.pct)} %</dd>
                      </div>
                    )}
                  </dl>

                  {r.decision_note && st !== "pending" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {r.decided_name ? `${r.decided_name}: ` : ""}
                      {r.decision_note}
                    </p>
                  )}

                  {st === "pending" && (isOwner || mine) && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {isOwner && (
                        <>
                          <Button size="sm" onClick={() => approve(r)} loading={m.decide.isPending}>
                            <Check size={15} /> Aprobar
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setRejecting(r)}>
                            <X size={15} /> Rechazar
                          </Button>
                        </>
                      )}
                      {mine && !isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={m.cancel.isPending}
                          onClick={() =>
                            m.cancel.mutate(r.id, {
                              onError: (e) => toast({ title: governanceErrorMessage(e), variant: "error" }),
                            })
                          }
                        >
                          Cancelar solicitud
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isOwner && gov && <GovernanceSettings value={gov} />}

      <ConfirmDialog
        open={Boolean(rejecting)}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Rechazar: ${rejecting?.entity_label ?? ""}`}
        description="El cambio no se aplica. El encargado recibe el motivo."
        confirmLabel="Rechazar"
        danger
        withReason
        reasonLabel="Motivo"
        loading={m.decide.isPending}
        onConfirm={async (reason) => {
          if (!rejecting) return;
          try {
            await m.decide.mutateAsync({ id: rejecting.id, approve: false, note: reason });
            toast({ title: "Rechazado", variant: "success" });
            setRejecting(null);
          } catch (e) {
            toast({ title: "No se pudo rechazar", description: governanceErrorMessage(e), variant: "error" });
          }
        }}
      />
    </div>
  );
}

function GovernanceSettings({ value }: { value: Governance }) {
  const [draft, setDraft] = useState(value);
  const m = useCommercialMutations();
  const { toast } = useToast();
  useEffect(() => setDraft(value), [value]);

  const set = <K extends keyof Governance>(k: K, v: Governance[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function save() {
    try {
      const { has_feature: _hf, ...rest } = draft;
      void _hf;
      await m.saveGovernance.mutateAsync(rest);
      toast({ title: "Política guardada", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: governanceErrorMessage(e), variant: "error" });
    }
  }

  return (
    <section className="border-t-2 border-ninja-flame pt-4">
      <h2 className="text-base font-semibold">Qué necesita tu aprobación</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Sólo frena a los encargados: lo que cambiás vos se aplica directo.
      </p>
      <div className="mt-4 space-y-4">
        <label className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3 text-sm">
          <span>
            <span className="block font-medium">Circuito de aprobación</span>
            <span className="block text-xs text-muted-foreground">
              Lo pendiente queda inactivo (o sin cambios) hasta que lo apruebes.
            </span>
          </span>
          <Switch label="Circuito de aprobación" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Promociones</span>
            <select
              className={cn(selectCls, "h-10 w-full")}
              value={draft.promo_mode}
              onChange={(e) => set("promo_mode", e.target.value as PromoMode)}
            >
              <option value="high_impact" className="bg-popover text-popover-foreground">Sólo las de alto impacto</option>
              <option value="all" className="bg-popover text-popover-foreground">Todas</option>
              <option value="off" className="bg-popover text-popover-foreground">Ninguna</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Recargos y planes de cuotas</span>
            <select
              className={cn(selectCls, "h-10 w-full")}
              value={draft.surcharge_mode}
              onChange={(e) => set("surcharge_mode", e.target.value as SurchargeMode)}
            >
              <option value="all" className="bg-popover text-popover-foreground">Todo alta o cambio</option>
              <option value="off" className="bg-popover text-popover-foreground">Ninguno</option>
            </select>
          </label>
          {draft.promo_mode === "high_impact" && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Alto impacto desde (% de descuento)</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={100}
                  value={draft.promo_pct}
                  onChange={(e) => set("promo_pct", Number(e.target.value))}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">o desde (pesos por ticket)</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  placeholder="Sin tope"
                  value={draft.promo_amount ?? ""}
                  onChange={(e) => set("promo_amount", e.target.value === "" ? null : Number(e.target.value))}
                />
              </label>
            </>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">La solicitud vence a los (días)</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              value={draft.request_ttl_days}
              onChange={(e) => set("request_ttl_days", Number(e.target.value))}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Alto impacto: el descuento estimado (porcentaje, 2x1, segunda unidad o escala) llega al umbral, o la promo es por
          monto, precio fijo, combo o regalo sin un tope por ticket menor al umbral en pesos.
        </p>
        <Button onClick={save} loading={m.saveGovernance.isPending}>
          Guardar
        </Button>
      </div>
    </section>
  );
}
