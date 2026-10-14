"use client";

// =============================================================================
// Editor de una cuenta bancaria o billetera (ADR-055, reutilizado en ADR-120):
// selector de bancos y billeteras del catálogo con su logo (o "Otra entidad"
// con logo propio), titular, CBU / CVU con los dígitos verificadores (detecta
// la entidad por el prefijo), alias, CUIT, tipo, moneda y nota.
//
// No guarda nada: devuelve los datos con onSave. Lo usan:
//   · Transferencia del POS (components/dashboard-team/payments/TransferAccountModal);
//   · las cuentas con las que NinjaSoft cobra la cuenta corriente
//     (components/internal/billing/PlatformBankAccountsCard).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImageUp, Pencil, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SearchField } from "@/components/ui/SearchField";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { BankLogo } from "@/components/payments/BankLogo";
import { cn } from "@/lib/utils/cn";
import { BANKS, bankBySlug, searchBanks, type BankKind } from "@/lib/payments/banks";
import {
  ACCOUNT_TYPE_LABEL,
  CURRENCY_LABEL,
  cbuLabel,
  detectEntity,
  digitsOnly,
  isCvu,
  validateTransferAccount,
  type TransferAccountInput,
  type TransferAccountType,
  type TransferCurrency,
} from "@/lib/payments/transfer";

const KIND_FILTERS: { value: "todos" | BankKind; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "banco", label: "Bancos" },
  { value: "billetera", label: "Billeteras" },
  { value: "fintech", label: "Fintech" },
  { value: "cripto", label: "Cripto" },
];

export const EMPTY_BANK_ACCOUNT: TransferAccountInput = {
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

const LABEL = "mb-2 block text-sm font-medium text-muted-foreground";
const LOGO_MAX_BYTES = 512 * 1024;

export interface BankAccountLogo {
  path: string | null;
  url: string | null;
}

// ── Selector de banco ────────────────────────────────────────────────────────

export function BankPicker({
  onPick,
  onOther,
  otherLabel = "Otra entidad",
  withLogo = true,
}: {
  onPick: (slug: string) => void;
  onOther: () => void;
  otherLabel?: string;
  withLogo?: boolean;
}) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"todos" | BankKind>("todos");
  const list = useMemo(() => {
    const found = q.trim() ? searchBanks(q) : [...BANKS];
    return kind === "todos" ? found : found.filter((b) => b.kind === kind);
  }, [q, kind]);
  return (
    <div className="space-y-3">
      <SearchField value={q} onValueChange={setQ} placeholder="Buscá tu banco o billetera" autoFocus aria-label="Buscar banco" />
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
          <span className="text-[11px] font-medium leading-tight">{otherLabel}</span>
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No la encontramos. Elegí <strong className="text-foreground">{otherLabel}</strong> y cargá su nombre{withLogo ? " y logo" : ""}.
        </p>
      )}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export interface BankAccountEditorProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Datos de la cuenta a editar; null = alta. */
  initial: TransferAccountInput | null;
  /** Por defecto marcado al abrir (alta: la primera cuenta). */
  initialDefault: boolean;
  /** La cuenta ya es la de por defecto: no se puede desmarcar desde acá. */
  defaultLocked?: boolean;
  initialLogo?: BankAccountLogo;
  saving: boolean;
  onSave: (input: TransferAccountInput, extra: { isDefault: boolean; logo: BankAccountLogo }) => void;
  /** Sube el logo de "Otra entidad". Sin esta función no se ofrece subir logo. */
  uploadLogo?: (file: File) => Promise<BankAccountLogo>;
  title?: string;
  pickDescription?: string;
  formDescription?: string;
  /** Muestra el selector de moneda (la cuenta corriente de NinjaSoft es sólo en pesos). */
  showCurrency?: boolean;
  defaultLabel?: string;
  noteLabel?: string;
  notePlaceholder?: string;
  submitLabel?: string;
}

