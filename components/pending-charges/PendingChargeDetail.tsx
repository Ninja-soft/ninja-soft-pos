"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  ExternalLink,
  Pencil,
  Printer,
  RefreshCw,
  Share2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { LocalQr } from "@/components/pos/LocalQr";
import { SharePanel } from "@/components/pending-charges/SharePanel";
import { paymentIcon } from "@/lib/payments/logos";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { cn } from "@/lib/utils/cn";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { useStaffDirectory, useBranchContext } from "@/modules/branches/hooks";
import { useTicketBranding } from "@/modules/tickets/hooks";
import { brandDisplayName } from "@/lib/branding/businessName";
import {
  usePendingCharge,
  usePendingChargeEvents,
  usePendingChargeMutations,
} from "@/modules/pending-charges/hooks";
import {
  chargeActions,
  defaultTtlMinutes,
  effectiveStatus,
  expiresLabel,
  extendOptions,
  isValidEmail,
  pendingChargeErrorCopy,
  STATUS_LABEL,
  STATUS_TONE,
  type PendingCharge,
  type PendingChargeEvent,
} from "@/modules/pending-charges/logic";

export const PROVIDER_LABEL: Record<string, string> = {
  mercadopago: "Mercado Pago",
  mobbex: "Mobbex",
  modo: "MODO",
  pagos360: "Pagos360",
  payway: "Payway",
  getnet: "Getnet",
  nave: "Nave",
  gocuotas: "GO Cuotas",
  directo: "Directo",
  ualabis: "Ualá Bis",
  viumi: "Viumi",
};

export const TONE_BADGE: Record<string, BadgeTone> = {
  info: "info",
  warning: "warning",
  success: "success",
  muted: "neutral",
  danger: "danger",
};

const VIA_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "email",
  sms: "SMS",
  copy: "link copiado",
  native: "compartir del sistema",
  qr: "QR",
};

