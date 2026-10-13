"use client";

// Retenciones como agente en la orden de pago (F18 · H106, ADR-079). El
// servidor calcula (tax_retention_preview) con los regímenes del negocio, el
// padrón, el concepto de Ganancias y lo ya pagado en el mes; acá se muestra el
// desglose de cada régimen con por qué se retiene o no, en lenguaje simple.
// Al registrar, supplier_payment_order_create vuelve a calcular y numera los
// certificados (si el total cambió, avisa y se recalcula).

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info as InfoIcon } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { RET_TAX_LABEL, explainRetention, type GananciasCondition } from "@/lib/tax/retentions";
import { jurisdictionName } from "@/lib/tax/catalog";
import { useQuery } from "@tanstack/react-query";
import { taxApi, taxErrorMessage, type RetentionOptions, type RetentionPreview } from "@/modules/tax/api";
import { useRetConcepts, useSupplierTaxProfile, useTaxRegimes } from "@/modules/tax/hooks";
import { FormField, SectionTitle, selectCls } from "./shared";

export interface AgentRetentionsState {
  /** El negocio es agente de retención (feature y algún régimen de retención activo). */
  active: boolean;
  options: RetentionOptions;
  setOptions: (o: RetentionOptions) => void;
  saveProfile: boolean;
  setSaveProfile: (v: boolean) => void;
  preview: RetentionPreview | null;
  total: number;
  /** Calculando o esperando el debounce: no se puede registrar. */
  loading: boolean;
  error: string | null;
  refetch: () => void;
  hasTax: (t: "ganancias" | "suss") => boolean;
}

export function useAgentRetentions(args: {
  enabled: boolean;
  supplierId: string;
  date: string;
  allocations: { invoice_id: string; amount: number }[];
  /** Base cuando no hay imputación (anticipo): lo que se paga más las retenciones manuales. */
  amount: number;
}): AgentRetentionsState {
  const { data: regimes = [] } = useTaxRegimes(args.enabled);
  const retRegimes = regimes.filter((r) => r.role === "retention" && r.is_active);
  const active = args.enabled && retRegimes.length > 0;
  const { data: profile, isFetched: profileFetched } = useSupplierTaxProfile(
    active && args.supplierId ? args.supplierId : null,
  );
  const [options, setOptions] = useState<RetentionOptions>({});
  const [saveProfile, setSaveProfile] = useState(true);

  // Al cambiar de proveedor, las opciones salen de su ficha.
  useEffect(() => {
    if (!profileFetched) return;
    setOptions({
      ganancias_concept: profile?.ganancias_concept ?? null,
      ganancias_condition: profile?.ganancias_condition ?? null,
      suss_code: profile?.suss_code ?? null,
    });
  }, [args.supplierId, profile, profileFetched]);

  const payload = useMemo(
    () => ({
      supplier_id: args.supplierId,
      allocations: args.allocations,
      amount: Math.round(args.amount * 100) / 100,
      date: args.date,
      options,
    }),
    [args.supplierId, args.allocations, args.amount, args.date, options],
  );
  const sig = JSON.stringify(payload);
  const [debounced, setDebounced] = useState(sig);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(sig), 300);
    return () => clearTimeout(t);
  }, [sig]);

  const ready = active && Boolean(args.supplierId) && profileFetched;
  const q = useQuery({
    queryKey: ["tax", "retention-preview", debounced],
    queryFn: () => taxApi.retentionPreview(JSON.parse(debounced) as typeof payload),
    enabled: ready && debounced === sig,
    staleTime: 15_000,
  });

  return {
    active,
    options,
    setOptions,
    saveProfile,
    setSaveProfile,
    preview: ready ? (q.data ?? null) : null,
    total: ready && q.data ? q.data.total : 0,
    loading: ready && (q.isFetching || debounced !== sig || !q.data),
    error: q.error ? taxErrorMessage(q.error) : null,
    refetch: () => void q.refetch(),
    hasTax: (t) => retRegimes.some((r) => r.tax === t),
  };
}

const CONDITIONS: { v: GananciasCondition | ""; label: string }[] = [
  { v: "", label: "Sin cargar (se toma como inscripto)" },
  { v: "inscripto", label: "Inscripto" },
  { v: "no_inscripto", label: "No inscripto (retención mayor)" },
  { v: "exento", label: "Exento" },
  { v: "no_alcanzado", label: "No alcanzado" },
];

