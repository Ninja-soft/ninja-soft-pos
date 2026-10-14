"use client";

// =============================================================================
// Editor reutilizable de una cuenta bancaria o virtual (CBU / CVU / alias) con
// el mismo selector de bancos con logos que el medio de pago Transferencia
// (ADR-055, components/dashboard-team/payments/TransferAccountModal.tsx), pero
// sin persistencia propia: quien lo usa decide dónde guarda (cuentas de cobro
// del staff, F21 · ADR-121; cuentas de NinjaSoft para la cuenta corriente).
//
// Contrato:
//   <BankAccountEditor open onOpenChange initial={TransferAccountInput | null}
//     isDefault onSave={(value, { is_default }) => Promise<void>} saving
//     title? description? noteLabel? defaultLabel? />
// Valida con validateTransferAccount (CBU/CVU con dígitos verificadores, CUIT,
// alias) y detecta la entidad por el prefijo del CBU / CVU. El servidor vuelve
// a validar.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { Check, ImageUp, Pencil } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { BankLogo } from "@/components/payments/BankLogo";
import { BANKS, bankBySlug, searchBanks, type BankKind } from "@/lib/payments/banks";
import {
  ACCOUNT_TYPE_LABEL,
  CURRENCY_LABEL,
  cbuLabel,
  detectEntity,
  digitsOnly,
  formatCuit,
  isCvu,
  validateTransferAccount,
  type TransferAccountInput,
  type TransferAccountType,
  type TransferCurrency,
} from "@/lib/payments/transfer";

export type BankAccountValue = TransferAccountInput;

export const EMPTY_BANK_ACCOUNT: BankAccountValue = {
  bank_slug: null,
  bank_name: "",
  holder_name: "",
  cuit: "",
  cbu: "",
  alias: "",
  account_type: "caja_ahorro",
  currency: "ARS",
  note: "",
};

/** Fila guardada → valor del editor. */
export function bankAccountValueOf(a: {
  bank_slug: string | null;
  bank_name: string;
  holder_name: string;
  cuit: string | null;
  cbu: string | null;
  alias: string | null;
  account_type: TransferAccountType;
  currency: TransferCurrency;
  note: string | null;
}): BankAccountValue {
  return {
    bank_slug: a.bank_slug,
    bank_name: a.bank_name,
    holder_name: a.holder_name,
    cuit: a.cuit ? formatCuit(a.cuit) : "",
    cbu: a.cbu ?? "",
    alias: a.alias ?? "",
    account_type: a.account_type,
    currency: a.currency,
    note: a.note ?? "",
  };
}

/** Valor del editor → payload normalizado para guardar. */
export function bankAccountPayload(v: BankAccountValue) {
  const bank = bankBySlug(v.bank_slug);
  return {
    bank_slug: bank?.slug ?? null,
    bank_name: (bank?.name ?? v.bank_name).trim(),
    holder_name: v.holder_name.trim(),
    cuit: digitsOnly(v.cuit) || null,
    cbu: digitsOnly(v.cbu) || null,
    alias: v.alias.trim() || null,
    account_type: v.account_type,
    currency: v.currency,
    note: v.note.trim() || null,
  };
}

const KIND_FILTERS: { value: "todos" | BankKind; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "banco", label: "Bancos" },
  { value: "billetera", label: "Billeteras" },
  { value: "fintech", label: "Fintech" },
  { value: "cripto", label: "Cripto" },
];

const LABEL = "mb-2 block text-sm font-medium text-muted-foreground";

