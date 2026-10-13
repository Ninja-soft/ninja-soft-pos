"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Minus,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import {
  localDate,
  submitTarget,
  transferErrorMessage,
} from "@/lib/stock/transfers";
import { stockKey } from "@/lib/stock/suggest";
import { ProductSearchCombobox } from "@/components/products/ProductSearchCombobox";
import {
  variantLabel,
  type Product,
  type ProductVariant,
} from "@/modules/products/api";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useStockByStore,
  useTransferMutations,
  useTransferSettings,
} from "@/modules/stock/hooks";
import type { StoreRef } from "@/lib/stock/byStore";
import type { TransferDetail } from "@/modules/stock/api";
import { selectCls, storeName } from "./shared";

export interface WizardLine {
  key: string;
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_label: string | null;
  sku: string | null;
  unit: string;
  cost: number;
  qty: number;
}

type Step = "ruta" | "productos" | "revisar";

// Se trasladan productos con stock controlado y que no son kits.
const transferable = (p: Product) => p.track_stock !== false && !p.is_kit;
type When = "now" | "date";

export interface WizardInitial {
  id?: string | null;
  origin_store_id?: string;
  dest_store_id?: string;
  scheduled_for?: string | null;
  notes?: string | null;
  carrier?: string | null;
  lines?: WizardLine[];
}

export function linesFromDetail(t: TransferDetail): WizardLine[] {
  return t.items.map((i) => ({
    key: stockKey(i.product_id, i.variant_id),
    product_id: i.product_id,
    variant_id: i.variant_id,
    name: i.product_name,
    variant_label: i.variant_label,
    sku: i.sku,
    unit: i.unit,
    cost: Number(i.unit_cost ?? 0),
    qty: Number(i.qty_requested),
  }));
}

