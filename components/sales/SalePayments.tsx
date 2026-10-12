"use client";

// Pestaña "Cobros" del detalle de la venta (ADR-061): cada cobro con su
// procesador, tarjeta, cupón, comercio, terminal, ids, estado de conciliación,
// línea de tiempo y los datos que informa el procesador. Se actualiza sola
// (sondeo) mientras haya cobros pendientes o plata por acreditar.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { CardBrandLogo, ThemedLogo } from "@/components/ui/ThemedLogo";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { paymentIcon } from "@/lib/payments/logos";
import { normalizeCardBrand } from "@/lib/payments/terminal/normalize";
import { useMyTenant } from "@/modules/tenants/hooks";
import { useSalePaymentIntents } from "@/modules/sales/providerData";
import { ProcessorDataPanel } from "@/components/sales/ProcessorDataPanel";
import {
  isLocalOnly,
  methodLabel,
  needsLivePolling,
  paymentFields,
  paymentProviderKey,
  paymentTimeline,
  providerName,
  voucherInfo,
  type PaymentIntentRow,
  type SalePaymentRow,
} from "@/lib/sales/paymentDetail";

const time = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function toRow(p: Record<string, unknown>): SalePaymentRow {
  return {
    id: String(p.id),
    method: String(p.method ?? ""),
    amount: Number(p.amount ?? 0),
    reference: typeof p.reference === "string" ? p.reference : null,
    created_at: String(p.created_at ?? ""),
    card_voucher: p.card_voucher && typeof p.card_voucher === "object" ? (p.card_voucher as Record<string, unknown>) : null,
    reconciled_at: typeof p.reconciled_at === "string" ? p.reconciled_at : null,
  };
}

export function SalePayments({
  saleId,
  saleCreatedAt,
  initialPayments,
  active,
}: {
  saleId: string;
  saleCreatedAt: string;
  initialPayments: unknown[];
  active: boolean;
}) {
  const { data: me } = useMyTenant();
  const canSeeFees = Boolean(me?.canManage || me?.role === "owner" || me?.role === "manager");
  const [live, setLive] = useState(true);

  // Cobros de la venta en vivo (conciliado, cupón editado).
  const payments = useQuery({
    queryKey: ["sales", "payments-live", saleId],
    enabled: active,
    refetchInterval: active ? (live ? 15_000 : 60_000) : false,
    initialData: initialPayments as Record<string, unknown>[],
    queryFn: async () => {
      const { data, error } = await createClient().from("payments").select("*").eq("sale_id", saleId);
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, unknown>[];
    },
  });
  const rows = useMemo(() => (payments.data ?? []).map(toRow), [payments.data]);
  const intentsQ = useSalePaymentIntents(
    saleId,
    rows.map((r) => r.reference),
    { enabled: active, live: active && live },
  );
  const intents = intentsQ.data?.intents ?? [];
  const terminals = intentsQ.data?.terminals ?? {};
  const shouldPoll = needsLivePolling(intents, []);
  const fetched = intentsQ.isFetched || rows.every((r) => !r.reference);
  // Sondeo rápido sólo mientras algo puede cambiar.
  useEffect(() => {
    if (fetched) setLive(shouldPoll);
  }, [fetched, shouldPoll]);

  if (payments.isLoading) return <SpinnerBlock className="py-6" />;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Esta venta no tiene cobros.</p>;

  const total = rows.reduce((a, r) => a + r.amount, 0);
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">
          {rows.length === 1 ? "1 cobro" : `${rows.length} cobros`}
        </span>
        <span className="font-semibold tabular-nums">{formatCurrency(total)}</span>
      </div>
      {rows.map((p) => (
        <PaymentCard
          key={p.id}
          payment={p}
          intent={intents.find((i) => i.id === p.reference) ?? null}
          terminals={terminals}
          saleCreatedAt={saleCreatedAt}
          canSeeFees={canSeeFees}
          live={live}
        />
      ))}
    </div>
  );
}

function PaymentCard({
  payment,
  intent,
  terminals,
  saleCreatedAt,
  canSeeFees,
  live,
}: {
  payment: SalePaymentRow;
  intent: PaymentIntentRow | null;
  terminals: Record<string, string>;
  saleCreatedAt: string;
  canSeeFees: boolean;
  live: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const provider = paymentProviderKey(payment, intent);
  const provName = providerName(provider);
  const icon = provider ? paymentIcon(provider) : paymentIcon(payment.method);
  const v = voucherInfo(payment);
  const brandKey = normalizeCardBrand(v.brand);
  const terminalName = intent?.payment_terminal_id ? (terminals[intent.payment_terminal_id] ?? null) : null;
  const fields = paymentFields(payment, intent, terminalName);
  const timeline = paymentTimeline(payment, intent, saleCreatedAt);
  const local = isLocalOnly(payment.method) && !intent;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border bg-background">
          {icon ? <ThemedLogo src={icon} alt={provName ?? methodLabel(payment.method)} className="h-6 w-6" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{methodLabel(payment.method)}</span>
            {provName && <span className="text-sm text-muted-foreground">{provName}</span>}
          </div>
          {(v.brand || v.last4) && (
            <div className="mt-1 flex items-center gap-2 text-sm">
              {brandKey && <CardBrandLogo brand={brandKey} label={v.brand ?? undefined} height={14} />}
              <span>{v.brand}</span>
              {v.last4 && <span className="font-mono text-xs text-muted-foreground">**** {v.last4}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-semibold tabular-nums">{formatCurrency(payment.amount)}</span>
          {payment.reconciled_at ? (
            <Badge tone="success">Conciliado</Badge>
          ) : intent?.status === "pending" ? (
            <Badge tone="warning">Pendiente</Badge>
          ) : !local ? (
            <Badge tone="neutral">Sin conciliar</Badge>
          ) : null}
        </div>
      </div>

      {fields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border px-3 py-3 text-sm sm:grid-cols-3">
          {fields.map((f) => (
            <div key={f.key} className={cn("min-w-0", f.copy && "col-span-2 sm:col-span-3")}>
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{f.label}</dt>
              <dd className={cn("flex min-w-0 items-center gap-1.5", f.mono && "font-mono text-xs")}>
                <span className="truncate">{f.value}</span>
                {f.copy && <CopyButton value={f.value} label={f.label} />}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {!local && timeline.length > 0 && (
        <ol className="space-y-1.5 border-t border-border px-3 py-3 text-sm">
          {timeline.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  s.tone === "success" ? "bg-success" : s.tone === "warning" ? "bg-warning" : s.tone === "danger" ? "bg-danger" : "bg-muted-foreground/50",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{time(s.at)}</span>
            </li>
          ))}
        </ol>
      )}

      {intent && (
        <div className="border-t border-border p-3">
          <ProcessorDataPanel
            paymentId={payment.id}
            providerLabel={provName}
            canSeeFees={canSeeFees}
            requested={requested}
            onRequest={() => setRequested(true)}
            live={live}
          />
        </div>
      )}
      {local && fields.length === 0 && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Cobro registrado en el POS, sin procesador.
        </p>
      )}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        });
      }}
      className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      aria-label={`Copiar ${label}`}
      title="Copiar"
    >
      {ok ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