function BankPicker({ onPick, onOther }: { onPick: (slug: string) => void; onOther: () => void }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"todos" | BankKind>("todos");
  const list = useMemo(() => {
    const found = q.trim() ? searchBanks(q) : [...BANKS];
    return kind === "todos" ? found : found.filter((b) => b.kind === kind);
  }, [q, kind]);
  return (
    <div className="space-y-3">
      <SearchField value={q} onValueChange={setQ} placeholder="Buscá el banco o la billetera" autoFocus aria-label="Buscar banco" />
      <Segmented value={kind} options={KIND_FILTERS} onChange={setKind} size="sm" aria-label="Tipo de entidad" />
      <div className="grid max-h-[46dvh] grid-cols-3 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-4">
        {list.map((b) => (
          <button
            key={b.slug}
            type="button"
            onClick={() => onPick(b.slug)}
            className="flex flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 text-center transition hover:bg-fg-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BankLogo slug={b.slug} name={b.name} size={36} />
            <span className="line-clamp-2 text-[11px] font-medium leading-tight">{b.shortName}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={onOther}
          className="flex flex-col items-center gap-1.5 rounded-lg px-1.5 py-2.5 text-center transition hover:bg-fg-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-fg-6 text-muted-foreground">
            <ImageUp size={17} aria-hidden />
          </span>
          <span className="text-[11px] font-medium leading-tight">Otra entidad</span>
        </button>
      </div>
    </div>
  );
}

export function BankAccountEditor({
  open,
  onOpenChange,
  initial,
  isDefault: initialDefault = false,
  lockDefault = false,
  onSave,
  saving = false,
  title,
  description = "Titular, CBU / CVU o alias de la cuenta.",
  noteLabel = "Nota (opcional)",
  defaultLabel = "Cuenta predeterminada",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** null = alta. */
  initial: BankAccountValue | null;
  isDefault?: boolean;
  /** Ya es la predeterminada: no se puede desmarcar (se cambia marcando otra). */
  lockDefault?: boolean;
  onSave: (value: BankAccountValue, opts: { is_default: boolean }) => void | Promise<void>;
  saving?: boolean;
  title?: string;
  description?: string;
  noteLabel?: string;
  defaultLabel?: string;
}) {
  const [v, setV] = useState<BankAccountValue>(EMPTY_BANK_ACCOUNT);
  const [picking, setPicking] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setV(initial ?? EMPTY_BANK_ACCOUNT);
    setPicking(!initial);
    setIsDefault(initialDefault);
    setTouched(false);
  }, [open, initial, initialDefault]);

  const bank = bankBySlug(v.bank_slug);
  const detected = detectEntity(v.cbu);
  const errors = validateTransferAccount(v);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof BankAccountValue>(k: K, val: BankAccountValue[K]) => setV((p) => ({ ...p, [k]: val }));
  const err = (k: keyof BankAccountValue) => (touched ? errors[k] : undefined);

  const pickBank = (slug: string) => {
    const b = bankBySlug(slug);
    setV((p) => ({
      ...p,
      bank_slug: slug,
      bank_name: b?.name ?? p.bank_name,
      account_type: b && b.kind !== "banco" && p.account_type === "caja_ahorro" ? "cuenta_virtual" : p.account_type,
    }));
    setPicking(false);
  };

  const onCbu = (raw: string) => {
    const d = digitsOnly(raw).slice(0, 22);
    setV((p) => {
      const next = { ...p, cbu: d };
      const ent = detectEntity(d);
      if (ent && !p.bank_slug && !p.bank_name.trim()) {
        next.bank_slug = ent.slug;
        next.bank_name = ent.name;
      }
      if (d.length === 22 && isCvu(d) && p.account_type !== "cuenta_virtual") next.account_type = "cuenta_virtual";
      return next;
    });
  };

  const save = () => {
    setTouched(true);
    if (!valid) return;
    void onSave(v, { is_default: isDefault });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? (initial ? "Editar cuenta" : "Nueva cuenta")}
      description={picking ? "Elegí el banco o la billetera." : description}
      footer={
        picking ? null : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={saving}>
              {initial ? "Guardar" : "Agregar cuenta"}
            </Button>
          </div>
        )
      }
    >
      {picking ? (
        <BankPicker
          onPick={pickBank}
          onOther={() => {
            setV((p) => ({ ...p, bank_slug: null, bank_name: "" }));
            setPicking(false);
          }}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-lg bg-fg-4 p-3">
            <BankLogo slug={v.bank_slug} name={v.bank_name || "Entidad"} size={40} />
            <div className="min-w-0 flex-1">
              {bank ? (
                <p className="truncate text-sm font-semibold">{bank.name}</p>
              ) : (
                <Input
                  value={v.bank_name}
                  onChange={(e) => set("bank_name", e.target.value)}
                  placeholder="Nombre del banco o billetera"
                  aria-label="Nombre de la entidad"
                  maxLength={80}
                  error={err("bank_name")}
                />
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
              <Pencil size={14} aria-hidden /> Cambiar
            </Button>
          </div>

          <Input
            label="Titular de la cuenta"
            value={v.holder_name}
            onChange={(e) => set("holder_name", e.target.value)}
            placeholder="Como figura en el banco"
            maxLength={120}
            error={err("holder_name")}
          />

          <div>
            <Input
              label="CBU o CVU"
              value={v.cbu}
              onChange={(e) => onCbu(e.target.value)}
              inputMode="numeric"
              placeholder="22 dígitos"
              error={err("cbu")}
              className="font-mono tracking-wide"
            />
            {v.cbu.length === 22 && !errors.cbu && (
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-success">
                <Check size={13} aria-hidden /> {cbuLabel(v.cbu)} válido
                {detected ? ` de ${detected.name}` : ""}
                {detected && v.bank_slug && detected.slug !== v.bank_slug ? (
                  <button
                    type="button"
                    onClick={() => pickBank(detected.slug)}
                    className="ml-1 font-semibold text-foreground underline-offset-2 hover:underline"
                  >
                    Usar {detected.shortName}
                  </button>
                ) : null}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Alias"
              value={v.alias}
              onChange={(e) => set("alias", e.target.value.replace(/\s/g, ""))}
              placeholder="nombre.apellido.mp"
              maxLength={20}
              error={err("alias")}
            />
            <Input
              label="CUIT del titular (opcional)"
              value={v.cuit}
              onChange={(e) => set("cuit", e.target.value)}
              inputMode="numeric"
              placeholder="20-12345678-6"
              maxLength={13}
              error={err("cuit")}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="bae-type">
                Tipo de cuenta
              </label>
              <select
                id="bae-type"
                value={v.account_type}
                onChange={(e) => set("account_type", e.target.value as TransferAccountType)}
                className="h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-ring"
              >
                {Object.entries(ACCOUNT_TYPE_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className={LABEL}>Moneda</span>
              <Segmented
                value={v.currency}
                onChange={(c) => set("currency", c as TransferCurrency)}
                options={(Object.keys(CURRENCY_LABEL) as TransferCurrency[]).map((c) => ({ value: c, label: CURRENCY_LABEL[c] }))}
                aria-label="Moneda"
                fill
              />
            </div>
          </div>

          <Input label={noteLabel} value={v.note} onChange={(e) => set("note", e.target.value)} maxLength={200} error={err("note")} />

          <label className="flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={lockDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 accent-[var(--pos-solid)]"
            />
            {defaultLabel}
          </label>
        </div>
      )}
    </Modal>
  );
}
