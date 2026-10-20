"use client";

// F24 · H158: aviso al cargar un cheque cuyo número y banco ya existen. No
// frena: dos bancos pueden repetir número y quien carga decide.

import { TriangleAlert } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import { CHEQUE_STATUS_LABEL } from "@/lib/treasury/cheques";
import { useChequeDuplicates } from "@/modules/treasury/hooks";

export function ChequeDuplicateHint({ number, bank }: { number: string; bank: string | null }) {
  const dups = useChequeDuplicates(number, bank);
  if (dups.length === 0) return null;
  const c = dups[0]!;
  return (
    <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        Ya cargaste un cheque {c.number}
        {c.bank_name ? ` del ${c.bank_name}` : ""} por {formatCurrency(c.amount)} ({CHEQUE_STATUS_LABEL[c.status].toLowerCase()}
        {dups.length > 1 ? ` y ${dups.length - 1} más` : ""}). Revisá que no sea el mismo.
      </span>
    </p>
  );
}
