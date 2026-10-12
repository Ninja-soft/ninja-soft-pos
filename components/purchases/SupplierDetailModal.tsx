"use client";

// Ficha del proveedor (F18 · H101, ADR-050): datos, productos del proveedor
// (código, costo de lista, plazo de entrega, unidad de compra) y cuenta
// corriente con antigüedad de deuda (aging FIFO por vencimiento).

import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Download,
  FileText,
  HandCoins,
  Pencil,
  Star,
  Tag,
  FileUp,
  Trash2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { exportXlsx } from "@/lib/utils/xlsx";
import {
  AGING_BUCKETS,
  AGING_LABEL,
  ENTRY_TYPE_LABEL,
  ledgerWithRunning,
  supplierAging,
} from "@/lib/purchases/aging";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { CURRENCIES, SUPPLIER_IVA_LABEL, formatCuit } from "@/lib/purchases/suppliers";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  usePurchaseMutations,
  usePurchasesAccess,
  usePaymentAllocations,
  useSupplierEntries,
  useSupplierProducts,
  useSuppliers,
} from "@/modules/purchases/hooks";
import { variantLabel, type Product, type ProductVariant } from "@/modules/products/api";
import type { Supplier, SupplierProduct } from "@/modules/purchases/api";
import { Info, Kpi, fmtDate, formatMoney, inputCls, parseNum, selectCls, today } from "./shared";
import { SupplierFormModal } from "./SupplierFormModal";
import { ProductPicker } from "./ProductPicker";
import { PaymentFormModal } from "./PaymentFormModal";
import { InvoiceFormModal } from "./InvoiceFormModal";
import { PriceListImportModal } from "./PriceListImportModal";
import { PaymentOrderModal } from "./PaymentOrderModal";

type Tab = "datos" | "productos" | "cuenta";

