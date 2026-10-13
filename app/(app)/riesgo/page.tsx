"use client";

import { useEffect, useMemo, useState } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { formatCurrency } from "@/lib/utils/format";
import { DEFAULT_RISK_SETTINGS, reasonLabel, validateRiskSettings, type RiskSettings } from "@/lib/risk/riskScore";
import { RISK_LEVEL_LABEL, rankPeople, riskErrorMessage, type RiskLevel } from "@/lib/risk/operationalRisk";
import { useFeature } from "@/modules/saas/gating";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useBranchContext } from "@/modules/branches/hooks";
import {
  useRiskFlags,
  useRiskMutations,
  useRiskSettings,
  useRiskSignals,
  type RiskFlag,
  type RiskFlagStatus,
} from "@/modules/risk/api";
import { fmtDateTime } from "@/components/stock/transfers/shared";

type Tab = "personas" | "marcas" | "reglas";
type Period = "7" | "30" | "90";

const LEVEL_TONE: Record<RiskLevel, BadgeTone> = { alto: "danger", medio: "warning", bajo: "neutral" };
const FLAG_TONE: Record<RiskFlagStatus, BadgeTone> = { pendiente: "warning", revisada: "success", descartada: "neutral" };
const FLAG_LABEL: Record<RiskFlagStatus, string> = { pendiente: "Pendiente", revisada: "Revisada", descartada: "Descartada" };

const FIELDS: { key: keyof RiskSettings; label: string; hint: string; step?: string }[] = [
  { key: "return_amount_high", label: "Monto alto ($)", hint: "Devoluciones o anulaciones desde este monto suman riesgo." },
  { key: "return_days_late", label: "Plazo de devolución (días)", hint: "Devolver después de este plazo suma riesgo." },
  { key: "returns_per_user_day", label: "Devoluciones por persona por día", hint: "Pasado este número, cada devolución suma riesgo." },
  { key: "voids_per_user_day", label: "Anulaciones por persona por día", hint: "Pasado este número, cada anulación suma riesgo." },
  { key: "discount_pct_high", label: "Descuento alto (%)", hint: "Descuento promedio sobre lo vendido que se marca como señal.", step: "0.1" },
  { key: "cash_diff_abs", label: "Diferencia de caja ($)", hint: "Cierres con una diferencia mayor cuentan como señal." },
  { key: "flag_score_min", label: "Puntaje para marcar (1 a 100)", hint: "Desde este puntaje la operación queda marcada para revisar." },
];

