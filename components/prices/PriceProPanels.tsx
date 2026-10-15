"use client";

import { useMemo, useState } from "react";
import { Check, Download, Eye, RotateCcw, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { PreviewTable } from "@/components/prices/BulkUpdateWizard";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { termSurcharge, type TermRateMode } from "@/lib/prices/bulk";
import { useProducts } from "@/modules/products/hooks";
import {
  priceProApi,
  FX_SOURCES,
  type BulkBatch,
  type FxSource,
  type PaymentTerm,
  type ProList,
} from "@/modules/prices/proApi";
import {
  useBatchLines,
  useFxRates,
  useIndexValues,
  usePaymentTerms,
  usePriceBatches,
  usePriceProMutations,
  useUpcomingPrices,
} from "@/modules/prices/proHooks";
import { Field, fieldCls, formatWhen, friendlyPriceError, numOrNull } from "@/components/prices/shared";

const STATUS: Record<BulkBatch["status"], { label: string; tone: BadgeTone }> = {
  pending_approval: { label: "Para aprobar", tone: "warning" },
  scheduled: { label: "Programado", tone: "info" },
  applied: { label: "Aplicado", tone: "success" },
  rejected: { label: "Rechazado", tone: "neutral" },
  reverted: { label: "Deshecho", tone: "neutral" },
};

// ── Cambios masivos: historial, aprobación y deshacer ─────────────────────────
export function PriceBatchesPanel({ lists, isOwner }: { lists: ProList[]; isOwner: boolean }) {
  const { toast } = useToast();
  const { data: batches } = usePriceBatches();
  const m = usePriceProMutations();
  const [undo, setUndo] = useState<BulkBatch | null>(null);
  const [detail, setDetail] = useState<BulkBatch | null>(null);
  const lines = useBatchLines(detail?.id ?? null);
  const names = new Map(lists.map((l) => [l.id, l.name]));

  function describe(b: BulkBatch): string {
    if (b.engine === 2) {
      const how =
        b.mode === "fx"
          ? `dólar ${b.fx_rate != null ? formatCurrency(Number(b.fx_rate)) : ""}`
          : b.mode === "markup"
            ? `${b.options?.markup_mode === "margin" ? "margen" : "markup"} ${Number(b.value)}%`
            : b.mode === "cost"
              ? "desde costo"
              : b.mode === "pct"
                ? `${Number(b.value) > 0 ? "+" : ""}${Number(b.value)}%`
                : `${Number(b.value) > 0 ? "+" : ""}${formatCurrency(Number(b.value))}`;
      const where = [
        b.options?.targets?.base !== false ? "precio de venta" : null,
        ...(b.list_ids ?? []).map((id) => `lista ${names.get(id) ?? ""}`),
      ]
        .filter(Boolean)
        .join(", ");
      return `${how} en ${where || "costos"} · ${b.line_count} cambios`;
    }
    const how =
      b.mode === "index"
        ? `índice ${b.index_info?.kind === "fx" ? `dólar ${b.index_info.source}` : (b.index_info?.key ?? "")} (${Number(b.value)}%)`
        : b.mode === "pct"
          ? `${Number(b.value) > 0 ? "+" : ""}${Number(b.value)}%`
          : `${Number(b.value) > 0 ? "+" : ""}${formatCurrency(Number(b.value))}`;
    const where = b.target_list_id ? `lista ${names.get(b.target_list_id) ?? ""}` : "precio de venta";
    return `${how} en ${where} · ${b.line_count} precios`;
  }

  if ((batches ?? []).length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Todavía no hubo cambios masivos.</p>;
  }

  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {(batches ?? []).map((b) => (
        <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
              {b.origin === "auto" && <Badge tone="info">Automático</Badge>}
              <span className="truncate">{describe(b)}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {formatWhen(b.created_at)}
              {b.effective_at ? ` · rige ${formatWhen(b.effective_at)}` : ""}
              {b.reason ? ` · ${b.reason}` : ""}
              {b.approval_note ? ` · aprobación: ${b.approval_note}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {b.status === "pending_approval" && isOwner && (
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    m.bulkDecide.mutate(
                      { id: b.id, approve: true },
                      {
                        onSuccess: () => toast({ title: "Aprobado", variant: "success" }),
                        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
                      },
                    )
                  }
                >
                  <Check size={14} /> Aprobar
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => m.bulkDecide.mutate({ id: b.id, approve: false })}
                >
                  <X size={14} /> Rechazar
                </Button>
              </>
            )}
            {b.engine === 2 && (
              <Button size="sm" variant="ghost" onClick={() => setDetail(b)}>
                <Eye size={14} /> Ver
              </Button>
            )}
            {(b.status === "applied" || b.status === "scheduled") && (
              <Button size="sm" variant="secondary" onClick={() => setUndo(b)}>
                <RotateCcw size={14} /> Deshacer
              </Button>
            )}
          </div>
        </div>
      ))}
      <ConfirmDialog
        open={undo !== null}
        onOpenChange={(o) => !o && setUndo(null)}
        title="Deshacer el cambio"
        description="Vuelven al precio (y al costo en dólares) anterior los productos que nadie cambió después. Lo programado se cancela."
        confirmLabel="Deshacer"
        loading={m.bulkRevert.isPending}
        onConfirm={() =>
          undo &&
          m.bulkRevert.mutate(undo.id, {
            onSuccess: (r) => {
              toast({
                title: `Deshecho: ${r.reverted} precios${r.costs ? ` y ${r.costs} costos` : ""}`,
                description: r.skipped > 0 ? `${r.skipped} no se tocaron porque cambiaron después.` : undefined,
                variant: "success",
              });
              setUndo(null);
            },
            onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
          })
        }
      />
      <Modal open={detail !== null} onOpenChange={(o) => !o && setDetail(null)} title="Detalle del cambio" className="sm:max-w-3xl">
        {detail && <p className="mb-3 text-sm text-muted-foreground">{describe(detail)}</p>}
        {lines.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando</p>
        ) : (
          <PreviewTable rows={lines.data ?? []} listName={names} />
        )}
      </Modal>
    </div>
  );
}

// ── Precios programados ───────────────────────────────────────────────────────
export function UpcomingPricesPanel({ lists }: { lists: ProList[] }) {
  const { data: rows } = useUpcomingPrices();
  const { data: products } = useProducts("");
  const m = usePriceProMutations();
  const names = new Map((products ?? []).map((p) => [p.id, p.name]));
  const listNames = new Map(lists.map((l) => [l.id, l.name]));
  if ((rows ?? []).length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Sin precios programados. Programalos desde Actualizar precios, la importación o la ficha del producto.
      </p>
    );
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {(rows ?? []).map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 truncate">
            {names.get(s.product_id) ?? "Producto"}
            <span className="text-muted-foreground"> · {s.list_id ? `lista ${listNames.get(s.list_id) ?? ""}` : "precio de venta"}</span>
          </span>
          <span className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-muted-foreground">{formatWhen(s.effective_at)}</span>
            <span className="font-medium tabular-nums">{formatCurrency(s.price)}</span>
            {!s.batch_id && (
              <button
                type="button"
                aria-label="Cancelar programado"
                onClick={() => m.scheduleCancel.mutate(s.id)}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Condiciones de pago ───────────────────────────────────────────────────────
export function PaymentTermsPanel() {
  const { toast } = useToast();
  const { data: terms } = usePaymentTerms();
  const m = usePriceProMutations();
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [rateMode, setRateMode] = useState<TermRateMode>("flat");
  const [rate, setRate] = useState("");
  const [pct, setPct] = useState("");
  const computed = useMemo(() => {
    const r = numOrNull(rate);
    const d = numOrNull(days);
    if (rateMode === "flat" || r == null || d == null) return null;
    return termSurcharge(r, d, rateMode);
  }, [rate, days, rateMode]);

  function add() {
    const d = numOrNull(days);
    const s = rateMode === "flat" ? numOrNull(pct) : computed;
    if (!name.trim() || d == null || s == null) {
      toast({ title: "Completá nombre, días y recargo", variant: "error" });
      return;
    }
    m.saveTerm.mutate(
      {
        name: name.trim(),
        days: d,
        surcharge_pct: s,
        rate_mode: rateMode,
        monthly_rate: rateMode === "flat" ? null : numOrNull(rate),
        sort: (terms?.length ?? 0) + 1,
      },
      {
        onSuccess: () => {
          setName("");
          setRate("");
          setPct("");
        },
        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
      },
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Contado, 30, 60 o 90 días con recargo financiero. Se elige en el POS o sale de la ficha del cliente.
      </p>
      {(terms ?? []).length > 0 && (
        <div className="divide-y divide-border rounded-md border border-border">
          {(terms ?? []).map((t: PaymentTerm) => (
            <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {t.name}
                <span className="text-muted-foreground">
                  {" "}
                  · {t.days} días · recargo {Number(t.surcharge_pct)}%
                  {t.rate_mode !== "flat" && t.monthly_rate != null
                    ? ` (${t.monthly_rate}% mensual, ${t.rate_mode === "simple" ? "simple" : "compuesto"})`
                    : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Switch
                  checked={t.is_active}
                  onCheckedChange={(v) => m.saveTerm.mutate({ ...t, is_active: v })}
                  label="Activa"
                />
                <button
                  type="button"
                  aria-label="Quitar condición"
                  onClick={() => m.removeTerm.mutate(t.id)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-5">
        <Field label="Nombre" className="sm:col-span-2">
          <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="30 días" />
        </Field>
        <Field label="Días">
          <input className={fieldCls} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <Field label="Cálculo">
          <select className={fieldCls} value={rateMode} onChange={(e) => setRateMode(e.target.value as TermRateMode)}>
            <option value="flat">% fijo</option>
            <option value="simple">Tasa mensual simple</option>
            <option value="compound">Tasa mensual compuesta</option>
          </select>
        </Field>
        {rateMode === "flat" ? (
          <Field label="Recargo %">
            <input className={fieldCls} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="5" />
          </Field>
        ) : (
          <Field label="Tasa mensual %" hint={computed != null ? `Recargo: ${computed}%` : undefined}>
            <input className={fieldCls} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="4" />
          </Field>
        )}
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={add} loading={m.saveTerm.isPending}>
          Agregar condición
        </Button>
      </div>
    </div>
  );
}

// ── Cotizaciones e índices ────────────────────────────────────────────────────
export function FxIndexPanel() {
  const { toast } = useToast();
  const { data: rates } = useFxRates();
  const { data: values } = useIndexValues();
  const m = usePriceProMutations();
  const today = new Date().toISOString().slice(0, 10);
  const [source, setSource] = useState<FxSource>("oficial");
  const [rateDate, setRateDate] = useState(today);
  const [rate, setRate] = useState("");
  const [idxKey, setIdxKey] = useState("ipc");
  const [period, setPeriod] = useState(today.slice(0, 8) + "01");
  const [idxValue, setIdxValue] = useState("");
  const [fetching, setFetching] = useState(false);

  async function fetchRate() {
    if (source === "manual") return;
    setFetching(true);
    const v = await priceProApi.fetchPublicUsd(source === "bna" ? "oficial" : source);
    setFetching(false);
    if (v == null) toast({ title: "No se pudo traer la cotización. Cargala a mano.", variant: "error" });
    else setRate(String(v));
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Cotizaciones del dólar</h3>
        <p className="text-xs text-muted-foreground">
          Las usan las listas en moneda extranjera y la actualización por dólar. Vale la última cargada hasta el día.
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]">
          <select className={fieldCls} value={source} onChange={(e) => setSource(e.target.value as FxSource)} aria-label="Fuente">
            {FX_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <input type="date" className={fieldCls} value={rateDate} onChange={(e) => setRateDate(e.target.value)} aria-label="Fecha" />
          <input className={fieldCls} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Valor" aria-label="Valor" />
          <Button variant="secondary" onClick={fetchRate} loading={fetching} disabled={source === "manual"} title="Traer la cotización del día">
            <Download size={15} /> Traer
          </Button>
          <Button
            onClick={() => {
              const v = numOrNull(rate);
              if (v == null || v <= 0) return;
              m.saveFx.mutate(
                { currency: "USD", source, rate_date: rateDate, rate: v },
                {
                  onSuccess: () => setRate(""),
                  onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
                },
              );
            }}
            loading={m.saveFx.isPending}
          >
            Guardar
          </Button>
        </div>
        {(rates ?? []).length > 0 && (
          <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {(rates ?? []).map((r) => (
              <div key={r.id} className="flex justify-between px-3 py-1.5 text-sm">
                <span>
                  {r.rate_date} · {FX_SOURCES.find((s) => s.value === r.source)?.label ?? r.source}
                </span>
                <span className="tabular-nums">{formatCurrency(r.rate)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Índices (IPC u otro)</h3>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input className={fieldCls} value={idxKey} onChange={(e) => setIdxKey(e.target.value)} aria-label="Índice" />
          <input type="date" className={fieldCls} value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Período" />
          <input className={fieldCls} inputMode="decimal" value={idxValue} onChange={(e) => setIdxValue(e.target.value)} placeholder="Valor" aria-label="Valor" />
          <Button
            onClick={() => {
              const v = numOrNull(idxValue);
              if (v == null || v <= 0) return;
              m.saveIndex.mutate(
                { index_key: idxKey.trim().toLowerCase(), period, value: v },
                {
                  onSuccess: () => setIdxValue(""),
                  onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
                },
              );
            }}
            loading={m.saveIndex.isPending}
          >
            Guardar
          </Button>
        </div>
        {(values ?? []).length > 0 ? (
          <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {(values ?? []).map((v) => (
              <div key={v.id} className="flex justify-between px-3 py-1.5 text-sm">
                <span>
                  {v.index_key.toUpperCase()} · {v.period}
                </span>
                <span className="tabular-nums">{v.value}</span>
              </div>
            ))}
          </div>
        ) : (
          <Callout tone="neutral">Cargá el IPC del INDEC (o tu índice) mes a mes para actualizar por inflación.</Callout>
        )}
      </section>
    </div>
  );
}