// Alta y edición de traslados (borrador): ruta y fecha, productos con
// búsqueda, lector de códigos y cantidad, y revisión con disponible en origen.
export function TransferWizardModal({
  open,
  onOpenChange,
  stores,
  currentStoreId,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: StoreRef[];
  currentStoreId: string | null;
  initial?: WizardInitial | null;
  onSaved?: (id: string) => void;
}) {
  const { toast } = useToast();
  const m = useTransferMutations();
  const { data: me } = useMyTenant();
  const { data: settings } = useTransferSettings(open);
  const [step, setStep] = useState<Step>("ruta");
  const [origin, setOrigin] = useState("");
  const [dest, setDest] = useState("");
  const [when, setWhen] = useState<When>("now");
  const [date, setDate] = useState(localDate());
  const [carrier, setCarrier] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<WizardLine[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const o = initial?.origin_store_id ?? currentStoreId ?? stores[0]?.id ?? "";
    setOrigin(o);
    setDest(initial?.dest_store_id ?? stores.find((s) => s.id !== o)?.id ?? "");
    const today = localDate();
    const sched = initial?.scheduled_for?.slice(0, 10) ?? null;
    setWhen(sched && sched > today ? "date" : "now");
    setDate(sched && sched > today ? sched : today);
    setCarrier(initial?.carrier ?? "");
    setNotes(initial?.notes ?? "");
    setLines(initial?.lines ?? []);
    setStep(initial?.lines?.length ? "productos" : "ruta");
  }, [open, initial, currentStoreId, stores]);

  const { data: originRows } = useStockByStore(
    lines.map((l) => l.product_id),
    open && lines.length > 0,
  );
  const available = (l: WizardLine) =>
    Number(
      (originRows ?? []).find(
        (r) =>
          r.store_id === origin &&
          r.product_id === l.product_id &&
          (r.variant_id ?? null) === l.variant_id,
      )?.qty ?? 0,
    );

  function addLine(p: Product, v?: ProductVariant | null, qty = 1) {
    const key = stockKey(p.id, v?.id ?? null);
    setLines((prev) => {
      const i = prev.findIndex((l) => l.key === key);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i]!, qty: next[i]!.qty + qty };
        return next;
      }
      return [
        ...prev,
        {
          key,
          product_id: p.id,
          variant_id: v?.id ?? null,
          name: p.name,
          variant_label: v ? variantLabel(v) : null,
          sku: v?.sku ?? p.sku,
          unit: p.unit,
          cost: Number(p.cost ?? 0),
          qty,
        },
      ];
    });
  }

  const units = lines.reduce((t, l) => t + l.qty, 0);
  const value = lines.reduce((t, l) => t + l.qty * l.cost, 0);
  const role = (me?.role ?? "viewer") as
    | "owner"
    | "manager"
    | "cashier"
    | "viewer";
  const willNeedApproval = settings
    ? submitTarget(settings, units, value, role) === "pending_approval"
    : false;
  const short = lines.filter((l) => l.qty > available(l));
  const routeOk =
    origin && dest && origin !== dest && (when === "now" || Boolean(date));

  async function save(action: "draft" | "submit" | "dispatch") {
    if (!routeOk || lines.length === 0) return;
    setBusy(true);
    try {
      const id = await m.save.mutateAsync({
        id: initial?.id ?? null,
        origin_store_id: origin,
        dest_store_id: dest,
        scheduled_for: when === "now" ? localDate() : date,
        notes: notes.trim() || null,
        carrier: carrier.trim() || null,
        items: lines.map((l) => ({
          product_id: l.product_id,
          variant_id: l.variant_id,
          qty: l.qty,
        })),
      });
      let msg = "Borrador guardado";
      if (action !== "draft") {
        const st = await m.submit.mutateAsync(id);
        msg =
          st === "pending_approval"
            ? "Enviado a aprobación"
            : "Traslado programado";
        if (action === "dispatch" && st === "scheduled") {
          await m.dispatch.mutateAsync({ id });
          msg = "Traslado despachado: ya está en camino";
        }
      }
      toast({ title: msg, variant: "success" });
      onSaved?.(id);
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "No se pudo guardar",
        description: transferErrorMessage(e),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const steps: { value: Step; label: string }[] = [
    { value: "ruta", label: "1. Ruta" },
    { value: "productos", label: "2. Productos" },
    { value: "revisar", label: "3. Revisar" },
  ];

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        {lines.length} {lines.length === 1 ? "producto" : "productos"} ·{" "}
        {formatQty(units)} unidades
      </span>
      <div className="flex flex-wrap justify-end gap-2">
        {step !== "ruta" && (
          <Button
            variant="secondary"
            onClick={() => setStep(step === "revisar" ? "productos" : "ruta")}
          >
            Atrás
          </Button>
        )}
        {step === "ruta" && (
          <Button onClick={() => setStep("productos")} disabled={!routeOk}>
            Siguiente
          </Button>
        )}
        {step === "productos" && (
          <Button
            onClick={() => setStep("revisar")}
            disabled={lines.length === 0}
          >
            Revisar
          </Button>
        )}
        {step === "revisar" && (
          <>
            <Button
              variant="secondary"
              onClick={() => save("draft")}
              loading={busy}
            >
              Guardar borrador
            </Button>
            {when === "now" && !willNeedApproval ? (
              <Button onClick={() => save("dispatch")} loading={busy}>
                Confirmar y despachar
              </Button>
            ) : (
              <Button onClick={() => save("submit")} loading={busy}>
                {willNeedApproval ? "Enviar a aprobación" : "Confirmar"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={initial?.id ? "Editar traslado" : "Nuevo traslado"}
      description={
        origin && dest
          ? `${storeName(stores, origin)} → ${storeName(stores, dest)}`
          : undefined
      }
      footer={footer}
      className="sm:max-w-2xl"
    >
      <div className="space-y-4">
        <Segmented<Step>
          aria-label="Paso"
          value={step}
          onChange={(v) => {
            if (v === "ruta" || routeOk)
              setStep(v === "revisar" && lines.length === 0 ? "productos" : v);
          }}
          options={steps}
          fill
          size="sm"
        />

        {step === "ruta" && (
          <div className="space-y-4">
            <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
              <div>
                <label className="mb-2 block text-sm font-medium text-muted-foreground">
                  Sale de
                </label>
                <select
                  className={selectCls}
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                >
                  {stores.map((s) => (
                    <option
                      key={s.id}
                      value={s.id}
                      className="bg-popover text-popover-foreground"
                    >
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <ArrowRight
                className="mx-auto mb-3 hidden text-muted-foreground sm:block"
                size={18}
              />
              <div>
                <label className="mb-2 block text-sm font-medium text-muted-foreground">
                  Llega a
                </label>
                <select
                  className={selectCls}
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                >
                  {stores.map((s) => (
                    <option
                      key={s.id}
                      value={s.id}
                      disabled={s.id === origin}
                      className="bg-popover text-popover-foreground"
                    >
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {origin === dest && origin && (
              <p className="text-xs text-danger">
                El origen y el destino tienen que ser distintos.
              </p>
            )}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-muted-foreground">
                ¿Cuándo sale?
              </label>
              <Segmented<When>
                aria-label="Cuándo sale"
                value={when}
                onChange={setWhen}
                size="sm"
                options={[
                  { value: "now", label: "Ahora" },
                  { value: "date", label: "Programar fecha" },
                ]}
              />
              {when === "date" && (
                <Input
                  type="date"
                  min={localDate()}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  hint="Ese día aparece como “Para despachar hoy” en la sucursal de origen."
                />
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Transportista (opcional)"
                placeholder="Moto propia, flete, comisionista"
                maxLength={120}
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
              />
              <Input
                label="Notas (opcional)"
                placeholder="Reposición fin de semana"
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}

        {step === "productos" && (
          <div className="space-y-3">
            <ProductSearchCombobox
              autoFocus
              enabled={open && step === "productos"}
              storeId={origin || null}
              filter={transferable}
              rejectMessage={(p) =>
                `${p.name} no se traslada (kit o sin control de stock)`
              }
              emptyHint="Los kits y productos sin stock controlado no se trasladan."
              placeholder="Buscá por nombre, SKU, EAN o PLU"
              onPick={(p, v) => addLine(p, v)}
            />

            {lines.length === 0 ? (
              <p className="rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">
                Buscá productos o escanealos con el lector para sumarlos al
                traslado.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl bg-muted">
                {lines.map((l) => {
                  const av = available(l);
                  return (
                    <li
                      key={l.key}
                      className="flex items-center gap-3 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {l.name}
                          {l.variant_label && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {l.variant_label}
                            </span>
                          )}
                        </div>
                        <div
                          className={cn(
                            "text-xs",
                            l.qty > av
                              ? "text-warning"
                              : "text-muted-foreground",
                          )}
                        >
                          En {storeName(stores, origin)}: {formatQty(av)}{" "}
                          {l.unit}
                        </div>
                      </div>
                      <QtyStepper
                        value={l.qty}
                        onChange={(q) =>
                          setLines((prev) =>
                            prev.map((x) =>
                              x.key === l.key ? { ...x, qty: q } : x,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setLines((prev) =>
                            prev.filter((x) => x.key !== l.key),
                          )
                        }
                        className="rounded-md p-2 text-muted-foreground transition hover:text-danger"
                        aria-label={`Quitar ${l.name}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {step === "revisar" && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Ruta</dt>
                <dd className="font-medium">
                  {storeName(stores, origin)} → {storeName(stores, dest)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Sale</dt>
                <dd className="font-medium">
                  {when === "now"
                    ? "Ahora"
                    : date.split("-").reverse().join("/")}
                </dd>
              </div>
              {carrier && (
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Transportista
                  </dt>
                  <dd>{carrier}</dd>
                </div>
              )}
              {notes && (
                <div>
                  <dt className="text-xs text-muted-foreground">Notas</dt>
                  <dd>{notes}</dd>
                </div>
              )}
            </dl>
            <ul className="divide-y divide-border rounded-xl ring-1 ring-border">
              {lines.map((l) => (
                <li
                  key={l.key}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {l.name}
                    {l.variant_label && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {l.variant_label}
                      </span>
                    )}
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatQty(l.qty)} {l.unit}
                  </span>
                </li>
              ))}
            </ul>
            {short.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs text-warning">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                {short.length === 1
                  ? "Un producto supera"
                  : `${short.length} productos superan`}{" "}
                el stock de {storeName(stores, origin)}. Al despachar vas a
                poder mandar menos.
              </p>
            )}
            {willNeedApproval && (
              <p className="rounded-xl bg-info/10 p-3 text-xs text-info">
                Por la configuración del negocio este traslado necesita
                aprobación del dueño o de otro encargado.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function QtyStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center rounded-lg bg-background ring-1 ring-border">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="p-2 text-muted-foreground transition hover:text-foreground"
        aria-label="Menos"
      >
        <Minus size={14} />
      </button>
      <input
        type="number"
        min={0.001}
        step="any"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n > 0) onChange(n);
        }}
        className="w-16 bg-transparent text-center font-mono text-sm tabular-nums outline-none"
        aria-label="Cantidad"
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="p-2 text-muted-foreground transition hover:text-foreground"
        aria-label="Más"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