// Prevención de fraude y riesgo operativo (F16 · H82, ADR-091): señales por
// persona, operaciones marcadas para revisar y reglas del negocio.
export default function RiesgoPage() {
  const enabled = useFeature("prevencion_fraude");
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const ctx = useBranchContext();
  const allowed = enabled === true && Boolean(me?.canManage);
  const [tab, setTab] = useState<Tab>("personas");
  const [period, setPeriod] = useState<Period>("30");
  const [flagStatus, setFlagStatus] = useState<RiskFlagStatus | "todas">("pendiente");
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [reviewing, setReviewing] = useState<{ flag: RiskFlag; status: RiskFlagStatus } | null>(null);
  const [note, setNote] = useState("");
  const [form, setForm] = useState<RiskSettings>(DEFAULT_RISK_SETTINGS);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - Number(period) * 86_400_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [period]);

  const signals = useRiskSignals(range.from, range.to, ctx.filterStoreId, allowed && ctx.ready && tab === "personas");
  const flags = useRiskFlags(flagStatus, ctx.filterStoreId, allowed && tab === "marcas");
  const settings = useRiskSettings(allowed);
  const m = useRiskMutations();

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  const people = useMemo(
    () => (signals.data ? rankPeople(signals.data.people, signals.data.settings) : []),
    [signals.data],
  );
  const formErrors = validateRiskSettings(form);

  async function saveSettings() {
    try {
      await m.saveSettings.mutateAsync(form);
      toast({ title: "Reglas guardadas", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudieron guardar", description: riskErrorMessage(e), variant: "error" });
    }
  }

  async function confirmReview() {
    if (!reviewing) return;
    try {
      await m.review.mutateAsync({ id: reviewing.flag.id, status: reviewing.status, note });
      toast({ title: reviewing.status === "revisada" ? "Marcada como revisada" : "Marca descartada", variant: "success" });
      setReviewing(null);
      setNote("");
    } catch (e) {
      toast({ title: "No se pudo guardar", description: riskErrorMessage(e), variant: "error" });
    }
  }

  const header = (
    <PageHeader
      eyebrow="Gestión"
      title="Riesgo operativo"
      icon={ShieldAlert}
      description="Anulaciones, descuentos, devoluciones, cobros rechazados y diferencias de caja por persona. Son señales para revisar, no acusaciones."
    />
  );

  if (enabled === false) {
    return (
      <PageContainer>
        {header}
        <div className="mt-8 rounded-lg bg-muted/40 p-8 text-center">
          <Lock className="mx-auto text-ninja-flameSoft" size={28} />
          <p className="mt-3 font-semibold">La prevención de fraude no está incluida en tu plan</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Detectá anulaciones y devoluciones fuera de patrón, marcá las operaciones de riesgo y revisalas con historial.
          </p>
          <Button className="mt-4" onClick={() => setUpgradeOpen(true)}>
            Ver planes
          </Button>
          <UpgradeModal
            open={upgradeOpen}
            onOpenChange={setUpgradeOpen}
            featureKey="prevencion_fraude"
            featureLabel="Prevención de fraude"
          />
        </div>
      </PageContainer>
    );
  }

  if (me && !me.canManage) {
    return (
      <PageContainer>
        {header}
        <EmptyState icon={Lock} title="Sólo el dueño o un encargado ven el riesgo operativo" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {header}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented<Tab>
          aria-label="Vista"
          value={tab}
          onChange={setTab}
          size="sm"
          options={[
            { value: "personas", label: "Personas" },
            { value: "marcas", label: "Para revisar" },
            { value: "reglas", label: "Reglas" },
          ]}
        />
        {tab === "personas" && (
          <Segmented<Period>
            aria-label="Período"
            value={period}
            onChange={setPeriod}
            size="sm"
            options={[
              { value: "7", label: "7 días" },
              { value: "30", label: "30 días" },
              { value: "90", label: "90 días" },
            ]}
          />
        )}
        {tab === "marcas" && (
          <Segmented<RiskFlagStatus | "todas">
            aria-label="Estado"
            value={flagStatus}
            onChange={setFlagStatus}
            size="sm"
            options={[
              { value: "pendiente", label: "Pendientes" },
              { value: "revisada", label: "Revisadas" },
              { value: "descartada", label: "Descartadas" },
              { value: "todas", label: "Todas" },
            ]}
          />
        )}
      </div>

      {tab === "personas" && (
        <section className="mt-6 border-t-2 border-ninja-flame pt-4">
          {signals.error ? (
            <p className="text-sm text-danger">{riskErrorMessage(signals.error)}</p>
          ) : signals.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Calculando señales…</p>
          ) : people.length === 0 ? (
            <EmptyState icon={ShieldAlert} title="Sin movimientos en el período" />
          ) : (
            <ul className="divide-y divide-border">
              {people.map((p) => (
                <li key={p.row.user_id ?? "none"} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{p.row.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.row.sales_count} ventas · {formatCurrency(p.row.sales_total)} · {p.row.voids_count} anulaciones ·{" "}
                        {p.row.returns_count} devoluciones
                      </p>
                    </div>
                    <Badge tone={LEVEL_TONE[p.level]}>
                      {RISK_LEVEL_LABEL[p.level]}
                      {p.score > 0 ? ` · ${p.score}` : ""}
                    </Badge>
                  </div>
                  {p.signals.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-sm">
                      {p.signals.map((s) => (
                        <li key={s.kind} className="flex items-center gap-2">
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                          {s.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "marcas" && (
        <section className="mt-6 border-t-2 border-ninja-flame pt-4">
          {flags.error ? (
            <p className="text-sm text-danger">{riskErrorMessage(flags.error)}</p>
          ) : flags.isLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Cargando…</p>
          ) : (flags.data ?? []).length === 0 ? (
            <EmptyState
              icon={ShieldAlert}
              title="No hay operaciones marcadas"
              description="Las devoluciones y anulaciones que superan el puntaje de las reglas aparecen acá."
            />
          ) : (
            <ul className="divide-y divide-border">
              {(flags.data ?? []).map((f) => (
                <li key={f.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {f.kind === "return" ? "Devolución" : "Anulación"}
                        {f.sale ? ` de la venta #${f.sale.number}` : ""} · {formatCurrency(f.amount)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {f.actor?.full_name || f.actor?.email || "Sin usuario"}
                        {f.store_id ? ` · ${ctx.branchName(f.store_id) ?? "Sucursal"}` : ""} · {fmtDateTime(f.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs tabular-nums text-muted-foreground">Puntaje {f.score}</span>
                      <Badge tone={FLAG_TONE[f.status]}>{FLAG_LABEL[f.status]}</Badge>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {f.reasons.map((r) => (
                      <Badge key={r} tone="neutral">
                        {reasonLabel(r)}
                      </Badge>
                    ))}
                  </div>
                  {f.review_note && <p className="mt-1 text-xs text-muted-foreground">Nota: {f.review_note}</p>}
                  {f.status === "pendiente" && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setReviewing({ flag: f, status: "revisada" })}>
                        Marcar revisada
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setReviewing({ flag: f, status: "descartada" })}>
                        Descartar
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "reglas" && (
        <section className="mt-6 border-t-2 border-ninja-flame pt-4">
          <p className="text-sm text-muted-foreground">
            Cada devolución y anulación suma puntos por monto alto, plazo, repetición en el día, efectivo sin cliente,
            turno ya cerrado o la misma persona que vendió. Desde el puntaje para marcar, queda para revisar y en la
            auditoría.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <Input
                  label={f.label}
                  type="number"
                  inputMode="decimal"
                  step={f.step ?? "1"}
                  value={String(form[f.key])}
                  onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                />
                <p className="mt-1 text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>
          {formErrors.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-danger">
              {formErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex justify-end">
            <Button onClick={saveSettings} disabled={formErrors.length > 0} loading={m.saveSettings.isPending}>
              Guardar reglas
            </Button>
          </div>
        </section>
      )}

      <Modal
        open={reviewing != null}
        onOpenChange={(o) => {
          if (!o) {
            setReviewing(null);
            setNote("");
          }
        }}
        title={reviewing?.status === "descartada" ? "Descartar marca" : "Marcar como revisada"}
        description="Queda en la auditoría con tu usuario."
        footer={
          <>
            <Button variant="secondary" onClick={() => setReviewing(null)}>
              Volver
            </Button>
            <Button
              onClick={confirmReview}
              disabled={reviewing?.status === "descartada" && note.trim().length < 3}
              loading={m.review.isPending}
            >
              Guardar
            </Button>
          </>
        }
      >
        <Input
          label={reviewing?.status === "descartada" ? "Por qué la descartás" : "Nota (opcional)"}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </Modal>
    </PageContainer>
  );
}
