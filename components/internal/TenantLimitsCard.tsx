"use client";

// =============================================================================
// Límites del plan del negocio (ficha interna › Configuración, ADR-120).
// Grilla compacta: límite del plan (vacío en el plan = sin límite), uso actual
// contra el límite efectivo, override editable y efectivo. Se guardan todos
// los cambios juntos, con confirmación y motivo (internal_set_limit_overrides
// audita antes y después).
// =============================================================================

import { useMemo, useState } from "react";
import { Infinity as InfinityIcon, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { SectionHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { ReasonDialog } from "@/components/internal/ReasonDialog";
import { cn } from "@/lib/utils/cn";
import { billingErrorMessage } from "@/lib/billing/ledger";
import {
  LIMIT_META,
  describeLimit,
  diffOverrides,
  effectiveLimit,
  parseOverride,
  usagePercent,
  usageTone,
  type LimitKey,
  type UsageTone,
} from "@/lib/internal/planLimits";
import { useSetLimitOverrides, useTenantLimits, type LimitRow } from "@/modules/billing/collection";

const BAR: Record<UsageTone, string> = {
  ok: "bg-success",
  near: "bg-warning",
  over: "bg-danger",
  unlimited: "bg-muted-foreground/30",
};
const TEXT: Record<UsageTone, string> = {
  ok: "text-muted-foreground",
  near: "text-warning",
  over: "text-danger",
  unlimited: "text-muted-foreground",
};

const fmt = (n: number) => n.toLocaleString("es-AR");

function Unlimited() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <InfinityIcon size={14} aria-hidden /> Sin límite
    </span>
  );
}

function UsageCell({ row }: { row: LimitRow }) {
  const limit = effectiveLimit(row);
  const tone = usageTone(row.usage, limit);
  return (
    <div className="min-w-[132px]">
      <div className={cn("flex items-baseline justify-between gap-2 text-sm tabular-nums", TEXT[tone])}>
        <span className="font-semibold text-foreground">{fmt(row.usage)}</span>
        <span className="text-xs">{limit === null ? "sin tope" : `de ${fmt(limit)}`}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn("h-full rounded-full", BAR[tone])} style={{ width: `${tone === "unlimited" ? 100 : usagePercent(row.usage, limit)}%` }} />
      </div>
      {tone === "over" && <p className="mt-1 text-xs text-danger">Llegó al límite</p>}
    </div>
  );
}

