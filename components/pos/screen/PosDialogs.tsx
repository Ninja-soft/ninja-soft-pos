"use client";

import { ScanBarcode } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils/cn";
import { formatQty } from "@/lib/utils/format";
import { money } from "../ui/posStyles";

// Diálogos chicos del POS (cliente, venta libre, peso y N° de serie). Misma
// lógica que antes; sólo cambia la piel (filas con relleno, sin bordes).

const row =
  "flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2.5 text-left text-sm transition hover:bg-muted";

export function CustomerPickerDialog({
  open,
  onOpenChange,
  search,
  onSearch,
  customers,
  current,
  onPick,
  onScanDni,
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
        {/* Alta rápida por DNI (H31). */}
        <Button type="button" variant="secondary" className="w-full" onClick={onScanDni}>
          <ScanBarcode size={16} /> Escanear DNI y agregar cliente
        </Button>
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          <button type="button" onClick={() => onPick(null)} className={cn(row, !current && "bg-muted")}>
            <span>Consumidor final</span>
            {!current && <span className="text-xs font-bold text-success">Actual</span>}
          </button>
          <p className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {search.trim() ? "Resultados" : "Recientes"}
          </p>
          {customers?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick({ id: c.id, name: c.name })}
              className={cn(row, current?.id === c.id && "bg-muted")}
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
}: {
  product: { name: string; price: number } | null;
  grams: string;
  onGrams: (v: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const g = Number(grams);
  return (
    <Modal
      open={product !== null}
      onOpenChange={(o) => !o && onClose()}
      title={product ? `Peso de ${product.name}` : "Peso"}
    >
      <div className="space-y-4">
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
              className="h-9 rounded-full bg-muted px-3.5 text-[13px] font-bold transition hover:bg-muted/70"
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
            <label key={s.id} className={cn(row, "cursor-pointer justify-start", choice === s.serial && "bg-muted")}>
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
          <label className={cn(row, "cursor-pointer justify-start", choice === "__other__" && "bg-muted")}>
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
