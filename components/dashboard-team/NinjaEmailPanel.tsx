"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Check, Mail, Reply, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { emailAddonErrorMessage, quoteSummary, usageLevel, type EmailAddonQuote } from "@/lib/billing/emailAddon";
import { formatDay } from "@/lib/billing/ledger";
import { cn } from "@/lib/utils/cn";
import { formatCurrency, formatInt } from "@/lib/utils/format";
import {
  activateEmailAddon,
  cancelEmailAddon,
  quoteEmailAddon,
  setNinjaSender,
  type EmailAddonOffer,
} from "@/modules/saas/emailAddon";
import { syncSubscriptionAmount } from "@/modules/saas/subscriptionBilling";

// Email de NinjaSoft (@soft.ninja) en Configuración › Email del negocio
// (ADR-156): el dueño elige un escalón, ve cuánto paga hoy, en el próximo
// cobro y por mes, y lo suma a su suscripción con un botón. Después ve su uso
// del mes y puede cambiar de escalón o darlo de baja.

export const EMAIL_OFFER_QK = ["email-addon-offer"];

function fmtMoney(n: number) {
  return formatCurrency(n);
}

export function NinjaEmailPanel({ offer }: { offer: EmailAddonOffer }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const tiers = useMemo(() => offer.tiers ?? [], [offer.tiers]);
  const addon = offer.addon;
  const active = Boolean(addon?.usable);
  const ending = Boolean(addon?.cancel_at_period_end);
  const [picked, setPicked] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [quote, setQuote] = useState<EmailAddonQuote | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (picked) return;
    const current = addon?.tier_id && tiers.some((t) => t.id === addon.tier_id) ? addon.tier_id : null;
    setPicked(current ?? tiers[0]?.id ?? null);
  }, [tiers, addon?.tier_id, picked]);

  function refresh() {
    qc.invalidateQueries({ queryKey: EMAIL_OFFER_QK });
    qc.invalidateQueries({ queryKey: ["tenant-smtp-status"] });
    qc.invalidateQueries({ queryKey: ["my-subscription"] });
    qc.invalidateQueries({ queryKey: ["owner-billing-summary"] });
  }

  // El monto de Mercado Pago se actualiza después de cada cambio. Si falla,
  // el cron diario lo corrige antes del débito: se avisa igual.
  async function syncMp(): Promise<string | null> {
    if (offer.billing?.mode !== "mp_subscription" || !offer.billing?.has_preapproval) return null;
    try {
      const r = await syncSubscriptionAmount();
      return r.ok && r.amount ? `Tu débito de Mercado Pago quedó en ${fmtMoney(r.amount)}.` : null;
    } catch {
      return "No pudimos actualizar Mercado Pago ahora: lo reintentamos solos antes de tu próximo débito.";
    }
  }

  const askQuote = useMutation({
    mutationFn: (tierId: string) => quoteEmailAddon(tierId),
    onSuccess: (q) => setQuote(q),
    onError: (e: Error) => toast({ title: emailAddonErrorMessage(e.message), variant: "error" }),
  });

  const activate = useMutation({
    mutationFn: (q: EmailAddonQuote) => activateEmailAddon(q.tier.id, q.tier.price),
    onSuccess: async (res) => {
      const mpNote = await syncMp();
      toast({
        title:
          res.kind === "downgrade"
            ? "Listo, el cambio de escalón rige desde tu próximo período"
            : res.kind === "upgrade"
              ? "Listo, ya tenés el escalón nuevo"
              : `Listo, tus emails salen desde ${res.sender.from_email}`,
        description: mpNote ?? undefined,
        variant: "success",
      });
      setQuote(null);
      setChanging(false);
      refresh();
    },
    onError: (e: Error) => {
      toast({ title: emailAddonErrorMessage(e.message), variant: "error" });
      if (e.message === "price_changed") {
        setQuote(null);
        refresh();
      }
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelEmailAddon(),
    onSuccess: async () => {
      const mpNote = await syncMp();
      toast({ title: "Diste de baja el email de NinjaSoft", description: mpNote ?? undefined, variant: "success" });
      setConfirmCancel(false);
      refresh();
    },
    onError: (e: Error) => toast({ title: emailAddonErrorMessage(e.message), variant: "error" }),
  });

  const switchSender = useMutation({
    mutationFn: () => setNinjaSender(true),
    onSuccess: () => {
      toast({ title: "Tus emails vuelven a salir con NinjaSoft", variant: "success" });
      refresh();
    },
    onError: (e: Error) => toast({ title: emailAddonErrorMessage(e.message), variant: "error" }),
  });

  const sender = offer.sender;
  const usage = offer.usage;
  const level = usageLevel(usage?.sent ?? 0, usage?.quota ?? 0);
  const currentTier = tiers.find((t) => t.id === addon?.tier_id);
  const pendingTier = tiers.find((t) => t.id === addon?.pending_tier_id);
  const showPicker = !active || changing;
  const blockedStatus = offer.billing?.status === "suspended" || offer.billing?.status === "cancelled";
  const summary = quote ? quoteSummary(quote, fmtMoney, (d) => formatDay(d)) : null;

  return (
    <div className="space-y-4">
      {/* Así salen los emails */}
      <div className="rounded-xl bg-muted/40 p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ninja-flame/10 text-ninja-flameSoft">
            <Mail size={18} />
          </span>
          <div className="min-w-0 space-y-1 text-sm">
            <div className="font-semibold text-foreground">Tus emails salen desde</div>
            <div className="break-all font-mono text-foreground">{sender?.from_email ?? "tu-negocio@soft.ninja"}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Reply size={13} /> Las respuestas te llegan a {sender?.reply_to ?? "tu email"}
            </div>
          </div>
        </div>
        <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          {["Sin configurar servidores ni claves", "Dominio verificado: menos spam", "Comprobantes, presupuestos y avisos", "Se paga junto con tu suscripción"].map(
            (b) => (
              <li key={b} className="flex items-start gap-1.5">
                <Check size={13} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
                <span>{b}</span>
              </li>
            ),
          )}
        </ul>
      </div>

      {/* Contratado: estado y uso del mes */}
      {active && addon && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-foreground">{currentTier?.label ?? "Email de NinjaSoft"}</span>
              {addon.source === "granted" ? (
                <Badge tone="brand">Bonificado por NinjaSoft</Badge>
              ) : ending ? (
                <Badge tone="warning">Se da de baja el {formatDay(addon.current_period_end)}</Badge>
              ) : (
                <Badge tone="success">Activo</Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {formatInt(addon.quota ?? 0)} emails por mes
              {addon.source !== "granted" && addon.price ? ` · ${fmtMoney(addon.price)} por mes` : ""}
            </span>
          </div>
          <div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Este mes</span>
              <span>
                {formatInt(usage?.sent ?? 0)} de {formatInt(usage?.quota ?? addon.quota ?? 0)}
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={level.pct} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={cn("h-full rounded-full", level.level === "full" ? "bg-danger" : level.level === "warn" ? "bg-warning" : "bg-success")}
                style={{ width: `${level.pct}%` }}
              />
            </div>
            {(usage?.blocked ?? 0) > 0 && (
              <p className="mt-1.5 text-xs text-danger">
                {formatInt(usage!.blocked)} emails no salieron por el cupo. Pasá a un escalón más grande.
              </p>
            )}
            {(usage?.overage ?? 0) > 0 && (
              <p className="mt-1.5 text-xs text-warning">{formatInt(usage!.overage)} emails sobre el cupo este mes.</p>
            )}
          </div>
          {pendingTier && addon.pending_from && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock size={13} /> Desde el {formatDay(addon.pending_from)} pasás a {pendingTier.label}.
            </p>
          )}
          {!offer.using_ninjasoft && (
            <Callout tone="warning" icon={AlertTriangle}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>Tus emails están saliendo por otra cuenta.</span>
                <Button size="sm" loading={switchSender.isPending} onClick={() => switchSender.mutate()}>
                  Usar el de NinjaSoft
                </Button>
              </div>
            </Callout>
          )}
          {offer.is_owner && addon.source !== "granted" && !ending && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmCancel(true)}>
                Dar de baja
              </Button>
              {!changing && tiers.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => setChanging(true)}>
                  Cambiar escalón
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Elegir escalón */}
      {showPicker && !ending && (
        <div className="space-y-3">
          {tiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía no hay escalones disponibles.</p>
          ) : (
            <div role="radiogroup" aria-label="Escalón de emails" className="grid gap-2 sm:grid-cols-2">
              {tiers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={picked === t.id}
                  onClick={() => setPicked(t.id)}
                  className={choiceClass(picked === t.id, "flex items-center justify-between gap-3 p-3 pr-9 text-left")}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{t.label}</span>
                    <span className="block text-xs text-muted-foreground">{formatInt(t.quota)} emails por mes</span>
                    {addon?.tier_id === t.id && active && <span className="mt-1 block text-[11px] text-muted-foreground">Tu escalón actual</span>}
                  </span>
                  <span className="whitespace-nowrap text-right">
                    <span className="text-base font-black text-foreground">{fmtMoney(t.price)}</span>
                    <span className="block text-[11px] text-muted-foreground">por mes</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {offer.overage && offer.overage.policy === "charge" && offer.overage.block_price > 0 && (
            <p className="text-xs text-muted-foreground">
              Si pasás el cupo, los emails siguen saliendo y cada {formatInt(offer.overage.block_size)} adicionales se cobran{" "}
              {fmtMoney(offer.overage.block_price)} en tu próximo cobro.
            </p>
          )}
          {offer.overage?.policy === "block" && (
            <p className="text-xs text-muted-foreground">Al llegar al cupo te avisamos y los emails dejan de salir hasta el mes siguiente.</p>
          )}
          {offer.billing?.status === "trial" && !active && (
            <p className="text-xs text-muted-foreground">Estás en tu prueba gratis: no pagás nada hasta que termine.</p>
          )}
          {!offer.is_owner ? (
            <p className="text-xs text-muted-foreground">Sólo el dueño puede sumarlo a la suscripción.</p>
          ) : blockedStatus ? (
            <Callout tone="warning" icon={AlertTriangle}>
              Tu suscripción no está activa. Regularizala para sumar el email de NinjaSoft.
            </Callout>
          ) : offer.billing?.cancel_at_period_end ? (
            <Callout tone="warning" icon={AlertTriangle}>
              Tu suscripción tiene la baja programada. Reactivala para sumar complementos.
            </Callout>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              {changing && (
                <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                  Cancelar
                </Button>
              )}
              <Button
                disabled={!picked || (active && picked === addon?.tier_id && !addon?.pending_tier_id)}
                loading={askQuote.isPending}
                onClick={() => picked && askQuote.mutate(picked)}
              >
                <Sparkles size={15} /> {active ? "Ver el cambio" : "Agregar a mi suscripción"}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Confirmación del monto */}
      <Modal
        open={quote !== null}
        onOpenChange={(o) => !o && setQuote(null)}
        title={summary?.headline ?? ""}
        description={quote ? `${formatInt(quote.tier.quota)} emails por mes desde ${sender?.from_email ?? "@soft.ninja"}` : undefined}
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setQuote(null)}>
              Volver
            </Button>
            <Button loading={activate.isPending} onClick={() => quote && activate.mutate(quote)}>
              Confirmar
            </Button>
          </div>
        }
      >
        {summary && quote && (
          <div className="space-y-3 text-sm">
            <ul className="space-y-2">
              {summary.lines.map((l) => (
                <li key={l} className="flex items-start gap-2 text-muted-foreground">
                  <Check size={14} className="mt-0.5 shrink-0 text-ninja-flameSoft" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
              <span className="text-muted-foreground">{quote.cycle === "yearly" ? "Total por año" : "Total por mes"}</span>
              <span className="text-base font-black text-foreground">{fmtMoney(quote.cycle_total_after)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Lo podés dar de baja cuando quieras: sigue hasta el fin del período que pagaste y después no se cobra más.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="¿Dar de baja el email de NinjaSoft?"
        description={
          offer.billing?.current_period_end
            ? `Sigue funcionando hasta el ${formatDay(offer.billing.current_period_end)} y desde ahí no se cobra más. Después tus emails vuelven a salir por tu cuenta de correo.`
            : "Deja de cobrarse y tus emails vuelven a salir por tu cuenta de correo."
        }
        confirmLabel="Dar de baja"
        danger
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}