export function TenantLimitsCard({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useTenantLimits(tenantId);
  const save = useSetLimitOverrides(tenantId);
  const [drafts, setDrafts] = useState<Partial<Record<LimitKey, string>>>({});
  const [confirm, setConfirm] = useState(false);

  const rows = useMemo(() => (data?.rows ?? []) as LimitRow[], [data]);
  const diff = useMemo(() => diffOverrides(rows, drafts), [rows, drafts]);
  const canEdit = Boolean(data?.can_edit);
  const dirty = diff.changes.length > 0;

  const draftOf = (r: LimitRow) => drafts[r.key] ?? (r.override === null ? "" : String(r.override));
  const setDraft = (k: LimitKey, v: string) => setDrafts((d) => ({ ...d, [k]: v.replace(/[^\d]/g, "").slice(0, 9) }));

  async function submit(reason: string) {
    try {
      await save.mutateAsync({ overrides: diff.payload as Record<string, number | null>, reason });
      toast({ title: diff.changes.length === 1 ? "Límite guardado" : "Límites guardados", variant: "success" });
      setDrafts({});
      setConfirm(false);
    } catch (e) {
      toast({ title: "No se pudieron guardar", description: billingErrorMessage(e), variant: "error" });
    }
  }

  const input = (r: LimitRow, compact = false) => {
    const text = draftOf(r);
    const invalid = parseOverride(text) === undefined;
    const changed = drafts[r.key] !== undefined && parseOverride(text) !== r.override;
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          aria-label={`Override de ${LIMIT_META[r.key].label}`}
          value={text}
          disabled={!canEdit || save.isPending}
          onChange={(e) => setDraft(r.key, e.target.value)}
          placeholder={r.plan_value === null ? "Sin límite" : `Plan: ${fmt(r.plan_value)}`}
          className={cn(
            "h-10 rounded-lg border border-input bg-background px-3 text-sm tabular-nums text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20 disabled:opacity-60",
            compact ? "w-full" : "w-36",
            changed && "border-ninja-flameSoft",
            invalid && "border-destructive",
          )}
        />
        {canEdit && text !== "" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft(r.key, "")}
            aria-label={`Quitar el override de ${LIMIT_META[r.key].label}`}
            title="Volver al límite del plan"
            className="h-10 w-10 shrink-0 px-0"
          >
            <RotateCcw size={15} aria-hidden />
          </Button>
        )}
      </div>
    );
  };

  return (
    <section>
      <SectionHeader
        title="Límites del plan"
        icon={SlidersHorizontal}
        description="Lo que el plan permite, lo que el negocio usa hoy y los overrides solo para este negocio. Un override vacío vuelve al límite del plan."
        actions={
          data ? (
            <Badge tone="brand">
              Plan {data.plan.name}
              {data.plan.is_custom ? " · a medida" : ""}
            </Badge>
          ) : undefined
        }
      />

      {error ? (
        <Callout tone="warning" icon={SlidersHorizontal} title="No se pudieron cargar los límites" className="mt-3">
          {billingErrorMessage(error)}
        </Callout>
      ) : isLoading || !data ? (
        <Skeleton className="mt-3 h-[300px] rounded-xl" />
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
          {/* Escritorio: tabla */}
          <table className="hidden w-full text-sm md:table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Límite</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Uso actual</th>
                <th className="px-4 py-3 font-medium">Override</th>
                <th className="px-4 py-3 text-right font-medium">Rige</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const draft = parseOverride(draftOf(r));
                const eff = draft === undefined ? effectiveLimit(r) : (draft ?? r.plan_value);
                return (
                  <tr key={r.key} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{LIMIT_META[r.key].label}</p>
                      <p className="text-xs text-muted-foreground">{LIMIT_META[r.key].hint}</p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {r.plan_value === null ? <Unlimited /> : fmt(r.plan_value)}
                    </td>
                    <td className="px-4 py-3">
                      <UsageCell row={r} />
                    </td>
                    <td className="px-4 py-3">{input(r)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">
                      {eff === null ? <Unlimited /> : fmt(eff)}
                      {r.override !== null && drafts[r.key] === undefined && (
                        <span className="ml-2 align-middle">
                          <Badge tone="brand">Override</Badge>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Celular: lista */}
          <ul className="divide-y divide-border md:hidden">
            {rows.map((r) => (
              <li key={r.key} className="space-y-3 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{LIMIT_META[r.key].label}</p>
                    <p className="text-xs text-muted-foreground">
                      Plan: {r.plan_value === null ? "sin límite" : fmt(r.plan_value)}
                    </p>
                  </div>
                  {r.override !== null && <Badge tone="brand">Override</Badge>}
                </div>
                <UsageCell row={r} />
                {input(r, true)}
              </li>
            ))}
          </ul>

          {canEdit ? (
            <div className="flex flex-col gap-3 border-t border-border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {diff.invalid.length > 0
                  ? "Hay valores inválidos: usá números enteros desde 0."
                  : dirty
                    ? `${diff.changes.length} ${diff.changes.length === 1 ? "cambio sin guardar" : "cambios sin guardar"}`
                    : "Escribí un número para fijar un override. Se guarda todo junto, con motivo."}
              </p>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" disabled={!dirty && Object.keys(drafts).length === 0} onClick={() => setDrafts({})}>
                  Descartar
                </Button>
                <Button size="sm" disabled={!dirty || diff.invalid.length > 0} onClick={() => setConfirm(true)}>
                  Guardar cambios
                </Button>
              </div>
            </div>
          ) : (
            <p className="border-t border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Sólo admin y super admin cambian los límites de un negocio.
            </p>
          )}
        </div>
      )}

      <ReasonDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Guardar límites"
        description="Rigen apenas los guardás: lo que el negocio ya tiene no se borra, pero no puede sumar más por encima del límite."
        confirmLabel="Guardar límites"
        loading={save.isPending}
        extra={
          <ul className="divide-y divide-border overflow-hidden rounded-lg bg-muted/50 text-sm">
            {diff.changes.map((c) => {
              const row = rows.find((r) => r.key === c.key);
              return (
                <li key={c.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="font-medium">{LIMIT_META[c.key].label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {describeLimit(c.from, row?.plan_value ?? null)} <span aria-hidden>→</span>{" "}
                    <span className="font-semibold text-foreground">{describeLimit(c.to, row?.plan_value ?? null)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        }
        onConfirm={(reason) => void submit(reason)}
      />
    </section>
  );
}
TenantLimitsCard.displayName = "TenantLimitsCard";
