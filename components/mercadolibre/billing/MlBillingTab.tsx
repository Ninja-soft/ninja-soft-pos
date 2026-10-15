"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, FileText, Inbox, Lock, Settings2, Undo2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { mlErrorMessage } from "@/lib/mercadolibre/labels";
import {
  BLOCKING_WARNINGS,
  INBOX_FILTERS,
  LOGISTIC_LABELS,
  PLAN_STATUS_LABELS,
  billingErrorMessage,
  effectiveLetter,
  isSelectable,
  planStatusTone,
  receptorLine,
  warningLabel,
  type InboxFilter,
  type InboxRow,
} from "@/lib/mercadolibre/billing";
import { useMlBillingMutations, useMlBillingSettings, useMlInvoiceInbox } from "@/modules/mercadolibre/billingHooks";
import type { MlAccount } from "@/modules/mercadolibre/hooks";
import { MlInvoiceDetail } from "./MlInvoiceDetail";
import { MlBillingSettingsForm } from "./MlBillingSettings";

type View = "inbox" | "settings";

const errText = (e: unknown) => billingErrorMessage(e) ?? mlErrorMessage(e);

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" });
}

// Facturación de Mercado Libre (ADR-141): bandeja de ventas por facturar, en
// espera de la percepción, a revisar, con error y facturadas, con acciones en
// lote, y la configuración de la cuenta. Sin la feature pro se ve sólo cuándo
// facturar (ADR-104) y la invitación a mejorar el plan.
export function MlBillingTab({ account, canManage }: { account: MlAccount; canManage: boolean }) {
  const { data: settings, isLoading } = useMlBillingSettings(account.id);
  const pro = settings?.features.billing === true;
  const [view, setView] = useState<View>("inbox");
  const [upgrade, setUpgrade] = useState(false);

  if (isLoading || !settings) return <SpinnerBlock className="py-16" />;

  if (!pro) {
    return (
      <div className="space-y-4">
        <Callout
          tone="brand"
          icon={Lock}
          title="Facturación de Mercado Libre con reglas"
          actions={<Button size="sm" onClick={() => setUpgrade(true)}>Ver planes</Button>}
        >
          Cupones y envío en la factura, datos fiscales del comprador con el padrón de ARCA, qué factura sale y cuál se sube a la venta,
          percepciones de IIBB cobradas por link de pago y una bandeja para facturar en lote. Hoy tus ventas se facturan con la letra
          automática según cuándo elijas abajo.
        </Callout>
        <MlBillingSettingsForm account={account} settings={settings} canManage={canManage} />
        <UpgradeModal open={upgrade} onOpenChange={setUpgrade} featureKey="mercadolibre_facturacion" featureLabel="Facturación de Mercado Libre" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Segmented
        value={view}
        onChange={setView}
        aria-label="Facturación"
        size="sm"
        options={[
          { value: "inbox", label: "Bandeja", icon: <Inbox size={14} /> },
          { value: "settings", label: "Configuración", icon: <Settings2 size={14} /> },
        ]}
      />
      {!settings.features.arca && (
        <Callout tone="warning" icon={AlertTriangle} title="La facturación electrónica no está activa">
          Activala en Configuración › Facturación electrónica: hasta entonces las ventas quedan en la bandeja sin emitir.
        </Callout>
      )}
      {view === "inbox" ? (
        <MlInvoiceInbox account={account} canManage={canManage} emitter={settings.emitter} />
      ) : (
        <MlBillingSettingsForm account={account} settings={settings} canManage={canManage} />
      )}
    </div>
  );
}

function MlInvoiceInbox({
  account,
  canManage,
  emitter,
}: {
  account: MlAccount;
  canManage: boolean;
  emitter: { iva_condition: string | null; issues_m: boolean };
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<InboxFilter>("por_facturar");
  const { data, isLoading } = useMlInvoiceInbox(account.id, filter);
  const { emit, skip } = useMlBillingMutations();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<InboxRow | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [failures, setFailures] = useState<Array<{ pack: string; error: string }>>([]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selectable = rows.filter(isSelectable);
  const chosen = rows.filter((r) => selected.has(r.id));
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.id));
  const counts = data?.counts;

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const runEmit = (force: boolean) =>
    emit.mutate(
      { planIds: chosen.map((r) => r.id), force },
      {
        onSuccess: (res) => {
          const bad = res.results.filter((x) => !x.ok);
          setFailures(bad.map((x) => ({ pack: rows.find((r) => r.id === x.id)?.pack_key ?? x.id, error: errText(x.error ?? "") })));
          toast({
            title: res.ok === 1 ? "1 factura en la cola de ARCA" : `${res.ok} facturas en la cola de ARCA`,
            description: bad.length ? `${bad.length} no salieron: mirá el detalle abajo.` : undefined,
            variant: bad.length ? "warning" : "success",
          });
          setSelected(new Set());
        },
        onError: (e) => toast({ title: "No se pudo facturar", description: errText(e), variant: "error" }),
      },
    );

  const needsForce = chosen.some((r) => r.status === "needs_review" || r.status === "blocked");

  return (
    <div className="space-y-3">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filtrar la bandeja">
        {INBOX_FILTERS.map((f) => {
          const n = f.key === "todo" ? null : counts?.[f.key as keyof typeof counts];
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setFilter(f.key);
                setSelected(new Set());
                setFailures([]);
              }}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60",
              )}
            >
              {f.label}
              {n != null && n > 0 && <span className="tabular-nums text-xs text-muted-foreground">{n}</span>}
            </button>
          );
        })}
      </div>

      {canManage && selectable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allOn ? true : selected.size > 0 ? "indeterminate" : false}
              onCheckedChange={(on) => setSelected(on ? new Set(selectable.map((r) => r.id)) : new Set())}
              aria-label="Elegir todas"
            />
            {selected.size > 0 ? `${selected.size} elegidas` : "Elegir todas"}
          </label>
          <div className="ml-auto flex flex-wrap gap-2">
            {filter === "omitidas" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={chosen.length === 0}
                loading={skip.isPending}
                onClick={() =>
                  skip.mutate(
                    { planIds: chosen.map((r) => r.id), skip: false },
                    { onSuccess: () => setSelected(new Set()), onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }) },
                  )
                }
              >
                <Undo2 size={15} /> Volver a facturar
              </Button>
            ) : (
              <>
                <Button size="sm" variant="secondary" disabled={chosen.length === 0} onClick={() => setConfirmSkip(true)}>
                  <XCircle size={15} /> No facturar
                </Button>
                <Button size="sm" disabled={chosen.length === 0} loading={emit.isPending} onClick={() => runEmit(needsForce)}>
                  <FileText size={15} /> Facturar {chosen.length > 0 ? chosen.length : ""}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {failures.length > 0 && (
        <Callout tone="warning" icon={AlertTriangle} title="Estas ventas no se facturaron">
          <ul className="space-y-0.5 text-sm">
            {failures.map((f) => (
              <li key={f.pack}>
                <span className="font-mono text-xs">{f.pack}</span>: {f.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {isLoading ? (
        <SpinnerBlock className="py-12" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No hay ventas acá"
          description="Cada venta pagada de Mercado Libre entra con su factura armada según tus reglas: cupón, envío, datos del comprador y percepciones."
        />
      ) : (
        <ul className="divide-y divide-border rounded-xl bg-card" aria-label="Ventas para facturar">
          {rows.map((r) => (
            <InboxItem
              key={r.id}
              row={r}
              selectable={canManage && isSelectable(r)}
              selected={selected.has(r.id)}
              onToggle={(on) => toggle(r.id, on)}
              onOpen={() => setOpen(r)}
            />
          ))}
        </ul>
      )}

      <MlInvoiceDetail
        row={open ? rows.find((r) => r.id === open.id) ?? open : null}
        account={account}
        emitter={emitter}
        canManage={canManage}
        onClose={() => setOpen(null)}
      />
      <ConfirmDialog
        open={confirmSkip}
        onOpenChange={setConfirmSkip}
        title={`No facturar ${chosen.length === 1 ? "esta venta" : `estas ${chosen.length} ventas`}`}
        description="Quedan en 'No se facturan' y no salen solas. Podés volver a ponerlas para facturar cuando quieras."
        confirmLabel="No facturar"
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="Por ejemplo: la facturé desde otro sistema"
        loading={skip.isPending}
        onConfirm={(reason) =>
          skip.mutate(
            { planIds: chosen.map((r) => r.id), skip: true, reason },
            {
              onSuccess: () => {
                setSelected(new Set());
                setConfirmSkip(false);
              },
              onError: (e) => toast({ title: "No se pudo", description: errText(e), variant: "error" }),
            },
          )
        }
      />
    </div>
  );
}

function InboxItem({
  row,
  selectable,
  selected,
  onToggle,
  onOpen,
}: {
  row: InboxRow;
  selectable: boolean;
  selected: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  const first = row.orders?.[0];
  const receptor = row.plan.receptors[row.choice];
  const letter = effectiveLetter(row);
  const perc = row.plan.perception;
  const blocking = row.warnings.filter((w) => BLOCKING_WARNINGS.has(w));
  const other = row.warnings.filter((w) => !BLOCKING_WARNINGS.has(w));
  return (
    <li className="flex gap-3 px-3 py-3 sm:px-4">
      <div className="pt-0.5">
        {selectable ? (
          <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Elegir la venta ${row.pack_key}`} />
        ) : (
          <span className="inline-block h-4 w-4" aria-hidden />
        )}
      </div>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 space-y-1 text-left">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">
            {row.sale_number ? `Venta #${row.sale_number}` : `Carrito ${row.pack_key}`}
          </span>
          <Badge tone={planStatusTone(row.status)}>{PLAN_STATUS_LABELS[row.status] ?? row.status}</Badge>
          {letter && <Badge tone="neutral">Factura {letter}{row.letter ? " · elegida" : ""}</Badge>}
          {perc.applies && row.choice === "billing" && row.perception_mode === "charge" && (
            <Badge tone={["paid", "paid_manual"].includes(row.charge?.status ?? "") ? "success" : "warning"}>
              Percepción {formatCurrency(perc.total)}
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {when(first?.date_created ?? row.created_at)} · {first?.buyer_nickname ?? "Comprador"} · {LOGISTIC_LABELS[row.plan.logistic]}
        </p>
        <p className="truncate text-xs">{receptorLine(receptor)}</p>
        {row.document?.error_msg && <p className="text-xs text-danger">{row.document.error_msg}</p>}
        {row.last_error && !row.document && <p className="text-xs text-danger">{billingErrorMessage(row.last_error) ?? row.last_error}</p>}
        {blocking.map((w) => (
          <p key={w} className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle size={12} aria-hidden /> {warningLabel(w)}
          </p>
        ))}
        {other.length > 0 && <p className="text-xs text-muted-foreground">{other.map(warningLabel).join(" · ")}</p>}
      </button>
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold tabular-nums">{formatCurrency(row.plan.totals.invoice)}</p>
        {row.plan.coupon.total > 0 && <p className="text-xs text-muted-foreground">Cupón {formatCurrency(row.plan.coupon.total)}</p>}
        {row.plan.shipping.line && <p className="text-xs text-muted-foreground">Envío {formatCurrency(row.plan.shipping.amount)}</p>}
      </div>
    </li>
  );
}
