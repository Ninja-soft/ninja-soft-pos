"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { Callout } from "@/components/ui/Callout";
import { useToast } from "@/components/ui/Toast";
import { useFeature } from "@/modules/saas/gating";
import { useCustomerGroups } from "@/modules/customers/hooks";
import { useStores } from "@/modules/stock/hooks";
import { useProducts } from "@/modules/products/hooks";
import { PRICE_CHANNELS, type PriceChannel } from "@/modules/prices/api";
import {
  COST_BASES,
  FX_SOURCES,
  LIST_KINDS,
  type Assignment,
  type FxSource,
  type ProList,
  type ProListInput,
} from "@/modules/prices/proApi";
import { useListBreaks, usePriceAssignments, usePriceProMutations } from "@/modules/prices/proHooks";
import { describeRounding, type RoundingRule } from "@/lib/prices/rounding";
import { marginToMarkup, markupToMargin, type ListCostBasis, type ListKind, type MarkupMode } from "@/lib/prices/resolve";
import {
  Field,
  RoundingPicker,
  fieldCls,
  friendlyPriceError,
  fromLocalInput,
  numOrNull,
  toLocalInput,
} from "@/components/prices/shared";

// Alta y edición de una lista (ADR-058). Modo simple: nombre, canal y %. Modo
// profesional: tipo, madre, costo y markup o margen, moneda, redondeo, margen
// mínimo, vigencia, elegible en el POS, escalas y asignaciones.
export function PriceListFormModal({
  open,
  onOpenChange,
  list,
  lists,
  pro,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  list: ProList | null;
  lists: ProList[];
  pro: boolean;
}) {
  const { toast } = useToast();
  const m = usePriceProMutations();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState<PriceChannel>("custom");
  const [pct, setPct] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<ListKind>("fixed");
  const [baseList, setBaseList] = useState<string>("");
  const [costBasis, setCostBasis] = useState<ListCostBasis>("replacement");
  const [markupMode, setMarkupMode] = useState<MarkupMode>("markup");
  const [markup, setMarkup] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [fxSource, setFxSource] = useState<FxSource>("oficial");
  const [rounding, setRounding] = useState<RoundingRule | null>(null);
  const [minMargin, setMinMargin] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [posSelectable, setPosSelectable] = useState(false);
  // ADR-068: precios con IVA (final) o netos (el resolver suma el IVA).
  const [includesTax, setIncludesTax] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(list?.name ?? "");
    setChannel((list?.channel as PriceChannel) ?? "custom");
    setPct(list?.adjustment_pct == null ? "" : String(list.adjustment_pct));
    setAmount(list?.adjustment_amount == null ? "" : String(list.adjustment_amount));
    setKind(list?.kind ?? "fixed");
    setBaseList(list?.base_list_id ?? "");
    setCostBasis(list?.cost_basis ?? "replacement");
    setMarkupMode(list?.markup_mode ?? "markup");
    setMarkup(list?.markup_value == null ? "" : String(list.markup_value));
    setCurrency(list?.currency ?? "USD");
    setFxSource((list?.fx_source as FxSource) ?? "oficial");
    setRounding(list?.rounding ?? null);
    setMinMargin(list?.min_margin_pct == null ? "" : String(list.min_margin_pct));
    setFrom(toLocalInput(list?.valid_from));
    setTo(toLocalInput(list?.valid_to));
    setPosSelectable(Boolean(list?.pos_selectable));
    setIncludesTax(list?.prices_include_tax !== false);
  }, [open, list]);

  const taken = new Set(lists.filter((l) => l.channel !== "custom" && l.id !== list?.id).map((l) => l.channel));
  const markupNum = numOrNull(markup);
  const companion =
    markupNum == null
      ? null
      : markupMode === "markup"
        ? `Equivale a un margen de ${markupToMargin(markupNum)}%`
        : markupNum < 100
          ? `Equivale a un markup de ${marginToMarkup(markupNum)}%`
          : "El margen tiene que ser menor a 100%";

  function build(): ProListInput | null {
    if (!name.trim()) {
      toast({ title: "Poné un nombre", variant: "error" });
      return null;
    }
    const k = pro ? kind : "fixed";
    if (k === "derived" && !baseList) {
      toast({ title: "Elegí la lista madre", variant: "error" });
      return null;
    }
    if (k === "cost" && markupNum == null) {
      toast({ title: "Cargá el markup o el margen", variant: "error" });
      return null;
    }
    return {
      name: name.trim(),
      channel,
      adjustment_pct: numOrNull(pct),
      adjustment_amount: pro ? numOrNull(amount) : (list?.adjustment_amount ?? null),
      kind: k,
      base_list_id: k === "derived" ? baseList : null,
      cost_basis: k === "cost" ? costBasis : null,
      markup_mode: k === "cost" ? markupMode : null,
      markup_value: k === "cost" ? markupNum : null,
      currency: k === "currency" ? currency.trim().toUpperCase() : null,
      fx_source: k === "currency" ? fxSource : null,
      rounding: pro ? rounding : (list?.rounding ?? null),
      min_margin_pct: pro ? numOrNull(minMargin) : (list?.min_margin_pct ?? null),
      valid_from: fromLocalInput(from),
      valid_to: fromLocalInput(to),
      pos_selectable: posSelectable,
      prices_include_tax: includesTax,
    };
  }

  function save() {
    const input = build();
    if (!input) return;
    const done = {
      onSuccess: () => {
        toast({ title: list ? "Lista guardada" : "Lista creada", variant: "success" });
        onOpenChange(false);
      },
      onError: (e: unknown) => toast({ title: friendlyPriceError(e), variant: "error" }),
    };
    if (list) m.updateList.mutate({ id: list.id, patch: input }, done);
    else m.createList.mutate(input, done);
  }

  const parents = lists.filter((l) => l.id !== list?.id);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={list ? `Editar ${list.name}` : "Nueva lista de precios"}
      className="sm:max-w-2xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} loading={m.createList.isPending || m.updateList.isPending}>
            Guardar
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Nombre" className="sm:col-span-2">
            <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Mayorista" />
          </Field>
          <Field label="Canal">
            <select className={fieldCls} value={channel} onChange={(e) => setChannel(e.target.value as PriceChannel)}>
              {PRICE_CHANNELS.map((c) => (
                <option key={c.value} value={c.value} disabled={taken.has(c.value)}>
                  {c.label}
                  {taken.has(c.value) ? " (ya existe)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {pro && (
          <Field label="Tipo de lista" hint={LIST_KINDS.find((k) => k.value === kind)?.hint}>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {LIST_KINDS.map((k) => (
                <button
                  key={k.value}
                  type="button"
                  onClick={() => setKind(k.value)}
                  className={
                    "h-10 rounded-md px-2 text-sm font-medium transition " +
                    (kind === k.value ? "bg-foreground text-background" : "bg-muted text-foreground hover:bg-muted/70")
                  }
                >
                  {k.label}
                </button>
              ))}
            </div>
          </Field>
        )}

        {pro && kind === "derived" && (
          <Field label="Sale de la lista">
            <select className={fieldCls} value={baseList} onChange={(e) => setBaseList(e.target.value)}>
              <option value="">Elegí una lista</option>
              {parents.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {pro && kind === "cost" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Costo">
              <select className={fieldCls} value={costBasis} onChange={(e) => setCostBasis(e.target.value as ListCostBasis)}>
                {COST_BASES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cálculo">
              <select className={fieldCls} value={markupMode} onChange={(e) => setMarkupMode(e.target.value as MarkupMode)}>
                <option value="markup">Markup sobre costo</option>
                <option value="margin">Margen sobre precio</option>
              </select>
            </Field>
            <Field label={markupMode === "markup" ? "Markup %" : "Margen %"} hint={companion}>
              <input className={fieldCls} inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} placeholder="60" />
            </Field>
          </div>
        )}

        {pro && kind === "currency" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Moneda" hint="Los precios puntuales de esta lista se cargan en esta moneda.">
              <input className={fieldCls} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </Field>
            <Field label="Cotización" hint="Se usa la última cargada hasta el día de la venta.">
              <select className={fieldCls} value={fxSource} onChange={(e) => setFxSource(e.target.value as FxSource)}>
                {FX_SOURCES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={kind === "derived" ? "Ajuste % sobre la madre" : "Ajuste % sobre el precio de venta"}
            hint="Negativo para descuento. Vacío: sin ajuste."
          >
            <input className={fieldCls} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="-10" />
          </Field>
          {pro && (
            <Field label="Monto fijo a sumar" hint="Se suma después del %. Puede ser negativo.">
              <input className={fieldCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
            </Field>
          )}
        </div>

        {pro && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Redondeo" hint={`Sólo sobre precios calculados. ${describeRounding(rounding)}.`}>
              <RoundingPicker value={rounding} onChange={setRounding} />
            </Field>
            <Field label="Margen mínimo %" hint="Piso: el precio nunca queda por debajo del costo con este margen.">
              <input className={fieldCls} inputMode="decimal" value={minMargin} onChange={(e) => setMinMargin(e.target.value)} placeholder="20" />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vigente desde" hint="Vacío: desde ya.">
            <input type="datetime-local" className={fieldCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Vigente hasta" hint="Al vencer, se vuelve a la lista que sigue (cliente, sucursal o mostrador).">
            <input type="datetime-local" className={fieldCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5">
          <span className="text-sm">
            Elegible en el POS
            <span className="block text-xs text-muted-foreground">El cajero puede cobrar con esta lista desde el carrito.</span>
          </span>
          <Switch checked={posSelectable} onCheckedChange={setPosSelectable} label="Elegible en el POS" />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2.5">
          <span className="text-sm">
            Precios con IVA incluido
            <span className="block text-xs text-muted-foreground">
              Apagado: los precios de la lista son netos y al vender se suma el IVA de cada producto (mayoristas, factura A).
            </span>
          </span>
          <Switch checked={includesTax} onCheckedChange={setIncludesTax} label="Precios con IVA incluido" />
        </div>

        {list && <AssignmentsEditor listId={list.id} />}
        {list && pro && <BreaksEditor listId={list.id} />}
      </div>
    </Modal>
  );
}

function AssignmentsEditor({ listId }: { listId: string }) {
  const { toast } = useToast();
  const { data: groups } = useCustomerGroups();
  const { data: stores } = useStores();
  const { data: assignments } = usePriceAssignments();
  const multi = useFeature("multi_sucursal");
  const m = usePriceProMutations();
  const byTarget = useMemo(() => {
    const map = new Map<string, Assignment>();
    for (const a of assignments ?? []) map.set(`${a.scope}:${a.scope_id}`, a);
    return map;
  }, [assignments]);

  function toggle(scope: Assignment["scope"], id: string, on: boolean) {
    m.setAssignment.mutate(
      { scope, scopeId: id, listId: on ? listId : null },
      { onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }) },
    );
  }

  const rows: { scope: Assignment["scope"]; id: string; name: string }[] = [
    ...(groups ?? []).map((g: { id: string; name: string }) => ({ scope: "customer_group" as const, id: g.id, name: `Grupo ${g.name}` })),
    ...(multi !== false && (stores?.length ?? 0) > 1
      ? (stores ?? []).map((s: { id: string; name: string }) => ({ scope: "store" as const, id: s.id, name: `Sucursal ${s.name}` }))
      : []),
  ];
  if (rows.length === 0) return null;

  return (
    <section>
      <h3 className="text-sm font-semibold">Dónde se usa</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Orden: lista elegida en el POS, cliente, grupo de clientes, sucursal, mostrador. Un destino usa una sola lista.
      </p>
      <div className="divide-y divide-border rounded-md border border-border">
        {rows.map((r) => {
          const a = byTarget.get(`${r.scope}:${r.id}`);
          const mine = a?.price_list_id === listId;
          return (
            <div key={`${r.scope}:${r.id}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {r.name}
                {a && !mine && <span className="ml-2 text-xs text-muted-foreground">(usa otra lista)</span>}
              </span>
              <Switch checked={mine} onCheckedChange={(v) => toggle(r.scope, r.id, v)} label={r.name} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BreaksEditor({ listId }: { listId: string }) {
  const { toast } = useToast();
  const { data: breaks } = useListBreaks(listId);
  const m = usePriceProMutations();
  const [search, setSearch] = useState("");
  const { data: products } = useProducts(search);
  const [productId, setProductId] = useState("");
  const [minQty, setMinQty] = useState("");
  const [kind, setKind] = useState<"pct" | "price">("pct");
  const [value, setValue] = useState("");
  const names = new Map((products ?? []).map((p) => [p.id, p.name]));

  function add() {
    const q = numOrNull(minQty);
    const v = numOrNull(value);
    if (q == null || q <= 0 || v == null) {
      toast({ title: "Cargá desde cuántas unidades y el valor", variant: "error" });
      return;
    }
    m.addBreak.mutate(
      { price_list_id: listId, product_id: productId || null, variant_id: null, min_qty: q, kind, value: v },
      {
        onSuccess: () => {
          setMinQty("");
          setValue("");
        },
        onError: (e) => toast({ title: friendlyPriceError(e), variant: "error" }),
      },
    );
  }

  return (
    <section>
      <h3 className="text-sm font-semibold">Escalas por cantidad</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Desde N unidades, un precio fijo o un % sobre el precio de la lista. La del producto gana a la de toda la lista.
      </p>
      {(breaks ?? []).length > 0 && (
        <div className="mb-2 divide-y divide-border rounded-md border border-border">
          {(breaks ?? []).map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {b.product_id ? (names.get(b.product_id) ?? "Producto") : "Toda la lista"} · desde {b.min_qty}:{" "}
                {b.kind === "price" ? `$${b.value}` : `${b.value > 0 ? "+" : ""}${b.value}%`}
              </span>
              <button
                type="button"
                aria-label="Quitar escala"
                onClick={() => m.removeBreak.mutate(b.id)}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[1.5fr_0.7fr_0.8fr_0.8fr_auto]">
        <div className="space-y-1">
          <input className={fieldCls} placeholder="Buscar producto (vacío: toda la lista)" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <select className={fieldCls} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Toda la lista</option>
              {(products ?? []).slice(0, 30).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <input className={fieldCls} inputMode="decimal" placeholder="Desde" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
        <select className={fieldCls} value={kind} onChange={(e) => setKind(e.target.value as "pct" | "price")}>
          <option value="pct">% sobre lista</option>
          <option value="price">Precio fijo</option>
        </select>
        <input className={fieldCls} inputMode="decimal" placeholder={kind === "pct" ? "-10" : "900"} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button variant="secondary" onClick={add} loading={m.addBreak.isPending} aria-label="Agregar escala">
          <Plus size={15} />
        </Button>
      </div>
      {(breaks ?? []).length === 0 && (
        <Callout tone="neutral" className="mt-2">
          Sin escalas: el precio no cambia con la cantidad.
        </Callout>
      )}
    </section>
  );
}
