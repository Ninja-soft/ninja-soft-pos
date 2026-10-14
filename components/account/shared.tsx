"use client";

import Image from "next/image";
import { cn } from "@/lib/utils/cn";
import type { CollectMethod, MovementKind } from "@/modules/customers/account";

export const KIND_LABEL: Record<MovementKind, string> = {
  charge: "Compra",
  payment: "Cobro",
  interest: "Punitorio",
  interest_waiver: "Condonación",
  adjust_debit: "Ajuste débito",
  adjust_credit: "Ajuste crédito",
  reversal: "Reversa",
};

export const METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  debit: "Débito",
  credit: "Crédito",
  transfer: "Transferencia",
  qr: "QR",
  other: "Otro",
};

export const COLLECT_METHODS: { value: CollectMethod; label: string }[] = [
  { value: "cash", label: "Efectivo" },
  { value: "transfer", label: "Transferencia" },
  { value: "debit", label: "Débito" },
  { value: "credit", label: "Crédito" },
  { value: "qr", label: "QR" },
  { value: "other", label: "Otro" },
];

export const STATUS_LABEL: Record<"ok" | "watch" | "blocked", string> = {
  ok: "Al día",
  watch: "En observación",
  blocked: "Bloqueada",
};

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Pill de estado de crédito. Relleno suave (sin bordes de color).
export function CreditStatusPill({ status }: { status: "ok" | "watch" | "blocked" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold",
        status === "ok" && "bg-emerald-400/15 text-success",
        status === "watch" && "bg-amber-400/15 text-warning",
        status === "blocked" && "bg-red-400/15 text-danger",
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// Link de WhatsApp (wa.me, sin API) con texto prellenado.
export function waLink(phone: string, message: string): string {
  let digits = phone.replace(/\D/g, "");
  // Números locales argentinos sin prefijo internacional.
  if (digits.length === 10) digits = `549${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function WhatsAppLogo({ size = 16 }: { size?: number }) {
  return (
    <Image
      src="/images/integrations/whatsapp.webp"
      alt="WhatsApp"
      width={size}
      height={size}
      className="shrink-0"
    />
  );
}

// Mensaje de cobranza por WhatsApp.
export function whatsappDebtMessage(input: {
  name: string;
  business?: string | null;
  balance: string;
  overdue?: string | null;
  oldestDue?: string | null;
}): string {
  const hi = `Hola ${input.name}`;
  const from = input.business ? `, te escribimos de ${input.business}` : "";
  const due =
    input.overdue && input.oldestDue
      ? ` Tenés ${input.overdue} vencido desde el ${input.oldestDue}.`
      : "";
  return `${hi}${from}. Tu saldo de cuenta corriente es ${input.balance}.${due} Cuando puedas, avisanos cómo querés abonarlo. ¡Gracias!`;
}