export function SupplierDetailModal({
  supplierId,
  onOpenChange,
}: {
  supplierId: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("datos");
  const { data: suppliers = [] } = useSuppliers({ includeArchived: true }, Boolean(supplierId));
  const s = suppliers.find((x) => x.id === supplierId) ?? null;

  return (
    <Modal
      open={Boolean(supplierId)}
      onOpenChange={(o) => {
        if (!o) setTab("datos");
        onOpenChange(o);
      }}
      title={s?.name ?? "Proveedor"}
      description={s ? [s.trade_name, s.cuit ? `CUIT ${formatCuit(s.cuit)}` : null].filter(Boolean).join(" · ") : undefined}
      className="sm:max-w-4xl"
    >
      {!s ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : (
        <div className="space-y-5">
          <Segmented<Tab>
            aria-label="Sección"
            value={tab}
            onChange={setTab}
            size="sm"
            options={[
              { value: "datos", label: "Datos" },
              { value: "productos", label: "Productos" },
              { value: "cuenta", label: "Cuenta corriente" },
            ]}
          />
          {tab === "datos" && <DataTab s={s} />}
          {tab === "productos" && <ProductsTab s={s} />}
          {tab === "cuenta" && <AccountTab s={s} />}
        </div>
      )}
    </Modal>
  );
}

// ── Datos ──────────────────────────────────────────────────────────────────

function DataTab({ s }: { s: Supplier }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const access = usePurchasesAccess();
  const m = usePurchaseMutations();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canManage = Boolean(me?.canManage);
  const archived = Boolean(s.deleted_at);

  async function toggleArchive() {
    try {
      await m.archiveSupplier.mutateAsync({ id: s.id, archived: !archived });
      toast({ title: archived ? "Proveedor reactivado" : "Proveedor archivado", variant: "success" });
      setConfirmOpen(false);
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap gap-2">
          {!archived && (
            <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil size={15} /> Editar
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn(!archived && "text-danger")}
            onClick={() => setConfirmOpen(true)}
          >
            {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />} {archived ? "Reactivar" : "Archivar"}
          </Button>
        </div>
      )}
      {archived && <Badge tone="neutral">Archivado</Badge>}
      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm sm:grid-cols-4">
        <Info label="Condición IVA" value={SUPPLIER_IVA_LABEL[s.iva_condition] ?? s.iva_condition} />
        <Info label="CUIT" value={s.cuit ? formatCuit(s.cuit) : "Sin cargar"} />
        {s.foreign_tax_id && <Info label="Id. tributaria" value={s.foreign_tax_id} />}
        <Info
          label="Plazo de pago"
          value={s.payment_terms_days > 0 ? `${s.payment_terms_days} días` : "Contado"}
        />
        {access.pro && <Info label="Moneda" value={s.currency} />}
        <Info label="Contacto" value={s.contact_name || "Sin indicar"} />
        <Info label="Teléfono" value={s.phone || "Sin indicar"} />
        <Info label="WhatsApp" value={s.whatsapp || "Sin indicar"} />
        <Info label="Email" value={s.email || "Sin indicar"} />
        <Info
          label="Dirección"
          value={[s.address, s.city, s.province].filter(Boolean).join(", ") || "Sin indicar"}
          wide
        />
        {s.payment_terms_note && <Info label="Condiciones" value={s.payment_terms_note} wide />}
        <Info label="CBU / CVU" value={s.cbu || "Sin cargar"} />
        <Info label="Alias" value={s.alias || "Sin cargar"} />
        <Info label="Banco" value={s.bank_name || "Sin indicar"} />
        {s.notes && <Info label="Notas" value={s.notes} wide />}
      </dl>
      <SupplierFormModal open={editOpen} onOpenChange={setEditOpen} supplier={s} />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={archived ? "¿Reactivar el proveedor?" : "¿Archivar el proveedor?"}
        description={
          archived
            ? "Vuelve a aparecer para armar órdenes de compra."
            : "Deja de aparecer para nuevas compras. Su historia, facturas y cuenta corriente se conservan."
        }
        confirmLabel={archived ? "Reactivar" : "Archivar"}
        danger={!archived}
        loading={m.archiveSupplier.isPending}
        onConfirm={() => void toggleArchive()}
      />
    </div>
  );
}

// ── Productos ──────────────────────────────────────────────────────────────

function ProductsTab({ s }: { s: Supplier }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const m = usePurchaseMutations();
  const canManage = Boolean(me?.canManage) && !s.deleted_at;
  const { data: rows = [], isLoading } = useSupplierProducts({ supplierId: s.id });
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  async function add(p: Product, v: ProductVariant | null) {
    const exists = rows.some((r) => r.product_id === p.id && (r.variant_id ?? null) === (v?.id ?? null));
    if (exists) {
      toast({ title: `${p.name}${v ? ` (${variantLabel(v)})` : ""} ya está en la lista`, variant: "error" });
      return;
    }
    try {
      await m.saveSupplierProduct.mutateAsync({
        supplier_id: s.id,
        product_id: p.id,
        variant_id: v?.id ?? null,
        currency: s.currency,
      });
      toast({ title: "Producto agregado", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo agregar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="space-y-3">
      {canManage &&
        (adding ? (
          <div className="rounded-xl bg-muted/50 p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium">Sumar productos que le comprás</span>
              <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setAdding(false)}>
                Listo
              </button>
            </div>
            <ProductPicker onPick={(p, v) => void add(p, v)} />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <Tag size={15} /> Agregar productos
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
              <FileUp size={15} /> Importar lista de precios
            </Button>
          </div>
        ))}
      <PriceListImportModal open={importOpen} onOpenChange={setImportOpen} supplier={s} />
      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={Tag}
          title="Sin productos asociados"
          description="Se agregan solos al recibir mercadería de este proveedor, o sumalos acá con su código y costo de lista."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <SupplierProductRow key={r.id} row={r} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  );
}

function SupplierProductRow({ row, canManage }: { row: SupplierProduct; canManage: boolean }) {
  const { toast } = useToast();
  const access = usePurchasesAccess();
  const m = usePurchaseMutations();
  const [edit, setEdit] = useState(false);
  const [fx, setFx] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [f, setF] = useState(() => ({
    supplier_sku: row.supplier_sku ?? "",
    list_cost: row.list_cost == null ? "" : String(row.list_cost).replace(".", ","),
    currency: row.currency,
    lead_time_days: row.lead_time_days == null ? "" : String(row.lead_time_days),
    min_order_qty: row.min_order_qty == null ? "" : String(row.min_order_qty).replace(".", ","),
    purchase_unit: row.purchase_unit ?? "",
    units_per_purchase: String(row.units_per_purchase ?? 1).replace(".", ","),
    is_preferred: row.is_preferred,
  }));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    const lead = f.lead_time_days.trim() === "" ? null : Math.trunc(parseNum(f.lead_time_days));
    const minQ = f.min_order_qty.trim() === "" ? null : parseNum(f.min_order_qty);
    const per = parseNum(f.units_per_purchase) || 1;
    if ((lead != null && (lead < 0 || lead > 365)) || (minQ != null && minQ <= 0) || per <= 0) {
      toast({ title: "Revisá plazo, mínimo y unidades por bulto", variant: "error" });
      return;
    }
    try {
      await m.saveSupplierProduct.mutateAsync({
        id: row.id,
        supplier_id: row.supplier_id,
        product_id: row.product_id,
        variant_id: row.variant_id,
        supplier_sku: f.supplier_sku.trim() || null,
        list_cost: f.list_cost.trim() === "" ? null : parseNum(f.list_cost),
        currency: access.pro ? f.currency : row.currency,
        lead_time_days: lead,
        min_order_qty: minQ,
        purchase_unit: f.purchase_unit.trim() || null,
        units_per_purchase: per,
        is_preferred: f.is_preferred,
      });
      toast({ title: "Guardado", variant: "success" });
      setEdit(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  async function applyAsReplacement() {
    const foreign = row.currency !== "ARS";
    const rate = foreign ? parseNum(fx) : 1;
    if (foreign && !(rate > 0)) {
      toast({ title: "Cargá el tipo de cambio para pasar el costo a pesos", variant: "error" });
      return;
    }
    try {
      const cost = await m.setReplacement.mutateAsync({ id: row.id, fxRate: rate });
      toast({ title: `Costo de reposición actualizado: ${formatMoney(cost)}`, variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  async function remove() {
    try {
      await m.removeSupplierProduct.mutateAsync(row.id);
      toast({ title: "Producto quitado del proveedor", variant: "success" });
      setConfirmRemove(false);
    } catch (e) {
      toast({ title: "No se pudo quitar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const hasCost = row.list_cost != null || row.last_cost != null;

  return (
    <div className="rounded-xl ring-1 ring-border">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3 text-sm">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium">
            {row.is_preferred && <Star size={13} className="shrink-0 fill-warning text-warning" aria-label="Preferido" />}
            <span className="truncate">{row.product_name}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {[
              row.supplier_sku ? `Cód. prov. ${row.supplier_sku}` : null,
              row.product_sku ? `SKU ${row.product_sku}` : null,
              row.lead_time_days != null ? `Entrega ${row.lead_time_days} días` : null,
              row.purchase_unit ? `${row.purchase_unit} x ${String(row.units_per_purchase).replace(".", ",")}` : null,
              row.min_order_qty != null ? `Mínimo ${String(row.min_order_qty).replace(".", ",")}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div className="text-right text-xs">
          <div className="text-muted-foreground">Último costo</div>
          <div className="font-mono text-sm tabular-nums">
            {row.last_cost == null ? "Sin compras" : formatMoney(row.last_cost, row.currency)}
          </div>
          {row.last_cost_at && <div className="text-muted-foreground">{fmtDate(row.last_cost_at)}</div>}
        </div>
        <div className="text-right text-xs">
          <div className="text-muted-foreground">Lista</div>
          <div className="font-mono text-sm tabular-nums">
            {row.list_cost == null ? "Sin cargar" : formatMoney(row.list_cost, row.currency)}
          </div>
        </div>
        {canManage && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEdit((e) => !e)} aria-label="Editar">
              <Pencil size={15} />
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirmRemove(true)} aria-label="Quitar">
              <Trash2 size={15} />
            </Button>
          </div>
        )}
      </div>

      {canManage && edit && (
        <div className="space-y-3 border-t border-border bg-muted/40 px-3.5 py-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Código del proveedor">
              <input className={inputCls} value={f.supplier_sku} maxLength={80} onChange={(e) => set("supplier_sku", e.target.value)} />
            </Field>
            <Field label="Costo de lista">
              <input className={inputCls} inputMode="decimal" value={f.list_cost} onChange={(e) => set("list_cost", e.target.value)} />
            </Field>
            {access.pro && (
              <Field label="Moneda">
                <select className={cn(selectCls, "h-10")} value={f.currency} onChange={(e) => set("currency", e.target.value)}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c} className="bg-popover text-popover-foreground">
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Plazo de entrega (días)">
              <input className={inputCls} inputMode="numeric" value={f.lead_time_days} onChange={(e) => set("lead_time_days", e.target.value)} />
            </Field>
            <Field label="Mínimo de compra">
              <input className={inputCls} inputMode="decimal" value={f.min_order_qty} onChange={(e) => set("min_order_qty", e.target.value)} />
            </Field>
            <Field label="Unidad de compra">
              <input
                className={inputCls}
                value={f.purchase_unit}
                maxLength={30}
                placeholder="Caja, bulto, pack"
                onChange={(e) => set("purchase_unit", e.target.value)}
              />
            </Field>
            <Field label="Unidades por bulto">
              <input className={inputCls} inputMode="decimal" value={f.units_per_purchase} onChange={(e) => set("units_per_purchase", e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.is_preferred} onChange={(e) => set("is_preferred", e.target.checked)} />
            Proveedor preferido para este producto
          </label>
          <div className="flex flex-wrap items-end justify-between gap-2">
            {hasCost ? (
              <div className="flex flex-wrap items-end gap-2">
                {row.currency !== "ARS" && (
                  <Field label={`Tipo de cambio (${row.currency})`}>
                    <input className={cn(inputCls, "w-32")} inputMode="decimal" value={fx} onChange={(e) => setFx(e.target.value)} />
                  </Field>
                )}
                <Button size="sm" variant="secondary" onClick={() => void applyAsReplacement()} loading={m.setReplacement.isPending}>
                  Usar como costo de reposición
                </Button>
              </div>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEdit(false)}>
                Cancelar
              </Button>
              <Button size="sm" onClick={() => void save()} loading={m.saveSupplierProduct.isPending}>
                Guardar
              </Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="¿Quitar el producto de este proveedor?"
        description="No borra el producto ni su historia de compras."
        confirmLabel="Quitar"
        danger
        loading={m.removeSupplierProduct.isPending}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

// ── Cuenta corriente ───────────────────────────────────────────────────────

function AccountTab({ s }: { s: Supplier }) {
  const { data: me } = useMyTenant();
  const canManage = Boolean(me?.canManage);
  const { data: entries = [], isLoading } = useSupplierEntries(s.id);
  const [payOpen, setPayOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  const { data: allocations = [] } = usePaymentAllocations();
  const now = today();
  const aging = useMemo(() => {
    const docs = new Set(entries.map((e) => e.doc_id));
    return supplierAging(
      entries,
      now,
      allocations.filter((a) => docs.has(a.invoice_id)),
    );
  }, [entries, allocations, now]);
  const ledger = useMemo(() => ledgerWithRunning(entries), [entries]);

  function exportLedger() {
    void exportXlsx(`cuenta-corriente-${s.name}`, [
      {
        name: "Cuenta corriente",
        title: `Cuenta corriente · ${s.name}`,
        columns: [
          { header: "Fecha", key: "fecha", width: 12 },
          { header: "Comprobante", key: "tipo", width: 16 },
          { header: "Número", key: "numero", width: 20 },
          { header: "Vencimiento", key: "vence", width: 12 },
          { header: "Debe", key: "debe", type: "money" },
          { header: "Haber", key: "haber", type: "money" },
          { header: "Saldo", key: "saldo", type: "money" },
        ],
        rows: ledger.map((r) => ({
          fecha: fmtDate(r.doc_date),
          tipo: ENTRY_TYPE_LABEL[r.entry_type] ?? r.entry_type,
          numero: r.doc_label,
          vence: r.entry_type === "payment" ? "" : fmtDate(r.due_date),
          debe: r.amount_ars > 0 ? r.amount_ars : null,
          haber: r.amount_ars < 0 ? -r.amount_ars : null,
          saldo: r.running,
        })),
      },
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {canManage && !s.deleted_at && (
          <>
            <Button size="sm" onClick={() => setOrderOpen(true)}>
              <HandCoins size={15} /> Orden de pago
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setPayOpen(true)}>
              <HandCoins size={15} /> Pago simple
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setInvOpen(true)}>
              <FileText size={15} /> Cargar factura
            </Button>
          </>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={exportLedger} disabled={ledger.length === 0}>
          <Download size={15} /> XLSX
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Saldo" value={formatMoney(aging.balance)} tone={aging.balance > 0 ? "brand" : undefined} />
        <Kpi label="Vencido" value={formatMoney(aging.overdue)} tone={aging.overdue > 0 ? "danger" : undefined} />
        <Kpi label="A favor" value={formatMoney(aging.credit)} tone={aging.credit > 0 ? "success" : undefined} />
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-3 text-sm sm:grid-cols-5">
        {AGING_BUCKETS.map((b) => (
          <div key={b}>
            <div className="text-xs text-muted-foreground">{AGING_LABEL[b]}</div>
            <div
              className={cn(
                "font-mono tabular-nums",
                b !== "current" && aging.buckets[b] > 0 && "font-semibold text-danger",
              )}
            >
              {formatMoney(aging.buckets[b])}
            </div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando...</p>
      ) : entries.length === 0 ? (
        <EmptyState
          compact
          icon={FileText}
          title="Sin movimientos"
          description="Cuando cargues facturas o pagos de este proveedor, su cuenta corriente aparece acá."
        />
      ) : (
        <>
          {aging.open.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Comprobantes pendientes
              </h4>
              <div className="overflow-x-auto rounded-xl ring-1 ring-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Comprobante</th>
                      <th className="px-3 py-2 text-left">Vence</th>
                      <th className="px-3 py-2 text-right">Importe</th>
                      <th className="px-3 py-2 text-right">Pendiente</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {aging.open.map((d) => (
                      <tr key={d.doc_id}>
                        <td className="px-3 py-2">
                          <div>{d.doc_label}</div>
                          <div className="text-xs text-muted-foreground">{ENTRY_TYPE_LABEL[d.entry_type]}</div>
                        </td>
                        <td className="px-3 py-2">
                          <div>{fmtDate(d.due_date)}</div>
                          {d.days_overdue > 0 && (
                            <div className="text-xs text-danger">{d.days_overdue} días vencido</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{formatMoney(d.amount)}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatMoney(d.open)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Movimientos</h4>
            <div className="overflow-x-auto rounded-xl ring-1 ring-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    <th className="px-3 py-2 text-left">Comprobante</th>
                    <th className="px-3 py-2 text-right">Debe</th>
                    <th className="px-3 py-2 text-right">Haber</th>
                    <th className="px-3 py-2 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ledger.map((r) => (
                    <tr key={`${r.entry_type}:${r.doc_id}`}>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDate(r.doc_date)}</td>
                      <td className="px-3 py-2">
                        <div>{r.doc_label}</div>
                        <div className="text-xs text-muted-foreground">{ENTRY_TYPE_LABEL[r.entry_type]}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.amount_ars > 0 ? formatMoney(r.amount_ars) : ""}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-success">
                        {r.amount_ars < 0 ? formatMoney(-r.amount_ars) : ""}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{formatMoney(r.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <PaymentFormModal open={payOpen} onOpenChange={setPayOpen} supplierId={s.id} />
      <PaymentOrderModal open={orderOpen} onOpenChange={setOrderOpen} supplierId={s.id} />
      <InvoiceFormModal open={invOpen} onOpenChange={setInvOpen} supplierId={s.id} />
    </div>
  );
}