function eventText(e: PendingChargeEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const money = (v: unknown) => formatCurrency(Number(v) || 0);
  switch (e.kind) {
    case "created":
      return `Cobro en espera creado por ${money(d.amount)}`;
    case "shared":
      return `Compartido por ${VIA_LABEL[String(d.via)] ?? String(d.via)}${d.to ? ` a ${String(d.to)}` : ""}`;
    case "edited":
      return `Editado: ${money(d.old_amount)} → ${money(d.new_amount)}, link nuevo`;
    case "regenerated":
      return "Link regenerado";
    case "extended":
      return "Vencimiento extendido";
    case "updated":
      return "Datos del cobro actualizados";
    case "paid":
      return `Pago acreditado por ${money(d.amount)}`;
    case "payment_rejected":
      return "El proveedor rechazó un intento de pago";
    case "completed":
      return `Venta registrada${d.number ? ` (#${String(d.number)})` : ""}`;
    case "completion_failed":
      return `No se pudo registrar la venta: ${String(d.error ?? "error")}`;
    case "cancelled":
      return `Cancelado${d.reason ? `: ${String(d.reason)}` : ""}`;
    case "expired":
      return d.reason === "provider" ? "El proveedor dio de baja el link" : "Venció el link";
    case "carried_over":
      return "Pasado a la próxima apertura de caja";
    case "attached_to_shift":
      return "Enganchado al turno de caja abierto";
    case "paid_after_cancel":
      return `Pago tardío de ${money(d.amount)} sobre un cobro cerrado`;
    case "old_intent_paid":
      return `Se pagó un link anterior por ${money(d.amount)}`;
    case "acknowledged":
      return "Aviso marcado como visto";
    default:
      return e.kind;
  }
}

function needsReviewCopy(c: PendingCharge): string {
  if (c.last_error === "paid_after_cancel")
    return "El cliente pagó un cobro que estaba cancelado o vencido. Registrá la venta (si todavía tenés la mercadería) o devolvé el dinero desde el proveedor.";
  if (c.last_error === "superseded_intent_paid")
    return "El cliente pagó un link que ya habías reemplazado. Revisalo en Ventas → Cobros QR antes de cobrar de nuevo.";
  if (c.last_error === "amount_mismatch")
    return "El proveedor acreditó un monto menor al del cobro. Revisalo antes de registrar la venta.";
  return "Este cobro necesita revisión.";
}

export function PendingChargeDetail({
  chargeId,
  open,
  onOpenChange,
  onEditInPos,
  onPrint,
  canForce,
}: {
  chargeId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Cargar el carrito en el POS para editarlo (sólo en espera o vencido). */
  onEditInPos?: (c: PendingCharge) => void;
  /** Imprimir el ticket de la venta creada. */
  onPrint?: (saleId: string) => void;
  /** Dueño o encargado: puede registrar la venta de un cobro en revisión. */
  canForce: boolean;
}) {
  const { toast } = useToast();
  const { data: c, isLoading } = usePendingCharge(open ? chargeId : null);
  const { data: events } = usePendingChargeEvents(open ? chargeId : null);
  const { data: numFmt } = useSaleNumberFormat();
  const { data: people } = useStaffDirectory();
  const { data: branding } = useTicketBranding(open);
  const branch = useBranchContext();
  const m = usePendingChargeMutations();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [editData, setEditData] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people ?? []) if (p.userId) map.set(p.userId, p.name);
    return map;
  }, [people]);

  const status = c ? effectiveStatus(c) : null;
  const actions = c ? chargeActions(c) : null;
  const fail = (e: unknown) =>
    toast({ title: pendingChargeErrorCopy(e instanceof Error ? e.message : ""), variant: "error" });

  async function run<T>(fn: () => Promise<T>, ok: string) {
    try {
      await fn();
      toast({ title: ok, variant: "success" });
    } catch (e) {
      fail(e);
    }
  }

  function startEditData() {
    if (!c) return;
    setForm({
      name: c.customer_name ?? "",
      email: c.customer_email ?? "",
      phone: c.customer_phone ?? "",
      notes: c.notes ?? "",
    });
    setEditData(true);
  }

  async function saveData() {
    if (!c) return;
    if (form.email.trim() && !isValidEmail(form.email)) {
      toast({ title: "El email no es válido", variant: "error" });
      return;
    }
    await run(
      () =>
        m.update.mutateAsync({
          charge: c,
          patch: {
            customer_name: form.name,
            customer_email: form.email,
            customer_phone: form.phone,
            notes: form.notes,
          },
        }),
      "Datos guardados",
    );
    setEditData(false);
  }

  const logo = c ? paymentIcon(c.provider_key) : null;
  const title = c
    ? `${formatCurrency(c.amount)}${c.customer_name ? ` · ${c.customer_name}` : ""}`
    : "Cobro en espera";

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        className="sm:max-w-2xl"
        header={
          c ? (
            <div className="flex items-start gap-3">
              {logo && <ThemedLogo src={logo} alt={PROVIDER_LABEL[c.provider_key] ?? c.provider_key} className="mt-1 h-8 w-auto" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="price-hl font-price text-2xl font-black tabular-nums">{formatCurrency(c.amount)}</span>
                  {status && <Badge tone={TONE_BADGE[STATUS_TONE[status]]}>{STATUS_LABEL[status]}</Badge>}
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {c.customer_name || "Sin cliente"} · {PROVIDER_LABEL[c.provider_key] ?? c.provider_key}
                  {branch.isMulti && branch.branchName(c.store_id) ? ` · ${branch.branchName(c.store_id)}` : ""}
                </p>
              </div>
            </div>
          ) : undefined
        }
      >
        {isLoading || !c ? (
          <div className="flex justify-center py-10">
            <Spinner size={24} />
          </div>
        ) : (
          <div className="space-y-5">
            {c.needs_review && (
              <div className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>{needsReviewCopy(c)}</span>
              </div>
            )}
            {status === "paid" && !c.needs_review && (
              <div className="flex gap-2 rounded-xl bg-warning/10 p-3 text-sm text-warning">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  El cliente ya pagó y la venta todavía no se registró
                  {c.last_error === "no_open_shift"
                    ? ": no hay una caja abierta en la sucursal. Se registra sola al abrir la caja."
                    : c.last_error
                      ? ` (${c.last_error}). Se reintenta sola; también podés reintentar ahora.`
                      : "."}
                </span>
              </div>
            )}

            {/* Estado y vencimiento */}
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <Info label="Creado" value={formatRelative(c.created_at)} />
              <Info
                label={status === "waiting" ? "Vence" : "Vencimiento"}
                value={status === "waiting" ? expiresLabel(c.expires_at) : new Date(c.expires_at).toLocaleString("es-AR")}
              />
              <Info
                label="Venta"
                value={
                  c.sale_number != null ? `#${formatSaleNumber(c.sale_number, numFmt ?? null)}` : status === "paid" ? "Pendiente" : "-"
                }
              />
            </div>

            {/* Link y QR para compartir de nuevo */}
            {status === "waiting" && (c.share_url || c.qr_data) && (
              <div className="flex flex-col items-center gap-3 rounded-xl bg-fg-4 p-4 sm:flex-row sm:items-start">
                <LocalQr value={c.qr_data || c.share_url || ""} label="QR de pago" size={150} />
                <div className="w-full min-w-0 flex-1 space-y-2">
                  {c.share_url && (
                    <a
                      href={c.share_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 break-all text-xs text-ninja-flameSoft hover:underline"
                    >
                      <ExternalLink size={13} className="shrink-0" aria-hidden /> {c.share_url}
                    </a>
                  )}
                  {c.shared_via.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Compartido por {c.shared_via.map((v) => VIA_LABEL[v] ?? v).join(", ")}
                    </p>
                  )}
                  {actions?.reshare && (
                    <Button size="sm" variant={shareOpen ? "secondary" : "ghost"} onClick={() => setShareOpen((v) => !v)}>
                      <Share2 size={14} aria-hidden /> Volver a compartir
                    </Button>
                  )}
                </div>
              </div>
            )}
            {shareOpen && c.share_url && status === "waiting" && (
              <SharePanel
                url={c.share_url}
                amountLabel={formatCurrency(c.amount)}
                businessName={branding ? brandDisplayName(branding, "") || null : null}
                customerName={c.customer_name}
                customerPhone={c.customer_phone}
                customerEmail={c.customer_email}
                onShared={(via, to) => m.markShared.mutate({ id: c.id, via, to })}
                onServerEmail={(to, note) => m.sendEmail.mutateAsync({ id: c.id, to, note })}
              />
            )}

            {/* Cliente */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Cliente y notas</h3>
                {!editData && status !== "completed" && status !== "cancelled" && (
                  <Button size="sm" variant="ghost" onClick={startEditData}>
                    <Pencil size={13} aria-hidden /> Editar datos
                  </Button>
                )}
              </div>
              {editData ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  <Input label="Celular" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  <Input label="Nota interna" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  <div className="flex justify-end gap-2 sm:col-span-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditData(false)}>
                      Cancelar
                    </Button>
                    <Button size="sm" loading={m.update.isPending} onClick={saveData}>
                      Guardar
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <Info label="Nombre" value={c.customer_name || "Sin cliente"} />
                  <Info label="Contacto" value={[c.customer_email, c.customer_phone].filter(Boolean).join(" · ") || "-"} />
                  {c.notes && <Info label="Nota" value={c.notes} className="sm:col-span-2" />}
                </div>
              )}
            </section>

            {/* Detalle de la compra */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Qué se está cobrando</h3>
              <div className="divide-y divide-border rounded-xl border border-border">
                {c.lines.map((l, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate">{l.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {l.quantity} x {formatCurrency(l.unit_price)}
                        {l.variant ? ` · ${l.variant}` : ""}
                        {l.discount > 0 ? ` · desc. ${formatCurrency(l.discount)}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(l.subtotal)}</span>
                  </div>
                ))}
                <div className="flex justify-between px-3 py-2 text-sm font-bold">
                  <span>Total a cobrar</span>
                  <span className="tabular-nums">{formatCurrency(c.amount)}</span>
                </div>
                {c.paid_amount != null && Math.abs(c.paid_amount - c.amount) > 0.009 && (
                  <div className="flex justify-between px-3 py-2 text-sm text-muted-foreground">
                    <span>Pagado</span>
                    <span className="tabular-nums">{formatCurrency(c.paid_amount)}</span>
                  </div>
                )}
              </div>
            </section>

            {/* Línea de tiempo */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Línea de tiempo</h3>
              <ol className="space-y-2 border-l border-border pl-4">
                {(events ?? []).map((e) => (
                  <li key={e.id} className="relative text-sm">
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full",
                        e.kind === "completed" || e.kind === "paid"
                          ? "bg-success"
                          : e.kind.includes("fail") || e.kind.includes("after") || e.kind === "old_intent_paid"
                            ? "bg-warning"
                            : "bg-muted-foreground/50",
                      )}
                    />
                    <span>{eventText(e)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {new Date(e.created_at).toLocaleString("es-AR")}
                      {e.actor_user_id ? ` · ${names.get(e.actor_user_id) ?? "Usuario"}` : " · Sistema"}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Acciones */}
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              {actions?.print && c.sale_id && onPrint && (
                <Button size="sm" onClick={() => onPrint(c.sale_id!)}>
                  <Printer size={14} aria-hidden /> Imprimir ticket
                </Button>
              )}
              {actions?.openSale && c.sale_id && (
                <Link href="/ventas" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold hover:bg-secondary/60">
                  <ExternalLink size={14} aria-hidden /> Ver en Ventas
                </Link>
              )}
              {actions?.retry && !c.needs_review && (
                <Button
                  size="sm"
                  loading={m.complete.isPending}
                  onClick={() =>
                    run(async () => {
                      const r = await m.complete.mutateAsync({ id: c.id });
                      if (r.status !== "completed") throw new Error(r.error ?? "not_completed");
                    }, "Venta registrada")
                  }
                >
                  <RefreshCw size={14} aria-hidden /> Reintentar registrar la venta
                </Button>
              )}
              {actions?.retry && c.needs_review && canForce && (
                <Button
                  size="sm"
                  loading={m.complete.isPending}
                  onClick={() =>
                    run(async () => {
                      const r = await m.complete.mutateAsync({ id: c.id, force: true });
                      if (r.status !== "completed") throw new Error(r.error ?? "not_completed");
                    }, "Venta registrada")
                  }
                >
                  <RefreshCw size={14} aria-hidden /> Registrar la venta igual
                </Button>
              )}
              {actions?.edit && onEditInPos && (
                <Button size="sm" variant="secondary" onClick={() => onEditInPos(c)}>
                  <Pencil size={14} aria-hidden /> Editar en el POS
                </Button>
              )}
              {actions?.regenerate && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={m.regenerate.isPending}
                  onClick={() =>
                    run(
                      () => m.regenerate.mutateAsync({ charge: c, expiresMinutes: defaultTtlMinutes(c.provider_key) }),
                      "Link nuevo generado",
                    )
                  }
                >
                  <RefreshCw size={14} aria-hidden /> Regenerar link
                </Button>
              )}
              {actions?.extend && (
                <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-2 text-sm">
                  <CalendarClock size={14} aria-hidden />
                  <span className="sr-only">Extender vencimiento</span>
                  <select
                    className="bg-transparent text-sm outline-none"
                    value=""
                    onChange={(e) => {
                      const min = Number(e.target.value);
                      if (min > 0) {
                        void run(() => m.update.mutateAsync({ charge: c, patch: { extend_minutes: min } }), "Vencimiento extendido");
                      }
                    }}
                  >
                    <option value="">Extender…</option>
                    {extendOptions(c.provider_key).map((o) => (
                      <option key={o.minutes} value={o.minutes}>
                        {o.label} desde ahora
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {actions?.cancel && (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => setCancelOpen(true)}>
                  <Ban size={14} aria-hidden /> Cancelar cobro
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancelar el cobro en espera"
        description="El link deja de servir y la venta no se registra. Si el cliente igual llega a pagar, te avisamos para revisarlo."
        confirmLabel="Cancelar cobro"
        cancelLabel="Volver"
        danger
        withReason
        reasonLabel="Motivo"
        reasonPlaceholder="El cliente no va a pagar"
        loading={m.cancel.isPending}
        onConfirm={async (reason) => {
          if (!c) return;
          await run(() => m.cancel.mutateAsync({ charge: c, reason }), "Cobro cancelado");
          setCancelOpen(false);
        }}
      />
    </>
  );
}

function Info({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cn("rounded-lg bg-fg-4 px-3 py-2", className)}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 break-words">{value}</div>
    </div>
  );
}
