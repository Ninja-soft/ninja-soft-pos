"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { PadronVerify } from "@/components/customers/PadronVerify";
import { padronToCustomer, type FiscalVerification, type PadronPersona } from "@/lib/customers/padron";
import { documentError } from "@/lib/tax/catalog";
import { inferLetter } from "@/lib/tax/comprobante";
import { DOC_TYPES, DOC_TYPE_LABELS, IVA_CONDITIONS, IVA_LABELS } from "@/modules/customers/schemas";
import { useCustomerMutations, useRequiredCustomerFields } from "@/modules/customers/hooks";
import { useTaxSettings } from "@/modules/tax/hooks";
import { errorDescription } from "@/lib/permissions/errors";

const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15";

const DOC_ERROR: Record<string, string> = {
  invalid_cuit: "CUIT o CUIL inválido: revisá los 11 números.",
  invalid_dni: "El DNI tiene 7 u 8 números.",
};

// Alta rápida de cliente desde el POS (ADR-133): nombre, documento,
// condición frente al IVA y contacto, con "Verificar en ARCA" para un CUIT o
// CUIL. Muestra qué factura le vas a hacer y lo deja elegido en la venta.
export function QuickCustomerModal({
  open,
  onOpenChange,
  initialSearch,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Lo que se estaba buscando: si son números va al documento, si no al nombre. */
  initialSearch?: string;
  onCreated: (c: { id: string; name: string }) => void;
}) {
  const { toast } = useToast();
  const { createQuick } = useCustomerMutations();
  const { data: required } = useRequiredCustomerFields();
  const tax = useTaxSettings(open);
  const [name, setName] = useState("");
  const [docType, setDocType] = useState<string>("cuit");
  const [docNumber, setDocNumber] = useState("");
  const [cond, setCond] = useState<string>("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<string | null>(null);
  const [jur, setJur] = useState<string | null>(null);
  const [ver, setVer] = useState<FiscalVerification>(null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    const s = (initialSearch ?? "").trim();
    const digits = s.replace(/\D/g, "");
    setName(digits.length >= 7 && digits.length === s.replace(/[\s.-]/g, "").length ? "" : s);
    setDocNumber(digits.length >= 7 && digits.length === s.replace(/[\s.-]/g, "").length ? digits : "");
    setDocType(digits.length === 11 || digits.length < 7 ? "cuit" : "dni");
    setCond("");
    setEmail("");
    setPhone("");
    setAddress(null);
    setJur(null);
    setVer(null);
    setTried(false);
  }, [open, initialSearch]);

  const requireDoc = required?.requireDoc ?? true;
  const docErr = docNumber.trim() ? documentError(docType, docNumber) : null;
  const nameErr = tried && !name.trim() ? "Requerido" : undefined;
  const docMissing = tried && requireDoc && !docNumber.trim();
  const letter = inferLetter(tax.data?.iva_condition ?? null, cond || null, { issuesM: tax.data?.issues_cbte_m });

  function apply(p: PadronPersona) {
    const c = padronToCustomer(p);
    if (c.name) setName(c.name);
    if (c.iva_condition !== "consumidor_final") setDocType("cuit");
    setCond(c.iva_condition);
    setAddress(c.address);
    setJur(c.iibb_jurisdiction);
    setVer("padron");
  }

  async function submit() {
    setTried(true);
    if (!name.trim() || docErr || (requireDoc && !docNumber.trim())) return;
    try {
      const created = await createQuick.mutateAsync({
        name: name.trim(),
        document_type: docNumber.trim() ? docType : null,
        document_number: docNumber.trim() || null,
        iva_condition: cond || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        ...(address ? { address } : {}),
        ...(jur ? { iibb_jurisdiction: jur } : {}),
        fiscal_verification: ver ?? (cond ? "manual" : null),
        ...(ver === "padron" ? { fiscal_verified_at: new Date().toISOString() } : {}),
      });
      toast({ title: `Cliente ${created.name} agregado`, variant: "success" });
      onCreated(created);
    } catch (e) {
      toast({ title: "No se pudo crear el cliente", description: errorDescription(e), variant: "error" });
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Nuevo cliente" className="max-w-lg">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">Documento</label>
            <select className={selectCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOC_TYPES.map((d) => (
                <option key={d} value={d} className="bg-popover text-popover-foreground">
                  {DOC_TYPE_LABELS[d]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label={`Número${requireDoc ? " *" : ""}`}
            inputMode="numeric"
            autoFocus
            value={docNumber}
            onChange={(e) => {
              setDocNumber(e.target.value);
              if (ver === "padron") setVer("manual");
            }}
            error={docErr ? DOC_ERROR[docErr] ?? "Documento inválido" : docMissing ? "Requerido" : undefined}
          />
        </div>
        <PadronVerify docType={docType} docNumber={docNumber} verification={ver} onApply={apply} />
        <Input label="Nombre o razón social *" value={name} onChange={(e) => setName(e.target.value)} error={nameErr} />
        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">Condición frente al IVA</label>
          <select
            className={selectCls}
            value={cond}
            onChange={(e) => {
              setCond(e.target.value);
              setVer(e.target.value ? "manual" : null);
            }}
          >
            <option value="">Consumidor final (sin especificar)</option>
            {IVA_CONDITIONS.map((c) => (
              <option key={c} value={c} className="bg-popover text-popover-foreground">
                {IVA_LABELS[c]}
              </option>
            ))}
          </select>
          {letter && (
            <div className="mt-2">
              <Badge tone="info">Le vas a emitir Factura {letter}</Badge>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Teléfono" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="submit" loading={createQuick.isPending}>
            Crear y usar en la venta
          </Button>
        </div>
      </form>
    </Modal>
  );
}
QuickCustomerModal.displayName = "QuickCustomerModal";