const WARNING_TEXT: Record<string, string> = {
  ganancias_condition_unknown:
    "No cargaste la condición del proveedor en Ganancias: se calcula como inscripto. Si no está inscripto la retención es mayor; pedile la constancia de inscripción.",
  supplier_without_cuit:
    "El proveedor no tiene CUIT: no se puede buscar en el padrón y el certificado sale incompleto.",
};

export function AgentRetentionsSection({ state }: { state: AgentRetentionsState }) {
  const { data: concepts = [] } = useRetConcepts(state.active);
  const gan = concepts.filter((c) => c.tax === "ganancias" && c.is_active);
  const suss = concepts.filter((c) => c.tax === "suss" && c.is_active);
  const p = state.preview;
  const set = (patch: RetentionOptions) => state.setOptions({ ...state.options, ...patch });

  return (
    <section className="space-y-3">
      <SectionTitle>Retenciones como agente</SectionTitle>
      <p className="text-xs text-muted-foreground">
        NinjaSoft las calcula con tus regímenes, el padrón y lo que ya le pagaste a este proveedor en el mes. Se descuentan
        de lo que le pagás y cada una sale con su certificado.
      </p>

      {(state.hasTax("ganancias") || state.hasTax("suss")) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {state.hasTax("ganancias") && (
            <>
              <FormField label="¿Qué le estás pagando? (Ganancias)">
                <select
                  className={selectCls}
                  value={state.options.ganancias_concept ?? ""}
                  onChange={(e) => set({ ganancias_concept: e.target.value || null })}
                >
                  <option value="" className="bg-popover text-popover-foreground">
                    Elegí el concepto
                  </option>
                  {gan.map((c) => (
                    <option key={c.code} value={c.code} className="bg-popover text-popover-foreground">
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Condición en Ganancias">
                <select
                  className={selectCls}
                  value={state.options.ganancias_condition ?? ""}
                  onChange={(e) =>
                    set({ ganancias_condition: (e.target.value || null) as GananciasCondition | null })
                  }
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.v} value={c.v} className="bg-popover text-popover-foreground">
                      {c.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </>
          )}
          {state.hasTax("suss") && (
            <FormField label="Actividad alcanzada por SUSS">
              <select
                className={selectCls}
                value={state.options.suss_code ?? ""}
                onChange={(e) => set({ suss_code: e.target.value || null })}
              >
                <option value="" className="bg-popover text-popover-foreground">
                  No corresponde
                </option>
                {suss.map((c) => (
                  <option key={c.code} value={c.code} className="bg-popover text-popover-foreground">
                    {c.name}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <label className="flex items-center gap-2 py-2 text-sm sm:col-span-2">
            <Checkbox checked={state.saveProfile} onCheckedChange={state.setSaveProfile} />
            Recordar estos datos para el proveedor
          </label>
        </div>
      )}

      {state.error ? (
        <Callout tone="danger" icon={AlertTriangle}>
          {state.error}
        </Callout>
      ) : !p ? (
        <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">Calculando retenciones...</p>
      ) : (
        <div className={cn("space-y-2", state.loading && "opacity-60")}>
          {p.warnings.map((w) => (
            <Callout key={w} tone="warning" icon={InfoIcon}>
              {WARNING_TEXT[w] ?? w}
            </Callout>
          ))}
          {p.lines.length === 0 && (
            <p className="rounded-md bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              No tenés regímenes de retención activos.
            </p>
          )}
          <ul className="space-y-2">
            {p.lines.map((l) => (
              <li key={l.regime_id} className="rounded-md bg-muted/50 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {RET_TAX_LABEL[l.tax]}
                      {l.jurisdiction ? ` ${jurisdictionName(l.jurisdiction)}` : ""}
                      <Badge tone={l.applies ? "brand" : "neutral"}>{l.applies ? "Se retiene" : "No corresponde"}</Badge>
                    </div>
                    {l.concept_name && <div className="text-xs text-muted-foreground">{l.concept_name}</div>}
                  </div>
                  <span className={cn("shrink-0 text-sm tabular-nums", l.applies ? "font-semibold" : "text-muted-foreground")}>
                    {formatCurrency(l.amount)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{explainRetention(l)}</p>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
            <span>Total a retener</span>
            <b className="tabular-nums">{formatCurrency(p.total)}</b>
          </div>
        </div>
      )}
    </section>
  );
}
