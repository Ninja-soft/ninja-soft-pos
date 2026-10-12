"use client";

import { useState } from "react";
import { Lock, Pencil, Plus, Star, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { UpgradeModal } from "@/components/saas/UpgradeModal";
import { BankLogo } from "@/components/payments/BankLogo";
import { cn } from "@/lib/utils/cn";
import { cbuLabel, formatCbu, isMpCvuAccount, transferErrorMessage, type TransferAccount } from "@/lib/payments/transfer";
import { useTransferAccounts, useTransferMultiAccount, useTransferMutations } from "@/modules/payments/transfer";
import { TransferAccountModal } from "./TransferAccountModal";
import { TransferAutoDetectModal } from "./TransferAutoDetectModal";

// Configuración de la transferencia (ADR-055): cuentas donde se recibe, si el
// POS muestra la pantalla con los datos al cobrar y si pide el n° de
// operación. Por sucursal o caja se ajusta desde el selector de alcance.

export function TransferAccountsSetup({
  showScreen,
  requireReference,
}: {
  showScreen: boolean;
  requireReference: boolean;
}) {
  const { toast } = useToast();
  const { data: accounts = [], isFetched, isError } = useTransferAccounts();
  const multi = useTransferMultiAccount();
  const mut = useTransferMutations();
  const [editing, setEditing] = useState<TransferAccount | null | "new">(null);
  const [removing, setRemoving] = useState<TransferAccount | null>(null);
  const [auto, setAuto] = useState<TransferAccount | null>(null);
  const [upgrade, setUpgrade] = useState(false);

  const live = accounts.filter((a) => a.is_active);
  const canAdd = multi || live.length === 0;
  const onErr = (e: unknown) => toast({ title: transferErrorMessage(e), variant: "error" });

  const saveSettings = (patch: { showScreen?: boolean; requireReference?: boolean }) =>
    mut.settings.mutate(
      { showScreen: patch.showScreen ?? showScreen, requireReference: patch.requireReference ?? requireReference },
      { onError: onErr },
    );

  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Las cuentas para transferencias todavía no están disponibles. Probá de nuevo en un rato.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Mostrar pantalla de transferencia al cobrar</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Muestra banco, titular, CBU / CVU y alias (también en la pantalla del cliente). Apagada, la transferencia
              cierra el ticket directo.
            </p>
          </div>
          <Switch
            checked={showScreen}
            onCheckedChange={(c) => saveSettings({ showScreen: c })}
            disabled={mut.settings.isPending}
            label="Mostrar pantalla de transferencia al cobrar"
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Pedir número de operación</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              El cajero carga el n° del comprobante para conciliar. Sin número no se registra la transferencia.
            </p>
          </div>
          <Switch
            checked={requireReference}
            onCheckedChange={(c) => saveSettings({ requireReference: c })}
            disabled={mut.settings.isPending}
            label="Pedir número de operación"
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Cuentas para recibir
        </p>
        {isFetched && accounts.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            Las cuentas de Mercado Pago (CVU) pueden detectar solas las transferencias que entran: tocá el rayo de la
            cuenta. Sólo para cuentas de Mercado Pago (CVU).
          </p>
        )}
        {isFetched && accounts.length === 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            Cargá tu cuenta para que el POS muestre tus datos al cobrar. Sin cuentas, la transferencia se registra igual.
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {accounts.map((a) => (
            <li key={a.id} className={cn("flex items-center gap-3 px-3 py-2.5", !a.is_active && "opacity-60")}>
              <BankLogo slug={a.bank_slug} customUrl={a.custom_logo_url} name={a.bank_name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
                  <span className="truncate">{a.bank_name}</span>
                  {a.is_default && (
                    <span className="inline-flex h-5 items-center rounded-md bg-success/10 px-1.5 text-[11px] font-semibold text-success">
                      Por defecto
                    </span>
                  )}
                  {a.auto_detect && isMpCvuAccount(a) && (
                    <span className="inline-flex h-5 items-center gap-1 rounded-md bg-info/10 px-1.5 text-[11px] font-semibold text-info">
                      <Zap size={11} aria-hidden /> Automática
                    </span>
                  )}
                  {a.currency === "USD" && (
                    <span className="inline-flex h-5 items-center rounded-md bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                      USD
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {a.holder_name}
                  {a.alias ? ` · ${a.alias}` : ""}
                </p>
                {a.cbu && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {cbuLabel(a.cbu)} {formatCbu(a.cbu)}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {!a.is_default && a.is_active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    aria-label={`Usar ${a.bank_name} por defecto`}
                    title="Usar por defecto"
                    onClick={() => mut.patch.mutate({ id: a.id, patch: { is_default: true } }, { onError: onErr })}
                  >
                    <Star size={15} aria-hidden />
                  </Button>
                )}
                {isMpCvuAccount(a) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    aria-label={`Detección automática de ${a.bank_name}`}
                    title="Detectar transferencias automáticamente"
                    onClick={() => setAuto(a)}
                  >
                    <Zap size={15} aria-hidden />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  aria-label={`Editar ${a.bank_name}`}
                  onClick={() => setEditing(a)}
                >
                  <Pencil size={15} aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  aria-label={`Eliminar ${a.bank_name}`}
                  onClick={() => setRemoving(a)}
                >
                  <Trash2 size={15} aria-hidden />
                </Button>
                <Switch
                  checked={a.is_active}
                  onCheckedChange={(c) => {
                    if (c && !multi && live.length > 0) return setUpgrade(true);
                    mut.patch.mutate({ id: a.id, patch: { is_active: c } }, { onError: onErr });
                  }}
                  label={`Mostrar ${a.bank_name} al cobrar`}
                  className="ml-1"
                />
              </div>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => (canAdd ? setEditing("new") : setUpgrade(true))}
              className="flex w-full items-center gap-2 px-3 py-3 text-left text-sm font-semibold transition hover:bg-fg-4"
            >
              {canAdd ? <Plus size={16} aria-hidden /> : <Lock size={15} aria-hidden />}
              {accounts.length === 0 ? "Agregar cuenta" : "Agregar otra cuenta"}
              {!canAdd && <span className="text-xs font-normal text-muted-foreground">Desde un plan superior</span>}
            </button>
          </li>
        </ul>
      </div>

      <TransferAccountModal
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        account={editing === "new" ? null : editing}
        isFirst={live.length === 0}
      />
      <TransferAutoDetectModal account={auto} onOpenChange={(o) => !o && setAuto(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Eliminar cuenta"
        description={
          removing
            ? `${removing.bank_name} deja de mostrarse al cobrar. Las ventas ya cobradas conservan los datos de la cuenta.`
            : undefined
        }
        confirmLabel="Eliminar"
        danger
        loading={mut.remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          mut.remove.mutate(removing.id, { onSuccess: () => setRemoving(null), onError: onErr });
        }}
      />
      {upgrade && (
        <UpgradeModal
          open
          onOpenChange={(o) => !o && setUpgrade(false)}
          featureKey="transferencia_multicuenta"
          featureLabel="Varias cuentas de transferencia"
        />
      )}
    </div>
  );
}
