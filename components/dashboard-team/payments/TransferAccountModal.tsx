"use client";

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
  formatCuit,
  isCvu,
  transferErrorMessage,
  validateTransferAccount,
  type TransferAccount,
  type TransferAccountInput,
  type TransferAccountType,
  type TransferCurrency,
} from "@/lib/payments/transfer";
import { LOGO_MAX_BYTES, transferApi, useTransferMutations } from "@/modules/payments/transfer";

// Alta y edición de una cuenta para cobrar por transferencia (ADR-055): banco
// o billetera del catálogo (con su logo) u "Otra" con logo propio, titular,
// CUIT, CBU / CVU (detecta la entidad por el prefijo), alias, tipo, moneda y
// nota.

const KIND_FILTERS: { value: "todos" | BankKind; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "banco", label: "Bancos" },
  { value: "billetera", label: "Billeteras" },
  { value: "fintech", label: "Fintech" },
  { value: "cripto", label: "Cripto" },
];

const EMPTY: TransferAccountInput = {
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

function fromAccount(a: TransferAccount): TransferAccountInput {
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

// ── Selector de banco ────────────────────────────────────────────────────────

function BankPicker({ onPick, onOther }: { onPick: (slug: string) => void; onOther: () => void }) {
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
          <span className="text-[11px] font-medium leading-tight">Otra entidad</span>
        </button>
      </div>
      {list.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No la encontramos. Elegí <strong className="text-foreground">Otra entidad</strong> y cargá su nombre y logo.
        </p>
      )}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function TransferAccountModal({
  open,
  onOpenChange,
  account,
  isFirst,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** null = alta. */
  account: TransferAccount | null;
  isFirst: boolean;
}) {
  const { toast } = useToast();
  const mut = useTransferMutations();
  const [v, setV] = useState<TransferAccountInput>(EMPTY);
  const [picking, setPicking] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [logo, setLogo] = useState<{ path: string | null; url: string | null }>({ path: null, url: null });
  const [uploading, setUploading] = useState(false);
  const [touched, setTouched] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setV(account ? fromAccount(account) : EMPTY);
    setPicking(!account);
    setIsDefault(account?.is_default ?? isFirst);
    setLogo({ path: account?.custom_logo_path ?? null, url: account?.custom_logo_url ?? null });
    setTouched(false);
  }, [open, account, isFirst]);

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
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      toast({ title: "El logo pesa más de 512 KB", variant: "error" });
      return;
    }
    setUploading(true);
    try {
      const up = await transferApi.uploadLogo(file);
      setLogo(up);
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
    mut.save.mutate(
      {
        id: account?.id ?? null,
        input: v,
        extra: {
          is_default: isDefault || undefined,
          custom_logo_path: v.bank_slug ? null : logo.path,
          custom_logo_url: v.bank_slug ? null : logo.url,
        },
      },
      {
        onSuccess: () => {
          toast({ title: account ? "Cuenta actualizada" : "Cuenta agregada", variant: "success" });
          onOpenChange(false);
        },
        onError: (e) => toast({ title: transferErrorMessage(e), variant: "error" }),
      },
    );
  };

  const title = account ? "Editar cuenta" : "Nueva cuenta para transferencias";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={picking ? "Elegí dónde recibís las transferencias." : "Estos datos se muestran al cliente al cobrar."}
      footer={
        picking ? null : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button onClick={save} loading={mut.save.isPending} disabled={uploading}>
              {account ? "Guardar" : "Agregar cuenta"}
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

          {!bank && (
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="ta-type">
                Tipo de cuenta
              </label>
              <select
                id="ta-type"
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

          <Input
            label="Nota para el cliente (opcional)"
            value={v.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="Ej. Mandá el comprobante por WhatsApp"
            maxLength={200}
            error={err("note")}
          />

          <label className={cn("flex items-center gap-2.5 text-sm", account?.is_default && "opacity-60")}>
            <input
              type="checkbox"
              checked={isDefault}
              disabled={account?.is_default}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 accent-[var(--pos-solid)]"
            />
            Cuenta por defecto al cobrar
          </label>
        </div>
      )}
    </Modal>
  );
}