export function BankAccountEditor({
  open,
  onOpenChange,
  initial,
  initialDefault,
  defaultLocked = false,
  initialLogo,
  saving,
  onSave,
  uploadLogo,
  title,
  pickDescription = "Elegí dónde se reciben las transferencias.",
  formDescription = "Estos datos se muestran al cliente al cobrar.",
  showCurrency = true,
  defaultLabel = "Cuenta por defecto al cobrar",
  noteLabel = "Nota para el cliente (opcional)",
  notePlaceholder = "Ej. Mandá el comprobante por WhatsApp",
  submitLabel,
}: BankAccountEditorProps) {
  const { toast } = useToast();
  const [v, setV] = useState<TransferAccountInput>(EMPTY_BANK_ACCOUNT);
  const [picking, setPicking] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [logo, setLogo] = useState<BankAccountLogo>({ path: null, url: null });
  const [uploading, setUploading] = useState(false);
  const [touched, setTouched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setV(initial ?? EMPTY_BANK_ACCOUNT);
    setPicking(!initial);
    setIsDefault(initialDefault);
    setLogo(initialLogo ?? { path: null, url: null });
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const bank = bankBySlug(v.bank_slug);
  const detected = detectEntity(v.cbu);
  const errors = validateTransferAccount(v);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof TransferAccountInput>(k: K, val: TransferAccountInput[K]) => setV((p) => ({ ...p, [k]: val }));
  const err = (k: keyof TransferAccountInput) => (touched ? errors[k] : undefined);

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
      // Detecta la entidad por el prefijo si todavía no se eligió.
      const ent = detectEntity(d);
      if (ent && !p.bank_slug && !p.bank_name.trim()) {
        next.bank_slug = ent.slug;
        next.bank_name = ent.name;
      }
      if (d.length === 22 && isCvu(d) && p.account_type !== "cuenta_virtual") next.account_type = "cuenta_virtual";
      return next;
    });
  };

  const onLogo = async (file: File | undefined) => {
    if (!file || !uploadLogo) return;
    if (file.size > LOGO_MAX_BYTES) {
      toast({ title: "El logo pesa más de 512 KB", variant: "error" });
      return;
    }
    setUploading(true);
    try {
      setLogo(await uploadLogo(file));
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      toast({
        title: m === "logo_type" ? "Subí un PNG, JPG o WebP" : "No se pudo subir el logo",
        variant: "error",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const save = () => {
    setTouched(true);
    if (!valid) return;
    onSave(v, { isDefault, logo: v.bank_slug ? { path: null, url: null } : logo });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? (initial ? "Editar cuenta" : "Nueva cuenta para transferencias")}
      description={picking ? pickDescription : formDescription}
      footer={
        picking ? null : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={saving} disabled={uploading}>
              {submitLabel ?? (initial ? "Guardar" : "Agregar cuenta")}
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
          withLogo={Boolean(uploadLogo)}
        />
      ) : (
        <div className="space-y-4">
          {/* Entidad elegida */}
          <div className="flex items-center gap-3 rounded-lg bg-fg-4 p-3">
            <BankLogo slug={v.bank_slug} customUrl={logo.url} name={v.bank_name || "Entidad"} size={40} />
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

          {!bank && uploadLogo && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => void onLogo(e.target.files?.[0])}
              />
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
                <ImageUp size={14} aria-hidden /> {logo.url ? "Cambiar logo" : "Subir logo"}
              </Button>
              {logo.url && (
                <Button variant="ghost" size="sm" onClick={() => setLogo({ path: null, url: null })}>
                  <Trash2 size={14} aria-hidden /> Quitar logo
                </Button>
              )}
              <span className="text-xs text-muted-foreground">PNG, JPG o WebP hasta 512 KB, ideal cuadrado y sin fondo.</span>
            </div>
          )}

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
            {v.cbu.length > 0 && !errors.cbu && v.cbu.length === 22 && (
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
              placeholder="mi.negocio.mp"
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

          <div className={cn("grid gap-4", showCurrency && "sm:grid-cols-2")}>
            <div>
              <label className={LABEL} htmlFor="bank-editor-type">
                Tipo de cuenta
              </label>
              <select
                id="bank-editor-type"
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
            {showCurrency && (
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
            )}
          </div>

          <Input
            label={noteLabel}
            value={v.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder={notePlaceholder}
            maxLength={200}
            error={err("note")}
          />

          <label className={cn("flex items-center gap-2.5 text-sm", defaultLocked && "opacity-60")}>
            <input
              type="checkbox"
              checked={isDefault}
              disabled={defaultLocked}
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
BankAccountEditor.displayName = "BankAccountEditor";
