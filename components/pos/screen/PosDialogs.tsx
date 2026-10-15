"use client";

import { useState } from "react";
import { ExternalLink, ScanBarcode, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { money } from "../ui/posStyles";
import { Keypad, applyKey } from "../ui/Keypad";
import { openPriceError, openPriceErrorText, openPriceRangeText, parseTypedPrice } from "@/lib/prices/openPrice";

// Diálogos chicos del POS (cliente, venta libre, peso y N° de serie). Misma
// lógica que antes; sólo cambia la piel (filas con relleno, sin bordes).

const row =
  "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-fg-6";

/** Ficha completa del cliente (ADR-067), con compras, deuda y vales. */
export function customerProfileHref(customerId: string): string {
  return `/clientes/${encodeURIComponent(customerId)}`;
}

export function CustomerPickerDialog({
  open,
  onOpenChange,
  search,
  onSearch,
  customers,
  current,
  onPick,
  onScanDni,
  onNewCustomer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  search: string;
  onSearch: (v: string) => void;
  customers:
    | { id: string; name: string; document_number?: string | null; phone?: string | null }[]
    | undefined;
  current: { id: string; name: string } | null;
  onPick: (c: { id: string; name: string } | null) => void;
  onScanDni: () => void;
  /** Alta rápida con verificación en ARCA (ADR-133). */
  onNewCustomer?: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Cliente de la venta">
      <div className="space-y-3">
        <Input
          placeholder="Buscar por nombre, documento o teléfono"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          autoFocus
        />
        {/* Historial del cliente desde el POS (F11 · H31): la ficha completa
            se abre en otra pestaña para no perder el carrito. */}
        {current && (
          <a
            href={customerProfileHref(current.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center justify-between gap-2 rounded-lg bg-fg-6 px-3 text-sm font-medium transition-colors hover:bg-fg-10"
          >
            <span className="min-w-0 truncate">Ver ficha e historial de {current.name}</span>
            <ExternalLink size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          </a>
        )}
        {/* Alta rápida: con CUIT verificado en ARCA (ADR-133) o por DNI (H31). */}
        <div className="grid gap-2 sm:grid-cols-2">
          {onNewCustomer && (
            <Button type="button" variant="secondary" className="w-full" onClick={onNewCustomer}>
              <UserPlus size={16} /> Nuevo cliente
            </Button>
          )}
          <Button type="button" variant="secondary" className={cn("w-full", !onNewCustomer && "sm:col-span-2")} onClick={onScanDni}>
            <ScanBarcode size={16} /> Escanear DNI
          </Button>
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          <button type="button" onClick={() => onPick(null)} className={cn(row, !current && "choice-on")}>
            <span>Consumidor final</span>
            {!current && <span className="text-xs font-bold text-success">Actual</span>}
          </button>
          <p className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {search.trim() ? "Resultados" : "Recientes"}
          </p>
          {customers === undefined && <SpinnerBlock className="py-6" label="Buscando clientes" />}
          {customers?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick({ id: c.id, name: c.name })}
              className={cn(row, current?.id === c.id && "choice-on")}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{c.name}</span>
                {(c.document_number || c.phone) && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.document_number ?? c.phone}
                  </span>
                )}
              </span>
              {current?.id === c.id && <span className="shrink-0 text-xs font-bold text-success">Actual</span>}
            </button>
          ))}
          {customers?.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {search.trim()
                ? "Sin resultados. Probá con otro nombre, documento o teléfono."
                : "Sin clientes recientes. Buscá por nombre, documento o teléfono o cargalos en Clientes."}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function FreeSaleDialog({
  open,
  onOpenChange,
  amount,
  onAmount,
  name,
  onName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  amount: string;
  onAmount: (v: string) => void;
  name: string;
  onName: (v: string) => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Venta libre">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Cobra un monto manual con un concepto. No descuenta stock (ítem sin SKU). Útil para
          servicios sueltos, cargos o ítems fuera del catálogo.
        </p>
        <Input
          label="Monto"
          type="number"
          inputMode="decimal"
          step="0.01"
          autoFocus
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          placeholder="0"
          onKeyDown={(e) => e.key === "Enter" && onConfirm()}
        />
        <Input
          label="Concepto o motivo (opcional)"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Venta libre"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onConfirm}>Agregar al carrito</Button>
        </div>
      </div>
    </Modal>
  );
}

export function WeighDialog({
  product,
  grams,
  onGrams,
  onClose,
  onConfirm,
  scaleSlot,
}: {
  product: { name: string; price: number } | null;
  grams: string;
  onGrams: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  // Peso en vivo de la balanza de la caja (ADR-063). Sin balanza, nada.
  scaleSlot?: React.ReactNode;
}) {
  const g = Number(grams);
  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && onClose()}
      title={product ? `Peso de ${product.name}` : "Peso"}
    >
      <div className="space-y-4">
        {scaleSlot}
        <Input
          label="Peso en gramos"
          type="number"
          inputMode="decimal"
          step="1"
          autoFocus
          value={grams}
          onChange={(e) => onGrams(e.target.value)}
          placeholder="Ej. 350"
          onKeyDown={(e) => e.key === "Enter" && onConfirm()}
        />
        <div className="flex flex-wrap gap-1.5">
          {[100, 250, 500, 1000].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onGrams(String(q))}
              className="h-10 rounded-md bg-fg-6 px-3.5 text-[13px] font-semibold tabular-nums transition-colors hover:bg-fg-10"
            >
              {q >= 1000 ? `${q / 1000} kg` : `${q} g`}
            </button>
          ))}
        </div>
        {product && g > 0 && (
          <p className="text-sm text-muted-foreground">
            {formatQty(g / 1000)} kg × {money(product.price)}/kg ={" "}
            <span className="font-semibold text-foreground">{money((g / 1000) * product.price)}</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={onConfirm}>Agregar al carrito</Button>
        </div>
      </div>
    </Modal>
  );
}

