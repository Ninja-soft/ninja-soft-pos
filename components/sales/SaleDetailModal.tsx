"use client";

// Detalle de una venta (rediseño de /ventas): encabezado con el logo del
// negocio, productos con foto y variante, totales e impuestos, cobros con
// logo del medio y red de tarjeta, estado fiscal (CAE y QR), línea de tiempo
// y acciones. Sólo lectura: reusa los hooks existentes (detalle, impuestos,
// factura, promociones, reintegros MP, intents) y delega en TicketModal
// (ticket, cobros del procesador, email) y ReturnModal / void_sale.
import { useMemo } from "react";
import { Ban, CreditCard, Lock, Mail, Receipt, RotateCcw, ShieldCheck } from "lucide-react";
import { formatDateAr } from "@/lib/warranty/pricing";
import { todayAr } from "@/lib/catalog/mode";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton, SkeletonLines } from "@/components/ui/Skeleton";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { ProductThumb } from "@/components/products/ProductThumb";
import { PaymentLogo } from "@/components/sales/SalePaymentLogo";
import { FiscalStatus } from "@/components/arca/FiscalStatus";
import { useSaleDetail } from "@/modules/sales/hooks";
import { useSaleDetailExtras, useSalesExtras } from "@/modules/sales/listExtras";
import { useSalePaymentIntents } from "@/modules/sales/providerData";
import { useSaleMpRefunds } from "@/modules/sales/mpRefund";
import { useSaleTaxLines } from "@/modules/tax/hooks";
import { useSaleFiscalDocuments } from "@/modules/arca/hooks";
import { useSalePromotions } from "@/modules/promotions/hooks";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { brandDisplayName } from "@/lib/branding/businessName";
import { useMyTenant } from "@/modules/tenants/hooks";
import { saleAlertBadges } from "@/lib/reports/paymentDisputes";
import { useSaleDisputes } from "@/modules/reports/paymentDisputes";
import { paymentFields, paymentProviderKey, providerName, methodLabel, voucherInfo, type SalePaymentRow } from "@/lib/sales/paymentDetail";
import { normalizeCardBrand } from "@/lib/payments/terminal/normalize";
import {
  absoluteDateTime,
  CHANNEL_LABEL,
  cuotasLabel,
  relativeTime,
  returnState,
  saleStatusBadge,
  saleTimeline,
  taxBreakdown,
  totalsBreakdown,
} from "@/lib/sales/salesList";
import { formatCurrency, formatQty } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  saleId: string | null;
  numberLabel: (n: number) => string;
  branchName: (id: string | null) => string | null;
  returnDenied: string | null;
  returnLocked: boolean;
  voidDenied: (saleDate: string) => string | null;
  onTicket: () => void;
  onCobros: () => void;
  onReturn: () => void;
  onVoid: (sale: { id: string; number: number }) => void;
}

type LooseSale = Record<string, unknown> & {
  id: string;
  number: number;
  created_at: string;
  status: string;
  total: number;
  subtotal: number;
  store_id: string;
  customer_id: string | null;
  cash_shift_id: string | null;
  created_by: string | null;
  receipt_emailed_at: string | null;
  receipt_email_to: string | null;
  voided_at: string | null;
  void_reason: string | null;
  customers: { name: string; email: string | null } | null;
};

type LooseItem = {
  id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  discount: number;
  returned_qty: number;
  variant_id: string | null;
  sku: string | null;
  serial: string | null;
  list_price?: number | null;
  promo_discount?: number | null;
  // ADR-139: garantía extendida enlazada (vencimiento guardado al vender).
  warranty_for_item_id?: string | null;
  warranty_expires_on?: string | null;
};

const toRow = (p: Record<string, unknown>): SalePaymentRow => ({
  id: String(p.id),
  method: String(p.method ?? ""),
  amount: Number(p.amount ?? 0),
  reference: typeof p.reference === "string" ? p.reference : null,
  created_at: String(p.created_at ?? ""),
  card_voucher: p.card_voucher && typeof p.card_voucher === "object" ? (p.card_voucher as Record<string, unknown>) : null,
  reconciled_at: typeof p.reconciled_at === "string" ? p.reconciled_at : null,
});

