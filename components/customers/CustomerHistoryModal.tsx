"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { CalendarClock, Heart, Mail, MessageCircle, Package, RotateCcw } from "lucide-react";
import {
  useCustomerHistory,
  useCustomerLastSaleItems,
  useCustomerUpcomingAppointments,
} from "@/modules/customers/hooks";
import { useCustomerPackCredits } from "@/modules/packs/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import { customersApi, type Customer } from "@/modules/customers/api";

// Recordatorio manual del próximo turno por WhatsApp (como los links de
// cumpleaños · BirthdaysModal). El ENVÍO automático queda como follow-up (cron
// de emails). Sólo dígitos para el deep-link de wa.me.
function waLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

// Recordatorio manual por email (mailto). Asunto + cuerpo prearmados.
function mailtoLink(email: string, subject: string, body: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function formatApptWhen(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SALE_STATUS: Record<string, string> = {
  completed: "Completada",
  voided: "Anulada",
  suspended: "Suspendida",
};

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDueDate(ms: number): string {
  return new Date(ms).toLocaleDateString("es-AR");
}

// Historial del cliente (H31): saldo a favor, compras y devoluciones.
export function CustomerHistoryModal({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer: Customer | null;
}) {
  const router = useRouter();
  const { data, isLoading } = useCustomerHistory(open ? customer?.id : null);
  // Packs de sesiones del cliente (H41): todos (no sólo disponibles) para mostrar
  // también los agotados/vencidos en el historial.
  const { data: packCredits } = useCustomerPackCredits(
    open ? customer?.id : null,
    false,
  );
  // Recompra rápida (H40): última venta del cliente (para habilitar "Repetir
  // última venta") y próximos turnos (reusa H38).
  const { data: lastSale } = useCustomerLastSaleItems(open ? customer?.id : null);
  const { data: upcoming } = useCustomerUpcomingAppointments(
    open ? customer?.id : null,
  );
  const { data: numFmt } = useSaleNumberFormat();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [payAmount, setPayAmount] = useState("");

  // preferences (H40) aún no está en el tipo Customer (no se regeneran tipos).
  const preferences =
    (customer as unknown as { preferences?: string | null } | null)?.preferences ??
    null;
  const hasLastSale = (lastSale?.items.length ?? 0) > 0;

  // Lleva al POS con la última venta cargada en el carrito (?repeat=<id>).
  function repeatLastSale() {
    if (!customer) return;
    onOpenChange(false);
    router.push(`/pos?repeat=${customer.id}`);
  }

  const payDebt = useMutation({
    mutationFn: () => customersApi.payDebt(customer!.id, Number(payAmount) || 0),
    onSuccess: () => {
      setPayAmount("");
      qc.invalidateQueries({ queryKey: ["customers", "history", customer?.id] });
      toast({ title: "Pago registrado", variant: "success" });
    },
    onError: () => toast({ title: "No se pudo registrar el pago", variant: "error" }),
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={customer ? `Historial · ${customer.name}` : "Historial"}
      className="max-w-lg"
    >
      {isLoading || !data ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <div className="space-y-5">
          {/* Recompra rápida (H40): repetir la última venta del cliente. Carga
              sus ítems al carrito del POS (precio actual; omite los dados de
              baja) y deja al cliente seleccionado, listo para cobrar. */}
          <Button
            type="button"
            className="w-full"
            disabled={!hasLastSale}
            onClick={repeatLastSale}
          >
            <RotateCcw size={16} />
            {hasLastSale ? "Repetir última venta" : "Sin ventas para repetir"}
          </Button>
          {hasLastSale && lastSale && (
            <p className="-mt-3 text-center text-xs text-muted-foreground">
              Última: {formatSaleNumber(lastSale.saleNumber, numFmt)} ·{" "}
              {new Date(lastSale.createdAt).toLocaleDateString("es-AR")} ·{" "}
              {lastSale.items.length} ítem(s)
            </p>
          )}

          {/* Preferencias / gustos del cliente (H40): se muestran si hay. */}
          {preferences && preferences.trim() && (
            <div className="rounded-lg border border-ninja-flame/25 bg-ninja-flame/[0.06] px-4 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ninja-flameSoft">
                <Heart size={13} /> Preferencias
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {preferences}
              </p>
            </div>
          )}

          {/* Saldo a favor + deuda */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
              <div className="text-xs text-muted-foreground">Saldo a favor (vale)</div>
              <div
                className={
                  data.creditBalance > 0
                    ? "font-price text-lg font-black tabular-nums text-emerald-400"
                    : "font-price text-lg font-black tabular-nums text-foreground"
                }
              >
                {formatCurrency(data.creditBalance)}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
              <div className="text-xs text-muted-foreground">Deuda (cuenta corriente)</div>
              <div
                className={
                  data.accountDebt > 0
                    ? "font-price text-lg font-black tabular-nums text-red-400"
                    : "font-price text-lg font-black tabular-nums text-foreground"
                }
              >
                {formatCurrency(data.accountDebt)}
              </div>
              {data.accountDebt > 0 && data.nextDue != null && (
                data.nextDue < startOfToday() ? (
                  <div className="mt-1 text-xs text-red-400">
                    Vencido desde {formatDueDate(data.nextDue)}
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Próximo vencimiento: {formatDueDate(data.nextDue)}
                  </div>
                )
              )}
            </div>
          </div>

          {data.accountDebt > 0 && (
            <div className="flex items-end gap-2 rounded-lg border border-border p-3">
              <label className="flex-1 text-xs text-muted-foreground">
                Registrar pago de deuda
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder={formatCurrency(data.accountDebt)}
                  className="mt-1"
                />
              </label>
              <Button
                disabled={
                  payDebt.isPending ||
                  !(Number(payAmount) > 0)
                }
                onClick={() => payDebt.mutate()}
              >
                {payDebt.isPending ? "Registrando…" : "Cobrar deuda"}
              </Button>
            </div>
          )}

          {/* Paquetes / sesiones (H41): packs activos del cliente con sesiones
              restantes y vencimiento. Se oculta si el cliente no tiene packs. */}
          {(packCredits ?? []).length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Package size={13} className="text-ninja-flameSoft" />
                Paquetes ({(packCredits ?? []).length})
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {(packCredits ?? []).map((c) => {
                  const exhausted = c.sessions_left <= 0;
                  const inactive = exhausted || c.expired;
                  return (
                    <div
                      key={c.id}
                      className={
                        inactive
                          ? "flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm opacity-70"
                          : "flex items-center justify-between gap-2 rounded-md border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2 text-sm"
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {c.pack_name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {c.sessions_used} de {c.sessions_total} usadas
                          {c.expires_at
                            ? ` · ${c.expired ? "venció" : "vence"} ${new Date(
                                c.expires_at,
                              ).toLocaleDateString("es-AR")}`
                            : " · sin vencimiento"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        {c.expired && !exhausted ? (
                          <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-warning">
                            Vencido
                          </span>
                        ) : exhausted ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                            Sin sesiones
                          </span>
                        ) : (
                          <span className="font-price text-base font-black tabular-nums text-emerald-400">
                            {c.sessions_left}
                            <span className="ml-1 text-xs font-medium text-muted-foreground">
                              {c.sessions_left === 1 ? "sesión" : "sesiones"}
                            </span>
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Próximos turnos (H40, reusa H38): turnos futuros del cliente. Se
              oculta si no tiene (clientes/rubros sin agenda no ven la sección).
              Link de recordatorio manual por WhatsApp/email (como cumpleaños);
              el envío automático queda como follow-up del cron de emails. */}
          {(upcoming ?? []).length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <CalendarClock size={13} className="text-ninja-flameSoft" />
                Próximos turnos ({(upcoming ?? []).length})
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {(upcoming ?? []).map((a) => {
                  const reminder = `Hola ${customer?.name ?? ""}, te recordamos tu turno de ${a.service_name} el ${formatApptWhen(a.starts_at)}.`;
                  return (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">
                          {a.service_name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {formatApptWhen(a.starts_at)}
                          {a.professionals?.name ? ` · ${a.professionals.name}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {customer?.phone && (
                          <a
                            href={waLink(customer.phone, reminder)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Recordar por WhatsApp"
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-emerald-400/15 hover:text-success"
                          >
                            <MessageCircle size={15} />
                          </a>
                        )}
                        {customer?.email && (
                          <a
                            href={mailtoLink(
                              customer.email,
                              `Recordatorio de turno · ${a.service_name}`,
                              reminder,
                            )}
                            title="Recordar por email"
                            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                          >
                            <Mail size={15} />
                          </a>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Compras */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compras ({data.sales.length})
            </div>
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {data.sales.length === 0 && (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  Sin compras.
                </p>
              )}
              {data.sales.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="font-mono">{formatSaleNumber(s.number, numFmt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleDateString("es-AR")}
                  </span>
                  <span
                    className={
                      s.status === "voided"
                        ? "text-xs text-danger"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {SALE_STATUS[s.status] ?? s.status}
                  </span>
                  <span className="font-semibold">{formatCurrency(s.total)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Devoluciones */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Devoluciones ({data.returns.length})
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {data.returns.length === 0 && (
                <p className="py-3 text-center text-sm text-muted-foreground">
                  Sin devoluciones.
                </p>
              )}
              {data.returns.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="font-mono">Dev #{r.number}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.refund_method === "store_credit" ? "Vale" : "Efectivo"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString("es-AR")}
                  </span>
                  <span className="font-semibold">{formatCurrency(r.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