export function SerialDialog({
  product,
  serials,
  choice,
  onChoice,
  other,
  onOther,
  onClose,
  onConfirm,
}: {
  product: { name: string } | null;
  serials: { id: string; serial: string; status: string }[] | undefined;
  choice: string;
  onChoice: (v: string) => void;
  other: string;
  onOther: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const inStock = (serials ?? []).filter((s) => s.status === "in_stock");
  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && onClose()}
      title={product ? `N° de serie de ${product.name}` : "N° de serie"}
    >
      <div className="space-y-4">
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {inStock.map((s) => (
            <label key={s.id} className={cn(row, "cursor-pointer justify-start", choice === s.serial && "choice-on")}>
              <input
                type="radio"
                name="serial"
                className="accent-ninja-flame"
                checked={choice === s.serial}
                onChange={() => onChoice(s.serial)}
              />
              <span className="font-mono">{s.serial}</span>
            </label>
          ))}
          {inStock.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin seriales precargados. Ingresá uno abajo.</p>
          )}
          <label className={cn(row, "cursor-pointer justify-start", choice === "__other__" && "choice-on")}>
            <input
              type="radio"
              name="serial"
              className="accent-ninja-flame"
              checked={choice === "__other__"}
              onChange={() => onChoice("__other__")}
            />
            Otro (ingresar o escanear)
          </label>
        </div>
        {choice === "__other__" && (
          <Input
            label="N° de serie"
            autoFocus
            value={other}
            onChange={(e) => onOther(e.target.value)}
            placeholder="IMEI o S/N"
            onKeyDown={(e) => e.key === "Enter" && onConfirm()}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={onConfirm}>Agregar al carrito</Button>
        </div>
      </div>
    </Modal>
  );
}

// Cambio manual de precio de una línea (F18 · H100, ADR-056). El servidor
// recalcula el precio de lista: el cambio viaja marcado con su motivo y, según
// la política de Seguridad, pide el PIN de un supervisor al cobrar.
export interface PriceOverrideTarget {
  lineId: string;
  name: string;
  unitPrice: number;
  listPrice: number;
  reason: string;
}

export function PriceOverrideDialog({
  line,
  onClose,
  onConfirm,
}: {
  line: PriceOverrideTarget | null;
  onClose: () => void;
  onConfirm: (price: number, reason: string) => void;
}) {
  return (
    <Modal open={line !== null} onOpenChange={(o) => !o && onClose()} title="Cambiar precio">
      {line && <PriceOverrideForm key={line.lineId} line={line} onClose={onClose} onConfirm={onConfirm} />}
    </Modal>
  );
}

