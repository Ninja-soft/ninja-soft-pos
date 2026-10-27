"use client";

// Cupón de pago en efectivo de Mercado Pago (Rapipago / Pago Fácil, ADR-180)
// dentro del cobro del POS:
//   * CuponPayerForm: Mercado Pago exige email, nombre y DNI / CUIT del
//     pagador. Se completa solo con el cliente de la venta si lo tiene.
//   * CuponVoucherPanel: el cupón emitido (medio, número para pagar,
//     vencimiento y el cupón oficial de Mercado Pago para abrir o compartir).
// El código de barras no se dibuja: el formato que informa Mercado Pago no es
// seguro (dice EAN-13 y manda 46 dígitos). Vale el cupón oficial (ticket_url).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { ThemedLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { paymentIcon, paymentWordmark } from "@/lib/payments/logos";
import { createClient } from "@/lib/supabase/client";
import {
  CUPON_METHOD_LABEL,
  cuponExpiryLabel,
  cuponLimitWarning,
  formatBarcode,
  validateCuponPayer,
  type CuponMethod,
  type CuponPayerErrors,
} from "@/lib/payments/mpCupon";
import { posApi, type MpCuponPayer, type MpCuponVoucher } from "@/modules/pos/api";

// Logo chico de dónde paga el cliente: Rapipago no tiene isotipo (va su logo
// en lugar del texto); Pago Fácil, su ícono cuadrado junto al nombre.
function methodOption(m: CuponMethod) {
  const label = CUPON_METHOD_LABEL[m];
  const word = paymentWordmark(m);
  const icon = paymentIcon(m);
  if (word && !icon) return { value: m, label, preview: <ThemedLogo src={word} alt={label} className="h-3.5 w-auto" /> };
  return { value: m, label, icon: icon ? <ThemedLogo src={icon} alt="" className="h-[18px] w-[18px] rounded-[4px]" /> : undefined };
}

export function CuponPayerForm({
  amount,
  customerId,
  customerName,
  customerEmail,
  onSubmit,
}: {
  /** Total del cupón: se compara con el tope del medio en la cuenta. */
  amount: number;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  onSubmit: (payer: MpCuponPayer) => void;
}) {
  const [method, setMethod] = useState<CuponMethod>("rapipago");
  const [email, setEmail] = useState(customerEmail ?? "");
  const [name, setName] = useState(customerName ?? "");
  const [doc, setDoc] = useState("");
  const [errors, setErrors] = useState<CuponPayerErrors>({});

  // Datos del cliente de la venta (RLS por negocio): completan lo que falte.
  const { data: customer } = useQuery({
    queryKey: ["cupon-payer", customerId],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("customers")
        .select("name, email, document_number")
        .eq("id", customerId!)
        .maybeSingle();
      return data as { name: string | null; email: string | null; document_number: string | null } | null;
    },
  });
  // Topes de Rapipago y Pago Fácil en la cuenta de Mercado Pago.
  const { data: limits } = useQuery({
    queryKey: ["mp-cupon-limits"],
    queryFn: () => posApi.mpCuponLimits(),
    staleTime: 10 * 60_000,
  });
  const limitWarning = cuponLimitWarning(amount, method, limits?.[method] ?? null);

  useEffect(() => {
    if (!customer) return;
    setEmail((v) => v || customer.email || "");
    setName((v) => v || customer.name || "");
    setDoc((v) => v || customer.document_number || "");
  }, [customer]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (limitWarning) return;
    const errs = validateCuponPayer({ email, name, docNumber: doc });
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    onSubmit({ method, email: email.trim(), name: name.trim(), docNumber: doc.replace(/[\s.-]/g, "") });
  }

  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <p className="text-sm text-muted-foreground">
        El cliente paga en efectivo en cualquier sucursal. Mercado Pago pide sus datos para emitir el cupón y le
        manda una copia por email.
      </p>
      <Segmented
        size="sm"
        fill
        aria-label="Dónde paga el cliente"
        value={method}
        options={(Object.keys(CUPON_METHOD_LABEL) as CuponMethod[]).map(methodOption)}
        onChange={setMethod}
      />
      {limitWarning && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {limitWarning}
        </p>
      )}
      <Input
        label="Email del cliente"
        type="email"
        inputMode="email"
        autoComplete="off"
        value={email}
        error={errors.email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        label="Nombre y apellido"
        autoComplete="off"
        value={name}
        error={errors.name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label="DNI o CUIT"
        inputMode="numeric"
        autoComplete="off"
        value={doc}
        error={errors.docNumber}
        onChange={(e) => setDoc(e.target.value)}
      />
      <Button type="submit" className="w-full" disabled={Boolean(limitWarning)}>
        Generar cupón
      </Button>
    </form>
  );
}
CuponPayerForm.displayName = "CuponPayerForm";

export function CuponVoucherPanel({ voucher }: { voucher: MpCuponVoucher | null }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  if (!voucher) {
    return <p className="text-sm text-muted-foreground">Mercado Pago está emitiendo el cupón. Aparece acá en unos segundos.</p>;
  }
  const code = voucher.barcode_content ?? voucher.reference;
  const expiry = cuponExpiryLabel(voucher.expires_at);

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Número copiado", variant: "success" });
    } catch {
      toast({ title: "No se pudo copiar el número", variant: "error" });
    }
  }

  return (
    <div className="space-y-2.5">
      <p className="text-sm text-muted-foreground">
        El cliente paga en efectivo en {CUPON_METHOD_LABEL[voucher.payment_method]} mostrando el cupón (o dictando el
        número). La venta se registra sola cuando Mercado Pago acredita el pago, que puede tardar hasta 2 horas hábiles.
      </p>
      {code && (
        <button
          type="button"
          onClick={() => void copy()}
          className="group flex w-full items-center justify-between gap-3 rounded-lg bg-fg-4 px-3 py-2.5 text-left transition hover:bg-fg-6"
          aria-label="Copiar número del cupón"
        >
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">
              {voucher.barcode_content ? "Número del código de barras" : "Código de pago"}
            </span>
            <span className="block break-all font-mono text-sm font-bold tabular-nums leading-snug md:text-base">
              {formatBarcode(code)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-muted-foreground group-hover:text-foreground">
            {copied ? <Check size={14} aria-hidden className="text-success" /> : <Copy size={14} aria-hidden />}
            {copied ? "Copiado" : "Copiar"}
          </span>
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={voucher.ticket_url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          <ExternalLink size={14} aria-hidden /> Ver cupón
        </a>
        {expiry && <span className="text-xs text-muted-foreground">{expiry}</span>}
      </div>
    </div>
  );
}
CuponVoucherPanel.displayName = "CuponVoucherPanel";
