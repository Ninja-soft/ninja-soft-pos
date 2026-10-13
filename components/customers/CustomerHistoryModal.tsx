"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useFeature } from "@/modules/saas/gating";
import {
  CalendarClock,
  Heart,
  Mail,
  MessageCircle,
  Package,
  RotateCcw,
  UserRound,
  Wallet,
} from "lucide-react";
import {
  useCustomerBranchStats,
  useCustomerHistory,
  useCustomerLastSaleItems,
  useCustomerUpcomingAppointments,
} from "@/modules/customers/hooks";
import { useCustomerPackCredits } from "@/modules/packs/hooks";
import { useSaleNumberFormat } from "@/modules/sales/hooks";
import { formatCurrency } from "@/lib/utils/format";
import { formatSaleNumber } from "@/lib/utils/saleNumber";
import type { Customer } from "@/modules/customers/api";
import { SpinnerBlock } from "@/components/ui/Spinner";
import { BranchDot } from "@/components/branches/BranchSwitcher";
import { useBranchContext } from "@/modules/branches/hooks";
import { branchLabel } from "@/modules/branches/logic";

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
  const branchCtx = useBranchContext();
  // Filtro de compras por sucursal (F17 · H96). "" = todas las que veo.
  const [storeFilter, setStoreFilter] = useState("");
  useEffect(() => {
    if (!open) setStoreFilter("");
  }, [open, customer?.id]);
  const multi = branchCtx.isMulti;
  const { data, isLoading } = useCustomerHistory(
    open ? customer?.id : null,
    multi && storeFilter ? storeFilter : null,
  );
  const { data: branchStats } = useCustomerBranchStats(open ? customer?.id : null, multi);
  // store_id_alta (ADR-057) todavía no está en los tipos generados.
  const altaId =
    (customer as unknown as { store_id_alta?: string | null } | null)?.store_id_alta ??
    branchStats?.storeIdAlta ??
    null;
  const altaBranch = altaId ? (branchCtx.all.find((b) => b.id === altaId) ?? null) : null;
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
  const accountEnabled = useFeature("cuenta_corriente");

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

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={customer ? `Historial · ${customer.name}` : "Historial"}
      className="max-w-lg"
    >
      {isLoading || !data ? (
        <SpinnerBlock className="py-6" label="Cargando historial" />
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
            <div className="rounded-xl bg-ninja-flame/[0.08] px-4 py-3">
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
                    ? "font-price text-lg font-black tabular-nums text-success"
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
                    ? "font-price text-lg font-black tabular-nums text-danger"
                    : "font-price text-lg font-black tabular-nums text-foreground"
                }
              >
                {formatCurrency(data.accountDebt)}
              </div>
              {data.accountDebt > 0 && data.nextDue != null && (
                data.nextDue < startOfToday() ? (
                  <div className="mt-1 text-xs text-danger">
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

          {/* H31b: ficha completa del cliente (página propia). */}
          {customer && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                router.push(`/clientes/${customer.id}`);
              }}
            >
              <UserRound size={16} /> Ver ficha completa
            </Button>
          )}

          {/* Cuenta corriente v2: el cobro (con medio, caja, recibo e imputación),
              el estado de cuenta y la cobranza viven en la ficha de cuenta. */}
          {accountEnabled !== false && customer && (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                onOpenChange(false);
                router.push(`/clientes/cuentas/${customer.id}`);
              }}
            >
              <Wallet size={16} />
              {data.accountDebt > 0 ? "Cobrar y ver cuenta corriente" : "Ver cuenta corriente"}
            </Button>
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
                          ? "flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm opacity-70"
                          : "flex items-center justify-between gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm"
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
                          <span className="font-price text-base font-black tabular-nums text-success">
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

          {/* Sucursales (F17 · H96): alta y compras por sucursal. El cliente es
              del negocio: compra y paga en cualquiera. */}
          {multi && (altaBranch || (branchStats?.byStore.length ?? 0) > 0) && (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sucursales
                </span>
                {altaBranch && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Alta en
                    <BranchDot branch={altaBranch} />
                    <span className="font-medium text-foreground">{branchLabel(altaBranch)}</span>
                  </span>
                )}
              </div>
              {branchStats && branchStats.byStore.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">Sucursal</th>
                        <th className="px-2 py-1.5 text-right font-medium">Compras</th>
                        <th className="px-2 py-1.5 text-right font-medium">Total</th>
                        <th className="hidden px-2 py-1.5 text-right font-medium sm:table-cell">Ticket prom.</th>
                        <th className="px-3 py-1.5 text-right font-medium">Última</th>
                      </tr>
                    </thead>
                    <tbody>
                      {branchStats.byStore.map((r) => (
                        <tr key={r.storeId} className="border-t border-border">
                          <td className="px-3 py-1.5">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <BranchDot branch={{ color: r.color }} />
                              <span className="truncate">{r.shortName || r.name}</span>
                            </span>
                            {r.returnsTotal > 0 && (
                              <span className="block text-[11px] text-muted-foreground">
                                Devoluciones {formatCurrency(r.returnsTotal)}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{r.count}</td>
                          <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatCurrency(r.total)}
                          </td>
                          <td className="hidden px-2 py-1.5 text-right tabular-nums sm:table-cell">
                            {formatCurrency(r.avgTicket)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                            {r.lastAt ? new Date(r.lastAt).toLocaleDateString("es-AR") : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Compras */}
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Compras ({data.sales.length})
              </span>
              {multi && branchCtx.allowed.length > 1 && (
                <select
                  value={storeFilter}
                  onChange={(e) => setStoreFilter(e.target.value)}
                  aria-label="Filtrar compras por sucursal"
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ninja-flameSoft"
                >
                  <option value="">Todas las sucursales</option>
                  {branchCtx.allowed.map((b) => (
                    <option key={b.id} value={b.id}>
                      {branchLabel(b)}
                    </option>
                  ))}
                </select>
              )}
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
                    {multi && s.store_id && !storeFilter && (
                      <span className="ml-1.5">· {branchCtx.branchName(s.store_id)}</span>
                    )}
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
