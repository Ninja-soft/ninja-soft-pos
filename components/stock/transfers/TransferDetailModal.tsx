"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  Download,
  PackageCheck,
  Pencil,
  Printer,
  Send,
  Truck,
  Undo2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { exportXlsx } from "@/lib/utils/xlsx";
import { webPrintCopies } from "@/lib/print/webPrint";
import {
  DIFFERENCE_REASONS,
  DIFFERENCE_REASON_LABEL,
  allowedActions,
  formatRemitoNumber,
  localDate,
  receiveOutcome,
  transferErrorMessage,
  type DifferenceReason,
  type TenantRole,
  type TransferAction,
} from "@/lib/stock/transfers";
import { remitoRows, remitoTotals } from "@/lib/stock/remito";
import type { StoreRef } from "@/lib/stock/byStore";
import type { TransferDetail } from "@/modules/stock/api";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  useCurrentUserId,
  useStockByStore,
  useTransfer,
  useTransferMutations,
  useTransferSettings,
} from "@/modules/stock/hooks";
import {
  DueChip,
  EVENT_LABEL,
  TransferStatusBadge,
  fmtDate,
  fmtDateTime,
  selectCls,
  storeName,
} from "./shared";

type Panel =
  | "detail"
  | "dispatch"
  | "receive"
  | "reject"
  | "cancel"
  | "reschedule";

