"use client";

// Formularios de Tesorería (F18 · H111, ADR-059): cuenta, movimiento manual o
// transferencia entre cuentas, cheque de terceros en cartera y acciones sobre
// un cheque (depositar, marcar debitado, rechazar).

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import { isValidCuit } from "@/lib/purchases/suppliers";
import { actionLabel, type ChequeStatus } from "@/lib/treasury/cheques";
import { useStores } from "@/modules/stock/hooks";
import { useTreasuryAccounts, useTreasuryMutations } from "@/modules/treasury/hooks";
import type { Cheque, TreasuryAccount } from "@/modules/treasury/api";
import {
  ErrorList,
  FormField,
  fmtDate,
  inputCls,
  parseNum,
  selectCls,
  textareaCls,
  today,
} from "@/components/purchases/shared";

function Footer({
  onCancel,
  onSave,
  loading,
  disabled,
  label,
}: {
  onCancel: () => void;
  onSave: () => void;
  loading: boolean;
  disabled: boolean;
  label: string;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onCancel}>
        Cancelar
      </Button>
      <Button onClick={onSave} loading={loading} disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

// ── Cuenta ──────────────────────────────────────────────────────────────────

export function AccountFormModal({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: TreasuryAccount | null;
}) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: stores = [] } = useStores();
  const [f, setF] = useState({
    kind: "bank" as "bank" | "cash",
    name: "",
    store_id: "",
    bank_name: "",
    account_number: "",
    cbu: "",
    alias: "",
    opening_balance: "",
    opening_date: today(),
    notes: "",
  });

  useEffect(() => {
    if (!open) return;
    setF({
      kind: account?.kind ?? "bank",
      name: account?.name ?? "",
      store_id: account?.store_id ?? "",
      bank_name: account?.bank_name ?? "",
      account_number: account?.account_number ?? "",
      cbu: account?.cbu ?? "",
      alias: account?.alias ?? "",
      opening_balance: account ? String(account.opening_balance).replace(".", ",") : "",
      opening_date: account?.opening_date ?? today(),
      notes: account?.notes ?? "",
    });
  }, [open, account]);

  const cbu = f.cbu.replace(/\D/g, "");
  const errors = [
    ...(!f.name.trim() ? ["Poné un nombre a la cuenta."] : []),
    ...(f.kind === "bank" && cbu && cbu.length !== 22 ? ["El CBU tiene 22 dígitos."] : []),
    ...(f.kind === "bank" && f.alias && !/^[A-Za-z0-9.-]{6,20}$/.test(f.alias.trim())
      ? ["El alias tiene de 6 a 20 letras, números, puntos o guiones."]
      : []),
  ];

  async function save() {
    if (errors.length) return;
    try {
      await m.saveAccount.mutateAsync({
        id: account?.id ?? null,
        input: {
          kind: f.kind,
          name: f.name.trim(),
          store_id: f.store_id || null,
          bank_name: f.kind === "bank" ? f.bank_name : null,
          account_number: f.kind === "bank" ? f.account_number : null,
          cbu: f.kind === "bank" ? cbu : null,
          alias: f.kind === "bank" ? f.alias.trim() : null,
          currency: account?.currency ?? "ARS",
          opening_balance: parseNum(f.opening_balance),
          opening_date: f.opening_date,
          is_active: account?.is_active ?? true,
          notes: f.notes,
        },
      });
      toast({ title: account ? "Cuenta actualizada" : "Cuenta creada", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={account ? "Editar cuenta" : "Nueva cuenta"}
      className="sm:max-w-xl"
      footer={
        <Footer
          onCancel={() => onOpenChange(false)}
          onSave={() => void save()}
          loading={m.saveAccount.isPending}
          disabled={errors.length > 0}
          label="Guardar"
        />
      }
    >
      <div className="space-y-4">
        <Segmented<"bank" | "cash">
          aria-label="Tipo de cuenta"
          value={f.kind}
          onChange={(v) => setF((p) => ({ ...p, kind: v }))}
          size="sm"
          options={[
            { value: "bank", label: "Banco" },
            { value: "cash", label: "Caja general / caja fuerte" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Nombre" className="sm:col-span-2">
            <input className={inputCls} maxLength={80} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
          </FormField>
          {f.kind === "bank" && (
            <>
              <FormField label="Banco">
                <input className={inputCls} maxLength={80} value={f.bank_name} onChange={(e) => setF((p) => ({ ...p, bank_name: e.target.value }))} />
              </FormField>
              <FormField label="N° de cuenta">
                <input
                  className={inputCls}
                  maxLength={40}
                  value={f.account_number}
                  onChange={(e) => setF((p) => ({ ...p, account_number: e.target.value }))}
                />
              </FormField>
              <FormField label="CBU">
                <input inputMode="numeric" className={inputCls} value={f.cbu} onChange={(e) => setF((p) => ({ ...p, cbu: e.target.value }))} />
              </FormField>
              <FormField label="Alias">
                <input className={inputCls} value={f.alias} onChange={(e) => setF((p) => ({ ...p, alias: e.target.value }))} />
              </FormField>
            </>
          )}
          <FormField label="Sucursal (opcional)">
            <select className={cn(selectCls, "h-10")} value={f.store_id} onChange={(e) => setF((p) => ({ ...p, store_id: e.target.value }))}>
              <option value="" className="bg-popover text-popover-foreground">
                Del negocio
              </option>
              {stores.map((s) => (
                <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                  {s.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Saldo inicial">
            <input
              inputMode="decimal"
              className={cn(inputCls, "text-right")}
              value={f.opening_balance}
              onChange={(e) => setF((p) => ({ ...p, opening_balance: e.target.value }))}
            />
          </FormField>
          <FormField label="Fecha del saldo inicial">
            <input
              type="date"
              className={inputCls}
              value={f.opening_date}
              onChange={(e) => setF((p) => ({ ...p, opening_date: e.target.value }))}
            />
          </FormField>
          <FormField label="Notas (opcional)" className="sm:col-span-2">
            <textarea className={textareaCls} maxLength={500} value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} />
          </FormField>
        </div>
        <ErrorList errors={errors} />
      </div>
    </Modal>
  );
}

// ── Movimiento o transferencia ─────────────────────────────────────────────

type MovementMode = "deposit" | "withdrawal" | "transfer" | "adjustment";

export function MovementFormModal({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  accountId: string | null;
}) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: accounts = [] } = useTreasuryAccounts({}, open);
  const active = accounts.filter((a) => a.is_active);
  const [mode, setMode] = useState<MovementMode>("deposit");
  const [account, setAccount] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("deposit");
    setAccount(accountId ?? "");
    setTo("");
    setAmount("");
    setDirection("in");
    setDate(today());
    setDescription("");
  }, [open, accountId]);

  const errors = [
    ...(!account ? ["Elegí la cuenta."] : []),
    ...(!(parseNum(amount) > 0) ? ["Cargá un importe mayor a cero."] : []),
    ...(mode === "transfer" && (!to || to === account) ? ["Elegí otra cuenta de destino."] : []),
    ...(mode === "adjustment" && !description.trim() ? ["Escribí el motivo del ajuste."] : []),
  ];

  async function save() {
    if (errors.length) return;
    try {
      if (mode === "transfer") {
        await m.transfer.mutateAsync({ from: account, to, amount: parseNum(amount), date, description: description.trim() || null });
      } else {
        await m.createMovement.mutateAsync({
          account_id: account,
          type: mode,
          amount: parseNum(amount),
          direction: mode === "adjustment" ? direction : undefined,
          date,
          description: description.trim() || null,
        });
      }
      toast({ title: "Movimiento registrado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const busy = m.transfer.isPending || m.createMovement.isPending;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Movimiento de tesorería"
      className="sm:max-w-xl"
      footer={
        <Footer onCancel={() => onOpenChange(false)} onSave={() => void save()} loading={busy} disabled={errors.length > 0} label="Registrar" />
      }
    >
      <div className="space-y-4">
        <Segmented<MovementMode>
          aria-label="Tipo"
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: "deposit", label: "Ingreso" },
            { value: "withdrawal", label: "Egreso" },
            { value: "transfer", label: "Transferencia" },
            { value: "adjustment", label: "Ajuste" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={mode === "transfer" ? "Desde" : "Cuenta"}>
            <select className={cn(selectCls, "h-10")} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="" className="bg-popover text-popover-foreground">
                Elegí una cuenta
              </option>
              {active.map((a) => (
                <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>
          {mode === "transfer" ? (
            <FormField label="Hacia">
              <select className={cn(selectCls, "h-10")} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="" className="bg-popover text-popover-foreground">
                  Elegí una cuenta
                </option>
                {active
                  .filter((a) => a.id !== account)
                  .map((a) => (
                    <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                      {a.name}
                    </option>
                  ))}
              </select>
            </FormField>
          ) : mode === "adjustment" ? (
            <FormField label="Sentido">
              <select
                className={cn(selectCls, "h-10")}
                value={direction}
                onChange={(e) => setDirection(e.target.value as "in" | "out")}
              >
                <option value="in" className="bg-popover text-popover-foreground">
                  Suma al saldo
                </option>
                <option value="out" className="bg-popover text-popover-foreground">
                  Resta del saldo
                </option>
              </select>
            </FormField>
          ) : (
            <span />
          )}
          <FormField label="Importe">
            <input inputMode="decimal" className={cn(inputCls, "text-right")} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Fecha">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label={mode === "adjustment" ? "Motivo" : "Descripción (opcional)"} className="sm:col-span-2">
            <input className={inputCls} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
          </FormField>
        </div>
        <ErrorList errors={amount || account ? errors : []} />
      </div>
    </Modal>
  );
}

// ── Cheque de terceros ─────────────────────────────────────────────────────

export function ChequeFormModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const [f, setF] = useState({
    number: "",
    bank_name: "",
    issue_date: today(),
    payment_date: today(),
    amount: "",
    drawer_name: "",
    drawer_cuit: "",
    received_from: "",
    is_echeq: false,
    notes: "",
  });
  useEffect(() => {
    if (open)
      setF({
        number: "",
        bank_name: "",
        issue_date: today(),
        payment_date: today(),
        amount: "",
        drawer_name: "",
        drawer_cuit: "",
        received_from: "",
        is_echeq: false,
        notes: "",
      });
  }, [open]);

  const cuit = f.drawer_cuit.replace(/\D/g, "");
  const errors = [
    ...(!f.number.trim() ? ["Cargá el número del cheque."] : []),
    ...(!(parseNum(f.amount) > 0) ? ["Cargá el importe."] : []),
    ...(!f.payment_date ? ["Cargá la fecha de pago."] : []),
    ...(cuit && !isValidCuit(cuit) ? ["El CUIT del librador no es válido."] : []),
  ];

  async function save() {
    if (errors.length) return;
    try {
      await m.registerCheque.mutateAsync({
        number: f.number.trim(),
        bank_name: f.bank_name.trim() || null,
        issue_date: f.issue_date || null,
        payment_date: f.payment_date,
        amount: parseNum(f.amount),
        drawer_name: f.drawer_name.trim() || null,
        drawer_cuit: cuit || null,
        received_from: f.received_from.trim() || null,
        is_echeq: f.is_echeq,
        notes: f.notes.trim() || null,
      });
      toast({ title: "Cheque en cartera", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cheque de terceros"
      description="Entra a cartera: después lo depositás o lo entregás en una orden de pago."
      className="sm:max-w-xl"
      footer={
        <Footer
          onCancel={() => onOpenChange(false)}
          onSave={() => void save()}
          loading={m.registerCheque.isPending}
          disabled={errors.length > 0}
          label="Registrar"
        />
      }
    >
      <div className="space-y-4">
        <Segmented<"cheque" | "echeq">
          aria-label="Tipo"
          value={f.is_echeq ? "echeq" : "cheque"}
          onChange={(v) => setF((p) => ({ ...p, is_echeq: v === "echeq" }))}
          size="sm"
          options={[
            { value: "cheque", label: "Cheque físico" },
            { value: "echeq", label: "E-cheq" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Número">
            <input className={inputCls} maxLength={30} value={f.number} onChange={(e) => setF((p) => ({ ...p, number: e.target.value }))} />
          </FormField>
          <FormField label="Banco">
            <input className={inputCls} maxLength={80} value={f.bank_name} onChange={(e) => setF((p) => ({ ...p, bank_name: e.target.value }))} />
          </FormField>
          <FormField label="Fecha de emisión">
            <input type="date" className={inputCls} value={f.issue_date} onChange={(e) => setF((p) => ({ ...p, issue_date: e.target.value }))} />
          </FormField>
          <FormField label="Fecha de pago">
            <input type="date" className={inputCls} value={f.payment_date} onChange={(e) => setF((p) => ({ ...p, payment_date: e.target.value }))} />
          </FormField>
          <FormField label="Importe">
            <input inputMode="decimal" className={cn(inputCls, "text-right")} value={f.amount} onChange={(e) => setF((p) => ({ ...p, amount: e.target.value }))} />
          </FormField>
          <FormField label="Recibido de (cliente u otro)">
            <input className={inputCls} maxLength={120} value={f.received_from} onChange={(e) => setF((p) => ({ ...p, received_from: e.target.value }))} />
          </FormField>
          <FormField label="Librador">
            <input className={inputCls} maxLength={120} value={f.drawer_name} onChange={(e) => setF((p) => ({ ...p, drawer_name: e.target.value }))} />
          </FormField>
          <FormField label="CUIT del librador">
            <input inputMode="numeric" className={inputCls} value={f.drawer_cuit} onChange={(e) => setF((p) => ({ ...p, drawer_cuit: e.target.value }))} />
          </FormField>
        </div>
        <ErrorList errors={f.number || f.amount ? errors : []} />
      </div>
    </Modal>
  );
}

// ── Acción sobre un cheque ─────────────────────────────────────────────────

export function ChequeActionModal({
  cheque,
  to,
  onOpenChange,
}: {
  cheque: Cheque | null;
  to: ChequeStatus | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: accounts = [] } = useTreasuryAccounts({}, Boolean(cheque));
  const banks = accounts.filter((a) => a.is_active && a.kind === "bank");
  const [account, setAccount] = useState("");
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!cheque) return;
    setAccount(cheque.account_id ?? "");
    setDate(today());
    setReason("");
  }, [cheque]);

  const needsAccount = to === "depositado" && cheque?.kind === "third_party";
  const errors = [
    ...(needsAccount && !account ? ["Elegí la cuenta bancaria donde lo depositás."] : []),
    ...(to === "rechazado" && !reason.trim() ? ["Escribí el motivo del rechazo."] : []),
  ];

  async function save() {
    if (!cheque || !to || errors.length) return;
    try {
      await m.transitionCheque.mutateAsync({
        id: cheque.id,
        to,
        p: { account_id: needsAccount ? account : null, date, reason: reason.trim() || null },
      });
      toast({ title: "Cheque actualizado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo actualizar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={Boolean(cheque && to)}
      onOpenChange={onOpenChange}
      title={cheque && to ? `${actionLabel(cheque.kind, to)} cheque N° ${cheque.number}` : "Cheque"}
      description={cheque ? `${formatCurrency(cheque.amount)} · paga ${fmtDate(cheque.payment_date)}` : undefined}
      className="sm:max-w-md"
      footer={
        <Footer
          onCancel={() => onOpenChange(false)}
          onSave={() => void save()}
          loading={m.transitionCheque.isPending}
          disabled={errors.length > 0}
          label="Confirmar"
        />
      }
    >
      <div className="space-y-3">
        {needsAccount && (
          <FormField label="Cuenta bancaria">
            <select className={cn(selectCls, "h-10")} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="" className="bg-popover text-popover-foreground">
                Elegí una cuenta
              </option>
              {banks.map((a) => (
                <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                  {a.name}
                </option>
              ))}
            </select>
          </FormField>
        )}
        <FormField label="Fecha">
          <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        {to === "rechazado" && (
          <FormField label="Motivo">
            <input className={inputCls} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        )}
        {to === "rechazado" && cheque?.status === "depositado" && (
          <p className="text-xs text-muted-foreground">Se revierte el movimiento del depósito o débito en la cuenta.</p>
        )}
        {to === "rechazado" && cheque?.payment_id && (
          <p className="text-xs text-warning">
            Este cheque se entregó en una orden de pago: pedile al proveedor la nota de débito o anulá la orden.
          </p>
        )}
        <ErrorList errors={errors} />
      </div>
    </Modal>
  );
}