function PriceOverrideForm({
  line,
  onClose,
  onConfirm,
}: {
  line: PriceOverrideTarget;
  onClose: () => void;
  onConfirm: (price: number, reason: string) => void;
}) {
  const [price, setPrice] = useState(String(line.unitPrice));
  const [reason, setReason] = useState(line.reason);
  const p = Number(price);
  const valid = price.trim() !== "" && Number.isFinite(p) && p >= 0;
  const backToList = valid && Math.abs(p - line.listPrice) <= 0.01;
  const reasonOk = backToList || reason.trim().length >= 3;
  const submit = () => {
    if (valid && reasonOk) onConfirm(Math.round(p * 100) / 100, reason);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{line.name}</span>. Precio de lista{" "}
        <span className="tabular-nums">{money(line.listPrice)}</span>. El cambio queda registrado con tu motivo y
        puede pedir el PIN de un supervisor al cobrar.
      </p>
      <Input
        label="Precio unitario"
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        autoFocus
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {!backToList && (
        <Input
          label="Motivo"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej.: producto con falla, precio de góndola"
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={submit} disabled={!valid || !reasonOk}>
          {backToList ? "Volver al precio de lista" : "Aplicar precio"}
        </Button>
      </div>
    </div>
  );
}

// Precio a definir al cobrar (ADR-151). Se abre al agregar un producto o
// servicio en modo libre (y al editar el precio de esa línea): teclado
// numérico y foco directo en el precio, con el sugerido y el rango del
// producto. El servidor valida el mínimo y el máximo.
export interface OpenPriceTarget {
  name: string;
  min: number | null;
  max: number | null;
  suggested: number | null;
  /** Precio ya cargado (al editar la línea). */
  current?: number | null;
  isService?: boolean;
}

export function OpenPriceDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: OpenPriceTarget | null;
  onClose: () => void;
  onConfirm: (price: number) => void;
}) {
  return (
    <Modal
      open={target !== null}
      onOpenChange={(o) => !o && onClose()}
      title={target ? `Precio de ${target.name}` : "Precio"}
    >
      {target && (
        <OpenPriceForm
          key={`${target.name}:${target.current ?? ""}`}
          target={target}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      )}
    </Modal>
  );
}

function OpenPriceForm({
  target,
  onClose,
  onConfirm,
}: {
  target: OpenPriceTarget;
  onClose: () => void;
  onConfirm: (price: number) => void;
}) {
  const fmt = (n: number) => money(n);
  const [value, setValue] = useState(target.current != null ? String(target.current).replace(".", ",") : "");
  const [touched, setTouched] = useState(false);
  const price = parseTypedPrice(value);
  const err = openPriceError(price, target.min, target.max);
  const range = openPriceRangeText(target.min, target.max, fmt);
  const editing = target.current != null;
  const submit = () => {
    setTouched(true);
    if (!err && price != null) onConfirm(price);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {target.isService ? "Los honorarios se definen" : "El precio se define"} al cobrar.
        {range ? ` ${range}.` : ""}
      </p>
      <input
        autoFocus
        inputMode="decimal"
        aria-label="Precio"
        aria-invalid={touched && err ? true : undefined}
        value={value}
        placeholder={target.suggested != null ? String(target.suggested).replace(".", ",") : "0"}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value.replace(/[^\d.,]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className={cn(
          "h-16 w-full rounded-lg bg-muted px-4 text-right font-price text-3xl font-bold tabular-nums text-foreground outline-none transition focus:bg-secondary focus:shadow-[inset_0_0_0_1px_var(--border)]",
          touched && err && "text-danger",
        )}
      />
      {touched && err && (
        <p role="alert" className="text-sm font-medium text-danger">
          {openPriceErrorText(err, target.min, target.max, fmt)}
        </p>
      )}
      {target.suggested != null && (
        <button
          type="button"
          onClick={() => setValue(String(target.suggested).replace(".", ","))}
          className="inline-flex h-10 items-center rounded-md bg-fg-6 px-3.5 text-[13px] font-semibold tabular-nums transition-colors hover:bg-fg-10"
        >
          Usar sugerido {money(target.suggested)}
        </button>
      )}
      <Keypad lastKey="," onKey={(k) => setValue((v) => applyKey(v, k))} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={submit}>{editing ? "Guardar precio" : "Agregar al carrito"}</Button>
      </div>
    </div>
  );
}
