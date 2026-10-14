"use client";

import { useToast } from "@/components/ui/Toast";
import { BankAccountEditor } from "@/components/billing/BankAccountEditor";
import {
  formatCuit,
  transferErrorMessage,
  type TransferAccount,
  type TransferAccountInput,
} from "@/lib/payments/transfer";
import { transferApi, useTransferMutations } from "@/modules/payments/transfer";

// Alta y edición de una cuenta para cobrar por transferencia (ADR-055): banco
// o billetera del catálogo (con su logo) u "Otra" con logo propio, titular,
// CUIT, CBU / CVU (detecta la entidad por el prefijo), alias, tipo, moneda y
// nota. El formulario es el editor compartido components/billing/BankAccountEditor
// (también lo usan las cuentas de cobro de NinjaSoft, ADR-120).

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

  return (
    <BankAccountEditor
      open={open}
      onOpenChange={onOpenChange}
      initial={account ? fromAccount(account) : null}
      initialDefault={account?.is_default ?? isFirst}
      defaultLocked={account?.is_default}
      initialLogo={{ path: account?.custom_logo_path ?? null, url: account?.custom_logo_url ?? null }}
      saving={mut.save.isPending}
      uploadLogo={(file) => transferApi.uploadLogo(file)}
      onSave={(input, extra) =>
        mut.save.mutate(
          {
            id: account?.id ?? null,
            input,
            extra: {
              is_default: extra.isDefault || undefined,
              custom_logo_path: input.bank_slug ? null : extra.logo.path,
              custom_logo_url: input.bank_slug ? null : extra.logo.url,
            },
          },
          {
            onSuccess: () => {
              toast({ title: account ? "Cuenta actualizada" : "Cuenta agregada", variant: "success" });
              onOpenChange(false);
            },
            onError: (e) => toast({ title: transferErrorMessage(e), variant: "error" }),
          },
        )
      }
    />
  );
}