export function TransferDetailModal({
  transferId,
  onOpenChange,
  stores,
  onEdit,
}: {
  transferId: string | null;
  onOpenChange: (o: boolean) => void;
  stores: StoreRef[];
  onEdit: (t: TransferDetail) => void;
}) {
  const { toast } = useToast();
  const { data: t, isLoading } = useTransfer(transferId);
  const { data: me } = useMyTenant();
  const { data: userId } = useCurrentUserId();
  const { data: settings } = useTransferSettings(Boolean(transferId));
  const m = useTransferMutations();
  const [panel, setPanel] = useState<Panel>("detail");

  useEffect(() => {
    setPanel("detail");
  }, [transferId]);

  const actions: TransferAction[] = t
    ? allowedActions(
        t,
        (me?.role ?? null) as TenantRole | null,
        userId,
        settings,
      )
    : [];

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      toast({ title: label, variant: "success" });
      setPanel("detail");
    } catch (e) {
      toast({
        title: "No se pudo completar",
        description: transferErrorMessage(e),
        variant: "error",
      });
    }
  }

  const title = t ? `Traslado ${formatRemitoNumber(t.number)}` : "Traslado";
  const showReception = Boolean(
    t && ["partially_received", "received"].includes(t.status),
  );

  function exportRemito() {
    if (!t) return;
    const rows = remitoRows(t.items, showReception);
    const totals = remitoTotals(rows);
    void exportXlsx(`remito-${formatRemitoNumber(t.number)}`, [
      {
        name: "Remito",
        title: `Remito interno ${formatRemitoNumber(t.number)} · ${storeName(stores, t.origin_store_id)} a ${storeName(stores, t.dest_store_id)}`,
        columns: [
          { header: "Producto", key: "producto", width: 36 },
          { header: "SKU", key: "sku", width: 16 },
          { header: "Unidad", key: "unidad", width: 8 },
          { header: "Pedido", key: "pedido", type: "number" },
          { header: "Enviado", key: "enviado", type: "number" },
          ...(showReception
            ? [
                {
                  header: "Recibido",
                  key: "recibido",
                  type: "number" as const,
                },
                {
                  header: "Diferencia",
                  key: "diferencia",
                  type: "number" as const,
                },
                { header: "Motivo", key: "motivo", width: 18 },
              ]
            : []),
        ],
        rows: rows as unknown as Array<Record<string, unknown>>,
        totals: showReception
          ? totals
          : { pedido: totals.pedido, enviado: totals.enviado },
      },
    ]);
  }

  return (
    <Modal
      open={Boolean(transferId)}
      onOpenChange={onOpenChange}
      title={title}
      className="sm:max-w-3xl"
      header={
        t ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg font-bold">
                {formatRemitoNumber(t.number)}
              </span>
              <TransferStatusBadge status={t.status} />
              <DueChip scheduledFor={t.scheduled_for} status={t.status} />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {storeName(stores, t.origin_store_id)} <ArrowRight size={14} />{" "}
              {storeName(stores, t.dest_store_id)}
            </div>
          </div>
        ) : undefined
      }
    >
      {isLoading || !t ? (
        <SpinnerBlock className="py-10" />
      ) : panel === "dispatch" ? (
        <DispatchPanel
          t={t}
          stores={stores}
          blockWithoutStock={settings?.block_dispatch_without_stock ?? true}
          loading={m.dispatch.isPending}
          onCancel={() => setPanel("detail")}
          onConfirm={(items, notes) =>
            run("Despachado: la mercadería está en camino", () =>
              m.dispatch.mutateAsync({ id: t.id, items, notes }),
            )
          }
        />
      ) : panel === "receive" ? (
        <ReceivePanel
          t={t}
          loading={m.receive.isPending}
          requireReason={settings?.require_difference_reason ?? true}
          allowOver={settings?.allow_over_receive ?? true}
          onCancel={() => setPanel("detail")}
          onConfirm={(items, close, notes) =>
            run(close ? "Recepción cerrada" : "Recepción registrada", () =>
              m.receive.mutateAsync({ id: t.id, items, close, notes }),
            )
          }
        />
      ) : panel === "reject" || panel === "cancel" ? (
        <ReasonPanel
          title={
            panel === "reject"
              ? "¿Por qué lo devolvés a borrador?"
              : "¿Por qué lo cancelás?"
          }
          hint={
            panel === "cancel" && t.status === "in_transit"
              ? "Lo despachado vuelve al stock de la sucursal de origen."
              : undefined
          }
          confirmLabel={
            panel === "reject" ? "Devolver a borrador" : "Cancelar traslado"
          }
          danger={panel === "cancel"}
          loading={m.reject.isPending || m.cancel.isPending}
          onCancel={() => setPanel("detail")}
          onConfirm={(reason) =>
            panel === "reject"
              ? run("Devuelto a borrador", () =>
                  m.reject.mutateAsync({ id: t.id, reason }),
                )
              : run("Traslado cancelado", () =>
                  m.cancel.mutateAsync({ id: t.id, reason }),
                )
          }
        />
      ) : panel === "reschedule" ? (
        <ReschedulePanel
          current={t.scheduled_for}
          loading={m.reschedule.isPending}
          onCancel={() => setPanel("detail")}
          onConfirm={(date) =>
            run("Fecha actualizada", () =>
              m.reschedule.mutateAsync({ id: t.id, date }),
            )
          }
        />
      ) : (
        <div className="space-y-5">
          <ActionBar
            actions={actions}
            busy={m.submit.isPending || m.approve.isPending}
            onAction={(a) => {
              if (a === "edit") onEdit(t);
              else if (a === "submit")
                void run("Traslado confirmado", () =>
                  m.submit.mutateAsync(t.id),
                );
              else if (a === "approve")
                void run("Traslado aprobado", () =>
                  m.approve.mutateAsync({ id: t.id }),
                );
              else setPanel(a as Panel);
            }}
            onPrint={() => webPrintCopies(1)}
            onExport={exportRemito}
          />

          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-muted p-3.5 text-sm sm:grid-cols-4">
            <Info
              label="Programado"
              value={t.scheduled_for ? fmtDate(t.scheduled_for) : "Sin fecha"}
            />
            <Info label="Unidades" value={formatQty(t.total_units)} />
            <Info label="Valor a costo" value={formatCurrency(t.total_value)} />
            <Info label="Transportista" value={t.carrier || "Sin indicar"} />
            {t.notes && <Info label="Notas" value={t.notes} wide />}
            {t.cancel_reason && (
              <Info
                label="Motivo de cancelación"
                value={t.cancel_reason}
                wide
              />
            )}
          </dl>

          <ItemsTable t={t} showReception={showReception} />

          <Timeline t={t} />

          <RemitoPrint
            t={t}
            stores={stores}
            businessName={me?.name ?? ""}
            showReception={showReception}
          />
        </div>
      )}
    </Modal>
  );
}

