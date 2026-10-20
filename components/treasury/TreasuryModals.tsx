"use client";

// Formularios de Tesorería (F18 · H111, ADR-059; F23 · H150 y H154, ADR-158):
// cuenta (caja general, banco o billetera, con sus cuentas de cobro por
// transferencia y su cuenta contable), movimiento manual o transferencia entre
// cuentas, gasto con categoría, comprobante y adjunto, cheque de terceros en
// cartera y acciones sobre un cheque (depositar, marcar debitado, rechazar).

import { useEffect, useState } from "react";
import { BookOpenCheck, Landmark, Link2, Paperclip } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { isValidCuit } from "@/lib/purchases/suppliers";
import { actionLabel, type ChequeStatus } from "@/lib/treasury/cheques";
import {
  ACCOUNT_CURRENCIES,
  SETTLEMENT_PROVIDERS,
  WALLET_PROVIDERS,
  canLinkTransfers,
  isSystemKind,
  providerLabel,
  treasuryErrorMessage,
} from "@/lib/treasury/accounts";
import { useStores } from "@/modules/stock/hooks";
import { ChequeDuplicateHint } from "./ChequeDuplicateHint";
import { useTransferAccounts } from "@/modules/payments/transfer";
import { useAccAccounts, useAccSettings, useAccountingAccess } from "@/modules/accounting/hooks";
import { useTreasuryAccounts, useTreasuryMutations } from "@/modules/treasury/hooks";
import { treasuryApi, type Cheque, type TreasuryAccount, type TreasuryPosition } from "@/modules/treasury/api";
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
  position = null,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: TreasuryAccount | null;
  /** Fila de Posición: cuentas de transferencia vinculadas y cuenta contable. */
  position?: TreasuryPosition | null;
}) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: stores = [] } = useStores();
  type EditableKind = "bank" | "cash" | "wallet";
  const [f, setF] = useState({
    kind: "bank" as EditableKind,
    provider_key: "mercadopago",
    name: "",
    store_id: "",
    bank_name: "",
    account_number: "",
    cbu: "",
    alias: "",
    opening_balance: "",
    opening_date: today(),
    notes: "",
    currency: "ARS",
  });

  useEffect(() => {
    if (!open) return;
    const k = account?.kind;
    setF({
      currency: account?.currency ?? "ARS",
      kind: k === "cash" || k === "wallet" ? k : "bank",
      provider_key: account?.provider_key ?? "mercadopago",
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

  const system = Boolean(account && (account.is_system || isSystemKind(account.kind)));
  // Con movimientos, el saldo inicial y su fecha quedan fijos (el servidor lo exige).
  const openingLocked = Boolean(account && position?.last_movement);
  const withBankData = f.kind === "bank" || f.kind === "wallet";
  const cbu = f.cbu.replace(/\D/g, "");
  const errors = [
    ...(!f.name.trim() ? ["Poné un nombre a la cuenta."] : []),
    ...(withBankData && cbu && cbu.length !== 22 ? ["El CBU o CVU tiene 22 dígitos."] : []),
    ...(withBankData && f.alias && !/^[A-Za-z0-9.-]{6,20}$/.test(f.alias.trim())
      ? ["El alias tiene de 6 a 20 letras, números, puntos o guiones."]
      : []),
  ];

  async function save() {
    if (errors.length || system) return;
    try {
      await m.saveAccount.mutateAsync({
        id: account?.id ?? null,
        input: {
          kind: f.kind,
          provider_key: f.kind === "wallet" ? f.provider_key : null,
          name: f.name.trim(),
          store_id: f.store_id || null,
          bank_name: f.kind === "bank" ? f.bank_name : null,
          account_number: f.kind === "bank" ? f.account_number : null,
          cbu: withBankData ? cbu : null,
          alias: withBankData ? f.alias.trim() : null,
          currency: openingLocked ? (account?.currency ?? "ARS") : f.currency,
          opening_balance: parseNum(f.opening_balance),
          opening_date: f.opening_date,
          is_active: account?.is_active ?? true,
          notes: f.notes,
        },
      });
      toast({
        title: account ? "Cuenta actualizada" : "Cuenta creada",
        description:
          !account && withBankData ? "Editala para vincular las cuentas donde te transfieren." : undefined,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={system ? account?.name ?? "Cuenta" : account ? "Editar cuenta" : "Nueva cuenta"}
      className="sm:max-w-xl"
      footer={
        system ? (
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </div>
        ) : (
          <Footer
            onCancel={() => onOpenChange(false)}
            onSave={() => void save()}
            loading={m.saveAccount.isPending}
            disabled={errors.length > 0}
            label="Guardar"
          />
        )
      }
    >
      {system ? (
        <p className="text-sm text-muted-foreground">
          {account?.kind === "pos_cash"
            ? "Esta cuenta es el cajón de una caja del POS. Se mueve sola con los turnos, las ventas en efectivo y los ingresos y retiros de caja."
            : "Esta cuenta junta lo que cobraste y el procesador todavía no acreditó. Baja sola cuando la liquidación se concilia."}
        </p>
      ) : (
        <div className="space-y-4">
          <Segmented<EditableKind>
            aria-label="Tipo de cuenta"
            value={f.kind}
            onChange={(v) => setF((p) => ({ ...p, kind: v }))}
            size="sm"
            scrollOnMobile
            options={[
              { value: "bank", label: "Banco" },
              { value: "wallet", label: "Billetera" },
              { value: "cash", label: "Caja general / caja fuerte" },
            ]}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Nombre" className="sm:col-span-2">
              <input className={inputCls} maxLength={80} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} />
            </FormField>
            {f.kind === "wallet" && (
              <FormField label="Billetera" className="sm:col-span-2">
                <select
                  className={cn(selectCls, "h-10")}
                  value={f.provider_key}
                  onChange={(e) => setF((p) => ({ ...p, provider_key: e.target.value }))}
                >
                  {WALLET_PROVIDERS.map((w) => (
                    <option key={w.key} value={w.key} className="bg-popover text-popover-foreground">
                      {w.label}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
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
              </>
            )}
            {withBankData && (
              <>
                <FormField label={f.kind === "wallet" ? "CVU (opcional)" : "CBU"}>
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
            <FormField label="Moneda">
              <select
                className={cn(selectCls, "h-10")}
                value={f.currency}
                disabled={openingLocked}
                onChange={(e) => setF((p) => ({ ...p, currency: e.target.value }))}
              >
                {ACCOUNT_CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code} className="bg-popover text-popover-foreground">
                    {c.label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label={f.currency === "ARS" ? "Saldo inicial" : `Saldo inicial (${f.currency})`}>
              <input
                inputMode="decimal"
                className={cn(inputCls, "text-right")}
                value={f.opening_balance}
                disabled={openingLocked}
                onChange={(e) => setF((p) => ({ ...p, opening_balance: e.target.value }))}
              />
            </FormField>
            <FormField label="Fecha del saldo inicial">
              <input
                type="date"
                className={inputCls}
                value={f.opening_date}
                disabled={openingLocked}
                onChange={(e) => setF((p) => ({ ...p, opening_date: e.target.value }))}
              />
            </FormField>
            {openingLocked ? (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                La cuenta ya tiene movimientos: el saldo inicial no se cambia. Si no coincide, cargá un ajuste.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Con la contabilidad activada, el saldo inicial arma su asiento de apertura en esa fecha
                {f.currency !== "ARS" ? ", pasado a pesos con la cotización del día" : ""}. La moneda queda fija cuando la
                cuenta tiene movimientos.
              </p>
            )}
            <FormField label="Notas (opcional)" className="sm:col-span-2">
              <textarea className={textareaCls} maxLength={500} value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} />
            </FormField>
          </div>
          <ErrorList errors={errors} />
          {account && canLinkTransfers(account.kind) && <TransferLinks account={account} position={position} />}
          {account && canLinkTransfers(account.kind) && <SettlementLinks account={account} />}
          {account && <LedgerLink account={account} position={position} />}
        </div>
      )}
    </Modal>
  );
}

// Cuentas de cobro por transferencia vinculadas (H150): lo que se cobra a ese
// CBU o alias entra solo en esta cuenta, desde su fecha de apertura.
function TransferLinks({ account, position }: { account: TreasuryAccount; position: TreasuryPosition | null }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const { data: transfers = [], isLoading } = useTransferAccounts();
  const linked = new Set((position?.transfer_accounts ?? []).map((t) => t.id));
  const [pending, setPending] = useState<string | null>(null);
  const list = transfers.filter((t) => t.is_active && !t.deleted_at);

  async function toggle(id: string, value: boolean) {
    setPending(id);
    try {
      const created = await m.linkTransfer.mutateAsync({ treasuryId: account.id, transferId: id, linked: value });
      toast({
        title: value ? "Cuenta vinculada" : "Cuenta desvinculada",
        description: value && created > 0 ? `Entraron ${created} cobros por transferencia desde la fecha de apertura.` : undefined,
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo cambiar el vínculo", description: treasuryErrorMessage(e), variant: "error" });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Link2 size={14} /> Cobros por transferencia que entran acá
      </div>
      <p className="text-xs text-muted-foreground">
        Tildá las cuentas que mostrás en el POS para cobrar por transferencia. Cada cobro a esa cuenta suma solo en este
        saldo; si anulás la venta, se resta.
      </p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Cargando…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tenés cuentas para cobrar por transferencia. Cargalas en Configuración, Medios de pago.
        </p>
      ) : (
        <ul className="space-y-1">
          {list.map((t) => {
            const mismatch = (t.currency ?? "ARS") !== account.currency;
            return (
              <li key={t.id}>
                <label className={cn("flex items-center gap-2 text-sm", mismatch && "opacity-60")}>
                  <Checkbox
                    checked={linked.has(t.id)}
                    disabled={mismatch || pending === t.id}
                    onCheckedChange={(v) => void toggle(t.id, v === true)}
                    aria-label={`Vincular ${t.bank_name}`}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{t.bank_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[t.alias, t.holder_name].filter(Boolean).join(" · ")}
                      {mismatch ? ` · en ${t.currency}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Procesadores que acreditan acá (H151): cada liquidación conciliada suma el
// neto en esta cuenta con la fecha de acreditación, y el asiento va a su cuenta
// contable. La billetera ya recibe lo de su propio procesador.
function SettlementLinks({ account }: { account: TreasuryAccount }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const [sel, setSel] = useState<string[]>(account.settlement_providers);
  useEffect(() => setSel(account.settlement_providers), [account.settlement_providers]);
  const own = account.kind === "wallet" ? account.provider_key : null;
  const options = SETTLEMENT_PROVIDERS.filter((p) => p.key !== own);
  const dirty = [...sel].sort().join(",") !== [...account.settlement_providers].sort().join(",");

  async function save() {
    try {
      const n = await m.setSettlementProviders.mutateAsync({ accountId: account.id, providers: sel });
      toast({
        title: "Listo",
        description: n > 0 ? `Entraron ${n} movimientos de liquidaciones ya conciliadas.` : "Las próximas liquidaciones entran solas acá.",
        variant: "success",
      });
    } catch (e) {
      toast({ title: "No se pudo guardar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  if (account.currency !== "ARS") return null;
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Landmark size={14} /> Liquidaciones que se acreditan acá
      </div>
      <p className="text-xs text-muted-foreground">
        {own
          ? `Lo que liquida ${providerLabel(own)} ya entra acá. Sumá otros procesadores si también te depositan en esta billetera.`
          : "Tildá los procesadores que te depositan en esta cuenta (por ejemplo Payway o Fiserv). Cada liquidación conciliada suma el neto acá con su fecha de acreditación."}
      </p>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {options.map((p) => (
          <label key={p.key} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={sel.includes(p.key)}
              onCheckedChange={(v) =>
                setSel((s) => (v === true ? [...new Set([...s, p.key])] : s.filter((x) => x !== p.key)))
              }
              aria-label={p.label}
            />
            {p.label}
          </label>
        ))}
      </div>
      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" loading={m.setSettlementProviders.isPending} onClick={() => void save()}>
            Guardar procesadores
          </Button>
        </div>
      )}
    </div>
  );
}

// Cuenta contable propia (H150): el Mayor de esta cuenta coincide con su saldo.
function LedgerLink({ account, position }: { account: TreasuryAccount; position: TreasuryPosition | null }) {
  const { toast } = useToast();
  const m = useTreasuryMutations();
  const acc = useAccountingAccess();
  const { data: settings } = useAccSettings(acc.enabled);
  if (!acc.enabled || !settings) return null;
  const ledger = position?.ledger_account ?? null;

  async function create() {
    try {
      await m.createLedgerAccount.mutateAsync(account.id);
      toast({ title: "Cuenta contable creada", description: "Sus movimientos ya van a su propia cuenta en el Mayor.", variant: "success" });
    } catch (e) {
      toast({ title: "No se pudo crear la cuenta contable", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 p-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <BookOpenCheck size={14} className="shrink-0" />
        {ledger ? (
          <span className="min-w-0">
            Cuenta contable <b className="tabular-nums">{ledger.code}</b> {ledger.name}
          </span>
        ) : (
          <span className="text-muted-foreground">
            Sin cuenta contable propia: sus movimientos van a la cuenta general del tipo.
          </span>
        )}
      </div>
      {!ledger && (
        <Button size="sm" variant="secondary" loading={m.createLedgerAccount.isPending} onClick={() => void create()}>
          Crear su cuenta contable
        </Button>
      )}
    </div>
  );
}

// ── Movimiento o transferencia ─────────────────────────────────────────────

type MovementMode = "deposit" | "withdrawal" | "transfer" | "adjustment";

const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const PROOF_MAX = 10 * 1024 * 1024;

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
  // Las cajas del POS y lo a acreditar se mueven solos (ADR-158).
  const active = accounts.filter((a) => a.is_active && !isSystemKind(a.kind));
  const [mode, setMode] = useState<MovementMode>("deposit");
  const [account, setAccount] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");
  // Gasto (H154): categoría, comprobante, IVA y adjunto.
  const [isExpense, setIsExpense] = useState(false);
  const [expenseAccount, setExpenseAccount] = useState("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [receiptVat, setReceiptVat] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const { data: accAccounts = [] } = useAccAccounts(open && mode === "withdrawal");
  const expenseAccounts = accAccounts.filter((a) => a.kind === "egreso" && a.imputable && a.is_active);

  useEffect(() => {
    if (!open) return;
    setMode("deposit");
    setAccount(accountId ?? "");
    setTo("");
    setAmount("");
    setDirection("in");
    setDate(today());
    setDescription("");
    setIsExpense(false);
    setExpenseAccount("");
    setReceiptNumber("");
    setReceiptVat("");
    setProof(null);
  }, [open, accountId]);

  const expense = mode === "withdrawal" && isExpense;
  const vat = parseNum(receiptVat);
  const errors = [
    ...(!account ? ["Elegí la cuenta."] : []),
    ...(!(parseNum(amount) > 0) ? ["Cargá un importe mayor a cero."] : []),
    ...(mode === "transfer" && (!to || to === account) ? ["Elegí otra cuenta de destino."] : []),
    ...(mode === "adjustment" && !description.trim() ? ["Escribí el motivo del ajuste."] : []),
    ...(expense && expenseAccounts.length > 0 && !expenseAccount ? ["Elegí la categoría del gasto."] : []),
    ...(expense && receiptVat && (vat < 0 || vat >= parseNum(amount)) ? ["El IVA tiene que ser menor que el importe."] : []),
    ...(expense && proof && !PROOF_TYPES.includes(proof.type) ? ["El adjunto tiene que ser una foto (JPG, PNG, WEBP) o un PDF."] : []),
    ...(expense && proof && proof.size > PROOF_MAX ? ["El adjunto pesa más de 10 MB."] : []),
  ];

  async function save() {
    if (errors.length) return;
    try {
      if (mode === "transfer") {
        await m.transfer.mutateAsync({ from: account, to, amount: parseNum(amount), date, description: description.trim() || null });
      } else {
        let proofPath: string | null = null;
        if (expense && proof) {
          setUploading(true);
          try {
            proofPath = await treasuryApi.uploadProof(proof);
          } finally {
            setUploading(false);
          }
        }
        await m.createMovement.mutateAsync({
          account_id: account,
          type: mode,
          amount: parseNum(amount),
          direction: mode === "adjustment" ? direction : undefined,
          date,
          description: description.trim() || null,
          ...(expense
            ? {
                expense_account_id: expenseAccount || null,
                receipt_number: receiptNumber.trim() || null,
                receipt_vat: receiptVat ? vat : null,
                proof_path: proofPath,
              }
            : {}),
        });
      }
      toast({ title: expense ? "Gasto registrado" : "Movimiento registrado", variant: "success" });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo registrar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  const busy = m.transfer.isPending || m.createMovement.isPending || uploading;
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
          scrollOnMobile
          options={[
            { value: "deposit", label: "Ingreso" },
            { value: "withdrawal", label: "Egreso o gasto" },
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
            <span className="hidden sm:block" />
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

        {mode === "withdrawal" && (
          <div className="space-y-3 rounded-md bg-muted/40 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <Checkbox checked={isExpense} onCheckedChange={(v) => setIsExpense(v === true)} aria-label="Es un gasto" />
              Es un gasto (alquiler, servicios, sueldos…)
            </label>
            {isExpense && (
              <div className="grid gap-3 sm:grid-cols-2">
                {expenseAccounts.length > 0 ? (
                  <FormField label="Categoría del gasto" className="sm:col-span-2">
                    <select className={cn(selectCls, "h-10")} value={expenseAccount} onChange={(e) => setExpenseAccount(e.target.value)}>
                      <option value="" className="bg-popover text-popover-foreground">
                        Elegí la categoría
                      </option>
                      {expenseAccounts.map((a) => (
                        <option key={a.id} value={a.id} className="bg-popover text-popover-foreground">
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                ) : (
                  <p className="text-xs text-muted-foreground sm:col-span-2">
                    Con la contabilidad activada elegís la categoría y el gasto va a su cuenta en el Mayor.
                  </p>
                )}
                <FormField label="N° de comprobante (opcional)">
                  <input className={inputCls} maxLength={40} value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} />
                </FormField>
                <FormField label="IVA del comprobante (opcional)">
                  <input
                    inputMode="decimal"
                    className={cn(inputCls, "text-right")}
                    value={receiptVat}
                    onChange={(e) => setReceiptVat(e.target.value)}
                  />
                </FormField>
                <FormField label="Adjunto (foto o PDF, opcional)" className="sm:col-span-2">
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted">
                    <Paperclip size={14} />
                    <span className="min-w-0 flex-1 truncate">{proof ? proof.name : "Elegir archivo"}</span>
                    <input
                      type="file"
                      accept={PROOF_TYPES.join(",")}
                      className="sr-only"
                      onChange={(e) => setProof(e.target.files?.[0] ?? null)}
                    />
                  </label>
                </FormField>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Con IVA de una factura A, el IVA va a crédito fiscal y el resto al gasto.
                </p>
              </div>
            )}
          </div>
        )}
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
      toast({ title: "No se pudo registrar", description: treasuryErrorMessage(e), variant: "error" });
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Cheque de terceros"
      description="Entra a cartera: después lo depositás o lo entregás en una orden de pago. Si el cheque paga una venta o una cuenta corriente, registrá ese cobro con el medio Otro: el cheque lo cancela."
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
          <div className="-mt-1 empty:hidden sm:col-span-2">
            <ChequeDuplicateHint number={f.number} bank={f.bank_name || null} />
          </div>
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
  // Los cheques se depositan en un banco (el servidor exige 'bank').
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
      toast({ title: "No se pudo actualizar", description: treasuryErrorMessage(e), variant: "error" });
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
        {to === "rechazado" && cheque?.kind === "own" && (
          <p className="text-xs text-warning">
            Al rechazarse un cheque propio vuelve la deuda con el proveedor: queda otra vez para pagar.
          </p>
        )}
        {to === "rechazado" && cheque?.kind === "third_party" && cheque?.payment_id && (
          <p className="text-xs text-warning">
            Este cheque se entregó en una orden de pago: pedile al proveedor la nota de débito o anulá la orden.
          </p>
        )}
        <ErrorList errors={errors} />
      </div>
    </Modal>
  );
}
