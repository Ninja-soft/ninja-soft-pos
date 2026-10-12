"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { summarizePreview } from "@/lib/prices/bulk";
import type { RoundingRule } from "@/lib/prices/rounding";
import { useBrands, useCategories } from "@/modules/products/hooks";
import { useSuppliers } from "@/modules/purchases/hooks";
import { useFeature } from "@/modules/saas/gating";
import { priceProApi, FX_SOURCES, type BulkPreview, type BulkRequest, type FxSource, type ProList } from "@/modules/prices/proApi";
import { usePriceProMutations } from "@/modules/prices/proHooks";
import { Field, RoundingPicker, fieldCls, friendlyPriceError, fromLocalInput, numOrNull } from "@/components/prices/shared";

type Step = "what" | "how" | "when" | "preview";
type Who = "all" | "category" | "brand" | "supplier" | "tag";

// Asistente de actualización masiva (ADR-058): qué (todos, categoría, marca,
// proveedor o tag; precio base o una lista), cuánto (% o monto, o por índice /
// cotización en PRO, con redondeo), cuándo (ahora o una fecha) y vista previa
// con antes y después. Con aprobación activa, el encargado lo deja pendiente.
export function BulkUpdateWizard({
  open,
  onOpenChange,
  lists,
  pro,
  requireApproval,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lists: ProList[];
  pro: boolean;
  requireApproval: boolean;
}) {
  const { toast } = useToast();
  const m = usePriceProMutations();
  const hasLists = useFeature("listas_precios") !== false;
  const hasPurchases = useFeature("compras") !== false;
  const { data: categories } = useCategories();
  const { data: brands } = useBrands();
  const { data: suppliers } = useSuppliers({}, open && hasPurchases);

  const [step, setStep] = useState<Step>("what");
  const [who, setWho] = useState<Who>("all");
  const [target, setTarget] = useState("");
  const [tag, setTag] = useState("");
  const [listId, setListId] = useState("");
  const [mode, setMode] = useState<"pct" | "amount" | "index">("pct");
  const [value, setValue] = useState("");
  const [rounding, setRounding] = useState<RoundingRule | null>(null);
  const [idxKind, setIdxKind] = useState<"fx" | "index">("fx");
  const [fxSource, setFxSource] = useState<FxSource>("oficial");
  const [idxKey, setIdxKey] = useState("ipc");
  const [idxFrom, setIdxFrom] = useState("");
  const [cap, setCap] = useState("");
  const [when, setWhen] = useState<"now" | "date">("now");
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setStep("what");
      setPreview(null);
    }
  }, [open]);

  function request(): BulkRequest | null {
    const scope: BulkRequest["scope"] = {};
    if (who === "category") scope.category_id = target || null;
    if (who === "brand") scope.brand_id = target || null;
    if (who === "supplier") scope.supplier_id = target || null;
    if (who === "tag") scope.tag = tag.trim() || null;
    if (who !== "all" && who !== "tag" && !target) return null;
    const base = { scope, list_id: listId || null, rounding, reason: reason.trim() || null };
    const eff = when === "date" ? fromLocalInput(date) : null;
    if (mode === "index") {
      if (!idxFrom) return null;
      const capPct = numOrNull(cap);
      return {
        ...base,
        mode: "index",
        effective_at: eff,
        index:
          idxKind === "fx"
            ? { kind: "fx", currency: "USD", source: fxSource, from: idxFrom, cap_pct: capPct }
            : { kind: "index", key: idxKey.trim().toLowerCase(), from: idxFrom, cap_pct: capPct },
      };
    }
    const v = numOrNull(value);
    if (v == null) return null;
    return { ...base, mode, value: v, effective_at: eff };
  }

  async function loadPreview() {
    const r = request();
    if (!r) {
      toast({ title: "Completá qué y cuánto", variant: "error" });
      return;
    }
    setLoading(true);
    try {
      setPreview(await priceProApi.bulkPreview(r));
      setStep("preview");
    } catch (e) {
      toast({ title: friendlyPriceError(e), variant: "error" });
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    const r = request();
    if (!r) return;
    m.bulkCreate.mutate(r, {
      onSuccess: (res) => {
        const msg =
          res.status === "pending_approval"
            ? `Quedó para aprobar (${res.count} precios)`
            : res.status === "scheduled"
              ? `Programado: ${res.count} precios cambian en la fecha elegida`
              : `Listo: ${res.count} precios actualizados`;
        toast({ title: msg, variant: "success" });
        onOpenChange(false);
      },
      onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
    });
  }

  const summary = useMemo(() => (preview ? summarizePreview(preview.rows) : null), [preview]);
  const options =
    who === "category" ? (categories ?? []) : who === "brand" ? (brands ?? []) : who === "supplier" ? (suppliers ?? []) : [];

  const steps: { value: Step; label: string }[] = [
    { value: "what", label: "Qué" },
    { value: "how", label: "Cuánto" },
    { value: "when", label: "Cuándo" },
    { value: "preview", label: "Revisar" },
  ];

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Actualizar precios"
      className="sm:max-w-2xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => setStep(step === "preview" ? "when" : step === "when" ? "how" : "what")}
            disabled={step === "what"}
          >
            Atrás
          </Button>
          {step === "preview" ? (
            <Button onClick={confirm} loading={m.bulkCreate.isPending} disabled={!preview || preview.count === 0}>
              {requireApproval ? "Enviar a aprobar" : when === "date" ? "Programar" : "Aplicar"}
            </Button>
          ) : step === "when" ? (
            <Button onClick={loadPreview} loading={loading}>
              Ver cambios
            </Button>
          ) : (
            <Button onClick={() => setStep(step === "what" ? "how" : "when")}>
              Siguiente <ArrowRight size={15} />
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        <Segmented aria-label="Paso" value={step} options={steps} onChange={setStep} size="sm" fill />

        {step === "what" && (
          <div className="space-y-4">
            <Field label="Productos">
              <select
                className={fieldCls}
                value={who}
                onChange={(e) => {
                  setWho(e.target.value as Who);
                  setTarget("");
                }}
              >
                <option value="all">Todos</option>
                <option value="category">Una categoría</option>
                <option value="brand">Una marca</option>
                {hasPurchases && <option value="supplier">Un proveedor</option>}
                <option value="tag">Con un tag</option>
              </select>
            </Field>
            {who !== "all" && who !== "tag" && (
              <Field label="Cuál">
                <select className={fieldCls} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Elegí</option>
                  {(options as { id: string; name: string }[]).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {who === "tag" && (
              <Field label="Tag">
                <input className={fieldCls} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="importado" />
              </Field>
            )}
            <Field label="Qué precio" hint="El precio de venta o el precio de una lista (se fija por producto).">
              <select className={fieldCls} value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Precio de venta</option>
                {hasLists &&
                  lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      Lista {l.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        )}

        {step === "how" && (
          <div className="space-y-4">
            <Segmented
              aria-label="Cómo"
              value={mode}
              onChange={setMode}
              size="sm"
              options={[
                { value: "pct", label: "Porcentaje" },
                { value: "amount", label: "Monto" },
                ...(pro ? [{ value: "index" as const, label: "Índice o dólar" }] : []),
              ]}
            />
            {mode !== "index" ? (
              <Field
                label={mode === "pct" ? "Porcentaje" : "Monto en pesos"}
                hint={mode === "pct" ? "Negativo para bajar. Ej. 12,5" : "Se suma a cada precio. Negativo para bajar."}
              >
                <input className={fieldCls} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Índice">
                  <select className={fieldCls} value={idxKind} onChange={(e) => setIdxKind(e.target.value as "fx" | "index")}>
                    <option value="fx">Dólar (cotización)</option>
                    <option value="index">IPC u otro índice</option>
                  </select>
                </Field>
                {idxKind === "fx" ? (
                  <Field label="Cotización">
                    <select className={fieldCls} value={fxSource} onChange={(e) => setFxSource(e.target.value as FxSource)}>
                      {FX_SOURCES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <Field label="Clave del índice">
                    <input className={fieldCls} value={idxKey} onChange={(e) => setIdxKey(e.target.value)} />
                  </Field>
                )}
                <Field label="Desde (valor de referencia)" hint="Se compara contra el último valor cargado.">
                  <input type="date" className={fieldCls} value={idxFrom} onChange={(e) => setIdxFrom(e.target.value)} />
                </Field>
                <Field label="Tope %" hint="Opcional: no sube más que esto.">
                  <input className={fieldCls} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
                </Field>
              </div>
            )}
            <Field label="Redondeo">
              <RoundingPicker value={rounding} onChange={setRounding} />
            </Field>
          </div>
        )}

        {step === "when" && (
          <div className="space-y-4">
            <Segmented
              aria-label="Cuándo"
              value={when}
              onChange={setWhen}
              size="sm"
              options={[
                { value: "now", label: "Ahora" },
                { value: "date", label: "En una fecha" },
              ]}
            />
            {when === "date" && (
              <Field label="Fecha y hora" hint="Ese día los precios cambian solos. Hasta entonces se puede deshacer.">
                <input type="datetime-local" className={fieldCls} value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
            )}
            <Field label="Motivo (opcional)">
              <input className={fieldCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lista nueva del proveedor" />
            </Field>
            {requireApproval && (
              <Callout tone="info">El dueño tiene que aprobar este cambio antes de que se aplique.</Callout>
            )}
          </div>
        )}

        {step === "preview" && preview && summary && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Precios" value={String(preview.count)} />
              <Stat label="Variación" value={`${summary.avgPct > 0 ? "+" : ""}${summary.avgPct}%`} />
              <Stat label="Suben / bajan" value={`${summary.up} / ${summary.down}`} />
              <Stat label="Bajo costo" value={String(preview.below_cost)} tone={preview.below_cost > 0 ? "warn" : undefined} />
            </div>
            {preview.pct != null && (
              <p className="text-xs text-muted-foreground">Índice aplicado: {preview.pct}%.</p>
            )}
            {preview.below_cost > 0 && (
              <Callout tone="warning" icon={AlertTriangle}>
                {preview.below_cost} precios quedan por debajo del costo.
              </Callout>
            )}
            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Producto</th>
                    <th className="px-3 py-2 text-right font-medium">Antes</th>
                    <th className="px-3 py-2 text-right font-medium">Después</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.rows.map((r) => (
                    <tr key={`${r.product_id}-${r.variant_id ?? ""}`}>
                      <td className="px-3 py-1.5">{r.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatCurrency(r.old_price)}</td>
                      <td
                        className={
                          "px-3 py-1.5 text-right font-medium tabular-nums " +
                          (r.cost != null && r.cost > 0 && r.new_price < r.cost ? "text-warning" : "")
                        }
                      >
                        {formatCurrency(r.new_price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.count > preview.rows.length && (
              <p className="text-xs text-muted-foreground">
                Se muestran {preview.rows.length} de {preview.count}. Se aplican todos.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-md bg-muted/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={"text-base font-semibold tabular-nums " + (tone === "warn" ? "text-warning" : "")}>{value}</div>
    </div>
  );
}