function Info({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={cn(wide && "col-span-2 sm:col-span-4")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

const ACTION_META: Partial<
  Record<
    TransferAction,
    { label: string; icon: typeof Send; primary?: boolean; danger?: boolean }
  >
> = {
  edit: { label: "Editar", icon: Pencil },
  submit: { label: "Confirmar", icon: Send, primary: true },
  approve: { label: "Aprobar", icon: Check, primary: true },
  reject: { label: "Devolver", icon: Undo2 },
  reschedule: { label: "Reprogramar", icon: CalendarClock },
  dispatch: { label: "Despachar", icon: Truck, primary: true },
  receive: { label: "Recibir", icon: PackageCheck, primary: true },
  cancel: { label: "Cancelar", icon: Ban, danger: true },
};

function ActionBar({
  actions,
  busy,
  onAction,
  onPrint,
  onExport,
}: {
  actions: TransferAction[];
  busy: boolean;
  onAction: (a: TransferAction) => void;
  onPrint: () => void;
  onExport: () => void;
}) {
  return (
    <div className="no-print flex flex-wrap gap-2">
      {actions.map((a) => {
        const meta = ACTION_META[a];
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <Button
            key={a}
            size="sm"
            variant={
              meta.primary ? "primary" : meta.danger ? "ghost" : "secondary"
            }
            className={cn(meta.danger && "text-danger")}
            loading={busy && meta.primary}
            onClick={() => onAction(a)}
          >
            <Icon size={15} /> {meta.label}
          </Button>
        );
      })}
      <span className="flex-1" />
      <Button size="sm" variant="secondary" onClick={onPrint}>
        <Printer size={15} /> Remito
      </Button>
      <Button size="sm" variant="secondary" onClick={onExport}>
        <Download size={15} /> XLSX
      </Button>
    </div>
  );
}

function ItemsTable({
  t,
  showReception,
}: {
  t: TransferDetail;
  showReception: boolean;
}) {
  const dispatched = t.items.some((i) => i.qty_dispatched != null);
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Producto</th>
            <th className="px-3 py-2 text-right">Pedido</th>
            {dispatched && <th className="px-3 py-2 text-right">Enviado</th>}
            {showReception && (
              <th className="px-3 py-2 text-right">Recibido</th>
            )}
            {showReception && (
              <th className="px-3 py-2 text-left">Diferencia</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {t.items.map((i) => {
            const diff =
              showReception && i.qty_dispatched != null
                ? Math.round((i.qty_received - i.qty_dispatched) * 1000) / 1000
                : 0;
            return (
              <tr key={i.id}>
                <td className="px-3 py-2">
                  <div className="font-medium">{i.product_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[i.variant_label, i.sku].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatQty(i.qty_requested)}
                </td>
                {dispatched && (
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {i.qty_dispatched == null
                      ? ""
                      : formatQty(i.qty_dispatched)}
                  </td>
                )}
                {showReception && (
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatQty(i.qty_received)}
                  </td>
                )}
                {showReception && (
                  <td
                    className={cn(
                      "px-3 py-2 text-xs",
                      diff < 0
                        ? "text-danger"
                        : diff > 0
                          ? "text-info"
                          : "text-muted-foreground",
                    )}
                  >
                    {diff === 0
                      ? "Sin diferencia"
                      : `${diff > 0 ? "+" : ""}${formatQty(diff)}${i.difference_reason ? ` · ${DIFFERENCE_REASON_LABEL[i.difference_reason]}` : ""}`}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Timeline({ t }: { t: TransferDetail }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Historial
      </h3>
      <ol className="space-y-2 border-l border-border pl-4">
        {t.events.map((e) => (
          <li key={e.id} className="relative text-sm">
            <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-ninja-flameSoft" />
            <div className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</div>
            <div className="text-xs text-muted-foreground">
              {fmtDateTime(e.created_at)}
              {e.actor_name ? ` · ${e.actor_name}` : ""}
            </div>
            {e.notes && <div className="text-xs">{e.notes}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── Despacho ───────────────────────────────────────────────────────────────

function DispatchPanel({
  t,
  stores,
  blockWithoutStock,
  loading,
  onCancel,
  onConfirm,
}: {
  t: TransferDetail;
  stores: StoreRef[];
  blockWithoutStock: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (
    items: Array<{ item_id: string; qty: number }>,
    notes: string | null,
  ) => void;
}) {
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(t.items.map((i) => [i.id, String(i.qty_requested)])),
  );
  const [notes, setNotes] = useState("");
  const { data: rows } = useStockByStore(t.items.map((i) => i.product_id));
  const avail = (productId: string, variantId: string | null) =>
    Number(
      (rows ?? []).find(
        (r) =>
          r.store_id === t.origin_store_id &&
          r.product_id === productId &&
          (r.variant_id ?? null) === variantId,
      )?.qty ?? 0,
    );
  const lines = t.items.map((i) => {
    const q = Number(qty[i.id] ?? 0);
    const av = avail(i.product_id, i.variant_id);
    return {
      i,
      q,
      av,
      over: blockWithoutStock && q > av,
      invalid: !Number.isFinite(q) || q < 0,
    };
  });
  const total = lines.reduce((s, l) => s + (l.invalid ? 0 : l.q), 0);
  const blocked = lines.some((l) => l.over || l.invalid) || total <= 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Confirmá lo que sale de <b>{storeName(stores, t.origin_store_id)}</b>.
        Se descuenta ahora y queda en camino hasta que lo reciban.
      </p>
      <ul className="divide-y divide-border rounded-xl bg-muted">
        {lines.map(({ i, q, av, over }) => (
          <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {i.product_name}
                {i.variant_label && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {i.variant_label}
                  </span>
                )}
              </div>
              <div
                className={cn(
                  "text-xs",
                  over ? "text-danger" : "text-muted-foreground",
                )}
              >
                Pedido {formatQty(i.qty_requested)} · disponible {formatQty(av)}
                {q === 0 ? " · no va" : ""}
              </div>
            </div>
            <input
              type="number"
              min={0}
              step="any"
              value={qty[i.id] ?? ""}
              onChange={(e) =>
                setQty((s) => ({ ...s, [i.id]: e.target.value }))
              }
              className="h-10 w-24 rounded-lg border border-input bg-background px-2 text-right font-mono text-sm tabular-nums"
              aria-label={`Enviar de ${i.product_name}`}
            />
          </li>
        ))}
      </ul>
      <Input
        label="Notas del despacho (opcional)"
        maxLength={200}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Volver
        </Button>
        <Button
          loading={loading}
          disabled={blocked}
          onClick={() =>
            onConfirm(
              lines.map((l) => ({ item_id: l.i.id, qty: l.q })),
              notes.trim() || null,
            )
          }
        >
          <Truck size={15} /> Despachar {formatQty(total)}
        </Button>
      </div>
    </div>
  );
}

// ── Recepción ──────────────────────────────────────────────────────────────

function ReceivePanel({
  t,
  loading,
  requireReason,
  allowOver,
  onCancel,
  onConfirm,
}: {
  t: TransferDetail;
  loading: boolean;
  requireReason: boolean;
  allowOver: boolean;
  onCancel: () => void;
  onConfirm: (
    items: Array<{
      item_id: string;
      qty: number;
      reason: DifferenceReason | null;
    }>,
    close: boolean,
    notes: string | null,
  ) => void;
}) {
  const sent = t.items.filter((i) => (i.qty_dispatched ?? 0) > 0);
  const [incoming, setIncoming] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      sent.map((i) => [
        i.id,
        String(Math.max(0, (i.qty_dispatched ?? 0) - i.qty_received)),
      ]),
    ),
  );
  const [reasons, setReasons] = useState<Record<string, DifferenceReason | "">>(
    () =>
      Object.fromEntries(sent.map((i) => [i.id, i.difference_reason ?? ""])),
  );
  const [close, setClose] = useState(false);
  const [notes, setNotes] = useState("");

  const outcome = useMemo(
    () =>
      receiveOutcome(
        sent.map((i) => ({
          dispatched: i.qty_dispatched,
          received: i.qty_received,
          incoming: Number(incoming[i.id] ?? 0) || 0,
          reason: reasons[i.id] || null,
        })),
        close,
        {
          require_approval: false,
          approval_min_units: null,
          approval_min_value: null,
          cashier_can_dispatch: false,
          cashier_can_receive: true,
          allow_over_receive: allowOver,
          require_difference_reason: requireReason,
          block_dispatch_without_stock: true,
        },
      ),
    [sent, incoming, reasons, close, allowOver, requireReason],
  );
  const closing = outcome.status === "received";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Contá lo que llegó. Si falta algo podés dejarlo pendiente o cerrar la
        recepción con el motivo de la diferencia.
      </p>
      <ul className="divide-y divide-border rounded-xl bg-muted">
        {sent.map((i, idx) => {
          const r = outcome.lines[idx]!;
          const showReason = closing && r.difference !== 0;
          return (
            <li key={i.id} className="space-y-2 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {i.product_name}
                    {i.variant_label && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {i.variant_label}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Enviado {formatQty(i.qty_dispatched)}
                    {i.qty_received > 0
                      ? ` · ya recibido ${formatQty(i.qty_received)}`
                      : ""}
                    {r.difference !== 0 && (
                      <span
                        className={
                          r.difference < 0 ? "text-danger" : "text-info"
                        }
                      >
                        {" "}
                        ·{" "}
                        {r.difference > 0
                          ? "sobran"
                          : closing
                            ? "faltan"
                            : "pendiente"}{" "}
                        {formatQty(Math.abs(r.difference))}
                      </span>
                    )}
                  </div>
                </div>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={incoming[i.id] ?? ""}
                  onChange={(e) =>
                    setIncoming((s) => ({ ...s, [i.id]: e.target.value }))
                  }
                  className="h-10 w-24 rounded-lg border border-input bg-background px-2 text-right font-mono text-sm tabular-nums"
                  aria-label={`Llegó de ${i.product_name}`}
                />
              </div>
              {showReason && (
                <select
                  className={cn(
                    selectCls,
                    "h-10",
                    r.needsReason && requireReason && "border-danger",
                  )}
                  value={reasons[i.id] ?? ""}
                  onChange={(e) =>
                    setReasons((s) => ({
                      ...s,
                      [i.id]: e.target.value as DifferenceReason,
                    }))
                  }
                  aria-label={`Motivo de diferencia de ${i.product_name}`}
                >
                  <option
                    value=""
                    className="bg-popover text-popover-foreground"
                  >
                    Motivo de la diferencia
                  </option>
                  {DIFFERENCE_REASONS.map((k) => (
                    <option
                      key={k}
                      value={k}
                      className="bg-popover text-popover-foreground"
                    >
                      {DIFFERENCE_REASON_LABEL[k]}
                    </option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>
      <div className="rounded-xl bg-muted p-3">
        <Switch
          checked={close}
          onCheckedChange={setClose}
          label="Cerrar la recepción aunque falte mercadería"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {closing
            ? "Queda recibido. Lo que no llegó se registra como diferencia y no vuelve a ninguna sucursal."
            : "Queda como recibido parcial: después podés registrar lo que llegue."}
        </p>
      </div>
      <Input
        label="Notas (opcional)"
        maxLength={200}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {outcome.error && outcome.error !== "nothing_to_receive" && (
        <p className="text-xs text-danger">
          {transferErrorMessage(new Error(outcome.error))}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Volver
        </Button>
        <Button
          loading={loading}
          disabled={Boolean(outcome.error)}
          onClick={() =>
            onConfirm(
              sent.map((i) => ({
                item_id: i.id,
                qty: Number(incoming[i.id] ?? 0) || 0,
                reason: reasons[i.id] || null,
              })),
              close,
              notes.trim() || null,
            )
          }
        >
          <PackageCheck size={15} />{" "}
          {closing ? "Recibir y cerrar" : "Registrar recepción"}
        </Button>
      </div>
    </div>
  );
}

function ReasonPanel({
  title,
  hint,
  confirmLabel,
  danger,
  loading,
  onCancel,
  onConfirm,
}: {
  title: string;
  hint?: string;
  confirmLabel: string;
  danger?: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-4">
      <Input
        label={title}
        maxLength={200}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        hint={hint}
        autoFocus
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Volver
        </Button>
        <Button
          variant={danger ? "destructive" : "primary"}
          loading={loading}
          disabled={!reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

function ReschedulePanel({
  current,
  loading,
  onCancel,
  onConfirm,
}: {
  current: string | null;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (date: string) => void;
}) {
  const [date, setDate] = useState(current?.slice(0, 10) ?? localDate());
  return (
    <div className="space-y-4">
      <Input
        label="Nueva fecha"
        type="date"
        min={localDate()}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Volver
        </Button>
        <Button
          loading={loading}
          disabled={!date}
          onClick={() => onConfirm(date)}
        >
          Guardar fecha
        </Button>
      </div>
    </div>
  );
}

// ── Remito imprimible (sólo se ve al imprimir) ─────────────────────────────

function RemitoPrint({
  t,
  stores,
  businessName,
  showReception,
}: {
  t: TransferDetail;
  stores: StoreRef[];
  businessName: string;
  showReception: boolean;
}) {
  const rows = remitoRows(t.items, showReception);
  const totals = remitoTotals(rows);
  return (
    <div className="remito-print hidden print:block">
      <div className="remito-page">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{businessName}</div>
            <div style={{ fontSize: 12 }}>
              Remito interno de traslado entre sucursales
            </div>
            <div style={{ fontSize: 11 }}>Documento no válido como factura</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              {formatRemitoNumber(t.number)}
            </div>
            <div style={{ fontSize: 12 }}>
              Fecha:{" "}
              {fmtDate(t.dispatched_at ?? t.scheduled_for ?? t.created_at)}
            </div>
          </div>
        </div>
        <table style={{ width: "100%", marginTop: 12, fontSize: 12 }}>
          <tbody>
            <tr>
              <td>
                <b>Origen:</b> {storeName(stores, t.origin_store_id)}
              </td>
              <td>
                <b>Destino:</b> {storeName(stores, t.dest_store_id)}
              </td>
            </tr>
            <tr>
              <td>
                <b>Transportista:</b> {t.carrier || ""}
              </td>
              <td>
                <b>Notas:</b> {t.notes || ""}
              </td>
            </tr>
          </tbody>
        </table>
        <table
          className="remito-items"
          style={{
            width: "100%",
            marginTop: 12,
            fontSize: 12,
            borderCollapse: "collapse",
          }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Producto</th>
              <th style={{ textAlign: "left" }}>SKU</th>
              <th style={{ textAlign: "right" }}>Pedido</th>
              <th style={{ textAlign: "right" }}>Enviado</th>
              {showReception && (
                <th style={{ textAlign: "right" }}>Recibido</th>
              )}
              {showReception && (
                <th style={{ textAlign: "left" }}>Diferencia</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.producto}</td>
                <td>{r.sku}</td>
                <td style={{ textAlign: "right" }}>
                  {formatQty(r.pedido)} {r.unidad}
                </td>
                <td style={{ textAlign: "right" }}>
                  {r.enviado == null ? "" : formatQty(r.enviado)}
                </td>
                {showReception && (
                  <td style={{ textAlign: "right" }}>
                    {formatQty(r.recibido)}
                  </td>
                )}
                {showReception && (
                  <td>
                    {r.diferencia
                      ? `${r.diferencia > 0 ? "+" : ""}${formatQty(r.diferencia)} ${r.motivo}`
                      : ""}
                  </td>
                )}
              </tr>
            ))}
            <tr>
              <td colSpan={2}>
                <b>Total</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{formatQty(totals.pedido)}</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{formatQty(totals.enviado)}</b>
              </td>
              {showReception && (
                <td style={{ textAlign: "right" }}>
                  <b>{formatQty(totals.recibido)}</b>
                </td>
              )}
              {showReception && <td />}
            </tr>
          </tbody>
        </table>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 48,
            fontSize: 12,
          }}
        >
          <div
            style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}
          >
            Entregó (firma y aclaración)
          </div>
          <div
            style={{ borderTop: "1px solid #000", width: "40%", paddingTop: 4 }}
          >
            Recibió (firma y aclaración)
          </div>
        </div>
      </div>
    </div>
  );
}