export function SaleDetailModal(props: Props) {
  const { open, saleId } = props;
  const { data, isLoading } = useSaleDetail(saleId, open);
  const sale = (data?.sale ?? null) as LooseSale | null;
  const items = (data?.items ?? []) as unknown as LooseItem[];
  const payments = useMemo(() => (data?.payments ?? []).map((p) => toRow(p as unknown as Record<string, unknown>)), [data?.payments]);

  const { data: me } = useMyTenant();
  const manager = Boolean(me?.canManage || me?.role === "owner" || me?.role === "manager");
  const extrasQ = useSalesExtras(sale ? [sale] : [], open && Boolean(sale));
  const extras = sale ? extrasQ.data?.bySale.get(sale.id) : undefined;
  const variantIds = [...new Set(items.map((i) => i.variant_id).filter((v): v is string => !!v))];
  const detailQ = useSaleDetailExtras(saleId, variantIds, open && Boolean(data));
  const taxLines = useSaleTaxLines(open ? saleId : null);
  const fiscalDocs = useSaleFiscalDocuments(open ? saleId : null);
  const promos = useSalePromotions(open ? saleId : null);
  const mpRefunds = useSaleMpRefunds(saleId, open);
  const disputes = useSaleDisputes(saleId ? [saleId] : [], open && manager);
  const intentsQ = useSalePaymentIntents(saleId, payments.map((p) => p.reference), { enabled: open, live: false });
  const intents = intentsQ.data?.intents ?? [];
  const { data: brand } = useTicketBranding(open, sale?.store_id ?? null);

  const imageOf = new Map((detailQ.data?.items ?? []).map((i) => [i.id, i.image_url]));
  const ret = returnState(items);
  const coveredName = (it: LooseItem) =>
    it.warranty_for_item_id ? (items.find((x) => x.id === it.warranty_for_item_id)?.product_name ?? null) : null;
  const status = sale ? saleStatusBadge(sale.status, ret) : null;
  const alerts = saleAlertBadges(disputes.data ?? []);
  const promoRows = (promos.data ?? []).map((p) => ({ label: p.label, amount: Number(p.discount) || 0 }));
  const totals = sale ? totalsBreakdown(sale as never, promoRows) : [];
  const taxes = sale ? taxBreakdown(sale as never, taxLines.data ?? []) : [];
  const timeline = sale
    ? saleTimeline({
        sale,
        intents,
        returns: detailQ.data?.returns ?? [],
        mpRefunds: mpRefunds.data ?? [],
        fiscal: fiscalDocs.data ?? [],
        formatMoney: formatCurrency,
      })
    : [];

  const numberLabel = sale ? props.numberLabel(sale.number) : "";
  // ADR-124: nombre de fantasía (o el de la cuenta) en la cabecera de la venta.
  const businessName = brand ? brandDisplayName(brand, "") || me?.name || null : me?.name || null;
  const customer = sale?.customers?.name?.trim() || null;
  const canReturn = sale?.status === "completed" && ret !== "full";
  const voidDenied = sale ? props.voidDenied(sale.created_at) : null;

  const header = sale ? (
    <div className="flex items-start gap-3">
      <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-background">
        {brand?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logo_url} alt={businessName ?? "Logo del negocio"} className="h-full w-full object-contain p-1" />
        ) : (
          <span className="text-lg font-bold text-muted-foreground">{(businessName ?? "N").charAt(0).toUpperCase()}</span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        {businessName && <p className="truncate text-xs text-muted-foreground">{businessName}</p>}
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-bold tracking-tight">Venta {numberLabel}</span>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
          {alerts.map((a) => (
            <Badge key={a.key} tone={a.tone} title={a.title}>
              {a.label}
            </Badge>
          ))}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {absoluteDateTime(sale.created_at)} · {relativeTime(sale.created_at)}
        </p>
      </div>
    </div>
  ) : undefined;

  const footer = sale ? (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-end">
      <Button variant="secondary" onClick={props.onTicket}>
        <Receipt size={16} /> Ticket
      </Button>
      <Button variant="secondary" onClick={props.onTicket} title="Enviar el comprobante por email desde el ticket">
        <Mail size={16} /> Email
      </Button>
      {canReturn && (
        <Button
          variant="secondary"
          onClick={props.returnDenied ? undefined : props.onReturn}
          aria-disabled={Boolean(props.returnDenied) || undefined}
          title={props.returnDenied ?? (props.returnLocked ? "Devoluciones: función no incluida en tu plan" : "Devolución o cambio")}
          className={cn(props.returnDenied && "cursor-not-allowed opacity-60")}
        >
          {props.returnDenied || props.returnLocked ? <Lock size={14} /> : <RotateCcw size={16} />} Devolver
        </Button>
      )}
      {sale.status === "completed" && (
        <Button
          variant="secondary"
          onClick={voidDenied ? undefined : () => props.onVoid({ id: sale.id, number: sale.number })}
          aria-disabled={Boolean(voidDenied) || undefined}
          title={voidDenied ?? "Anular la venta y reponer el stock"}
          className={cn("text-danger", voidDenied && "cursor-not-allowed opacity-60")}
        >
          {voidDenied ? <Lock size={14} /> : <Ban size={16} />} Anular
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <Modal
      open={open}
      onOpenChange={props.onOpenChange}
      title={sale ? `Venta ${numberLabel}` : "Detalle de la venta"}
      header={header}
      footer={footer}
      className="sm:max-w-3xl"
    >
      {isLoading || !sale ? (
        <div className="space-y-4" aria-busy>
          <Skeleton className="h-16 w-full" />
          <SkeletonLines lines={5} />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Datos de la venta */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-4">
            <Meta label="Cliente" value={customer ?? "Consumidor final"} />
            <Meta label="Canal" value={extras ? CHANNEL_LABEL[extras.channel] : null} loading={extrasQ.isLoading} />
            <Meta
              label="Sucursal y caja"
              value={[props.branchName(sale.store_id), extras?.registerName].filter(Boolean).join(" · ") || null}
              loading={extrasQ.isLoading}
            />
            <Meta label="Cajero" value={extras?.cashierName ?? null} loading={extrasQ.isLoading} />
          </dl>

          {/* Productos */}
          <section aria-labelledby="sd-items">
            <SectionTitle id="sd-items">
              Productos <span className="font-normal text-muted-foreground">· {items.length}</span>
            </SectionTitle>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {items.map((it) => {
                const variant = it.variant_id ? detailQ.data?.variants[it.variant_id] : null;
                const disc = (Number(it.discount) || 0) + (Number(it.promo_discount) || 0);
                const list = Number(it.list_price) || 0;
                const returned = Number(it.returned_qty) || 0;
                return (
                  <li key={it.id} className="flex items-start gap-3 p-3">
                    <ProductThumb src={imageOf.get(it.id) ?? null} size={48} className="border border-border" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium leading-snug">{it.product_name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {[variant, it.sku ? `SKU ${it.sku}` : null, it.serial ? `Serie ${it.serial}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                        {formatQty(it.quantity)} × {formatCurrency(it.unit_price)}
                        {list > Number(it.unit_price) + 0.009 && (
                          <span className="ml-1.5 line-through">{formatCurrency(list)}</span>
                        )}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {disc > 0 && <Badge tone="brand">Descuento {formatCurrency(disc)}</Badge>}
                        {it.warranty_expires_on && (
                          <Badge tone={it.warranty_expires_on.slice(0, 10) >= todayAr() ? "success" : "neutral"}>
                            <ShieldCheck size={12} aria-hidden />
                            {it.warranty_expires_on.slice(0, 10) >= todayAr() ? "Cubre hasta el " : "Venció el "}
                            {formatDateAr(it.warranty_expires_on)}
                            {coveredName(it) ? ` · ${coveredName(it)}` : ""}
                          </Badge>
                        )}
                        {returned > 0 && (
                          <Badge tone="warning">
                            {returned >= Number(it.quantity) ? "Devuelto" : `Devueltas ${formatQty(returned)}`}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(it.subtotal)}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Totales e impuestos */}
          <section aria-labelledby="sd-totals" className="grid gap-4 sm:grid-cols-2">
            <div>
              <SectionTitle id="sd-totals">Totales</SectionTitle>
              <dl className="space-y-1.5 text-sm">
                {totals.map((t) => (
                  <Row key={t.key} label={t.label} value={formatCurrency(t.amount)} muted={t.amount < 0} />
                ))}
                <div className="flex items-baseline justify-between border-t border-border pt-2">
                  <dt className="font-semibold">Total</dt>
                  <dd className={cn("text-xl font-bold tabular-nums", sale.status === "voided" && "line-through text-muted-foreground")}>
                    {formatCurrency(sale.total)}
                  </dd>
                </div>
              </dl>
            </div>
            {taxes.length > 0 && (
              <div>
                <SectionTitle>Impuestos</SectionTitle>
                <dl className="space-y-1.5 text-sm">
                  {taxes.map((t) => (
                    <Row key={t.key} label={t.label} value={formatCurrency(t.amount)} />
                  ))}
                </dl>
              </div>
            )}
          </section>

          {/* Cobros */}
          <section aria-labelledby="sd-pay">
            <div className="mb-2 flex items-center justify-between gap-2">
              <SectionTitle id="sd-pay" className="mb-0">
                Cobros
              </SectionTitle>
              <button
                type="button"
                onClick={props.onCobros}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <CreditCard size={15} aria-hidden /> Ver detalle del procesador
              </button>
            </div>
            {payments.length === 0 ? (
              <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">Esta venta no tiene cobros registrados.</p>
            ) : (
              <ul className="space-y-2">
                {payments.map((p) => {
                  const intent = intents.find((i) => i.id === p.reference) ?? null;
                  const provider = paymentProviderKey(p, intent);
                  const provName = providerName(provider);
                  const v = voucherInfo(p);
                  const brandKey = normalizeCardBrand(v.brand);
                  const fields = paymentFields(p, intent, null).filter((f) =>
                    ["cuotas", "autorizacion", "cupon", "lote", "reference", "provider_payment"].includes(f.key),
                  );
                  const name = methodLabel(p.method);
                  return (
                    <li key={p.id} className="rounded-lg border border-border">
                      <div className="flex items-center gap-3 p-3">
                        <PaymentLogo method={p.method} providerKey={provider} label={provName ?? name} size={36} />
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-x-2 font-semibold">
                            {name}
                            {provName && <span className="text-sm font-normal text-muted-foreground">{provName}</span>}
                          </p>
                          {(v.brand || v.last4 || v.cuotas) && (
                            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                              {brandKey && <CardBrandLogo brand={brandKey} label={v.brand ?? undefined} height={13} />}
                              {v.brand && <span className="text-foreground">{v.brand}</span>}
                              {v.last4 && <span className="font-mono text-xs">**** {v.last4}</span>}
                              {cuotasLabel(v.cuotas) && <span>· {cuotasLabel(v.cuotas)}</span>}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(p.amount)}</span>
                      </div>
                      {fields.filter((f) => f.key !== "cuotas").length > 0 && (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border px-3 py-2.5 text-sm sm:grid-cols-4">
                          {fields
                            .filter((f) => f.key !== "cuotas")
                            .map((f) => (
                              <div key={f.key} className="min-w-0">
                                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.label}</dt>
                                <dd className={cn("truncate", f.mono && "font-mono text-xs")}>{f.value}</dd>
                              </div>
                            ))}
                        </dl>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Estado fiscal (ADR-072): CAE, vencimiento, QR y reproceso. Sin
              comprobante, FiscalStatus ofrece emitir (dueño/encargado con ARCA). */}
          {(fiscalDocs.data ?? []).length > 0 ? (
            <section aria-labelledby="sd-fiscal">
              <SectionTitle id="sd-fiscal">Factura electrónica</SectionTitle>
              <FiscalStatus
                saleId={sale.id}
                docs={fiscalDocs.data ?? []}
                saleStatus={sale.status}
                nonFiscal={Boolean((sale as { non_fiscal?: boolean }).non_fiscal)}
              />
            </section>
          ) : manager && !fiscalDocs.isLoading ? (
            <FiscalStatus
              saleId={sale.id}
              docs={[]}
              saleStatus={sale.status}
              nonFiscal={Boolean((sale as { non_fiscal?: boolean }).non_fiscal)}
            />
          ) : null}

          {/* Línea de tiempo */}
          <section aria-labelledby="sd-timeline">
            <SectionTitle id="sd-timeline">Historial</SectionTitle>
            <ol className="relative space-y-3 pl-5">
              <span aria-hidden className="absolute bottom-1 left-[5px] top-1 w-px bg-border" />
              {timeline.map((s, i) => (
                <li key={`${s.label}-${i}`} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -left-5 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-popover",
                      s.tone === "success"
                        ? "bg-success"
                        : s.tone === "warning"
                          ? "bg-warning"
                          : s.tone === "danger"
                            ? "bg-danger"
                            : s.tone === "info"
                              ? "bg-info"
                              : "bg-muted-foreground/60",
                    )}
                  />
                  <p className="text-sm font-medium">{s.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {absoluteDateTime(s.at)}
                    {s.detail ? ` · ${s.detail}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </Modal>
  );
}

function SectionTitle({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <h3 id={id} className={cn("mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground", className)}>
      {children}
    </h3>
  );
}

function Meta({ label, value, loading }: { label: string; value: string | null; loading?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">
        {loading && !value ? <Skeleton className="h-4 w-20" /> : (value ?? <span className="font-normal text-muted-foreground">Sin dato</span>)}
      </dd>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>{value}</dd>
    </div>
  );
}
