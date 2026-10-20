"use client";

// F24 · H160 (ADR-179): medios de un recibo de cuenta corriente. Cada línea
// es un medio (efectivo, transferencia, tarjeta, QR, otro, cheque o e-cheq) o
// una retención sufrida. El servidor valida todo (account_collect_multi).

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { formatCurrency } from "@/lib/utils/format";
import { JURISDICTIONS } from "@/lib/tax/catalog";
import {
  RECEIPT_METHOD_LABEL,
  RETENTION_TAX_LABEL,
  type ReceiptPayMethod,
  type ReceiptRetentionTax,
} from "@/lib/account/receipt";
import type { TransferAccount } from "@/lib/payments/transfer";

/** Línea en edición (montos como texto; vacío = toma lo que falta). */
export interface DraftLine {
  key: string;
  kind: "payment" | "retention";
  method: ReceiptPayMethod;
  amount: string;
  transferAccount: string;
  chequeNumber: string;
  chequeBank: string;
  chequePaymentDate: string;
  chequeDrawer: string;
  chequeCuit: string;
  tax: ReceiptRetentionTax;
  jurisdiction: string;
  certificate: string;
}

let seq = 0;
export function newDraftLine(kind: "payment" | "retention" = "payment"): DraftLine {
  return {
    key: `rl${++seq}`,
    kind,
    method: "cash",
    amount: "",
    transferAccount: "",
    chequeNumber: "",
    chequeBank: "",
    chequePaymentDate: "",
    chequeDrawer: "",
    chequeCuit: "",
    tax: "iibb",
    jurisdiction: "",
    certificate: "",
  };
}

const SELECT =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ninja-flameSoft";
const FIELD =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ninja-flameSoft";
const LABEL = "mb-1 block text-xs font-medium text-muted-foreground";

const BASE_METHODS: ReceiptPayMethod[] = ["cash", "transfer", "debit", "credit", "qr", "other"];

export function ReceiptLinesEditor({
  lines,
  amounts,
  onChange,
  allowCheques,
  allowRetentions,
  transferAccounts,
}: {
  lines: DraftLine[];
  /** Monto efectivo de cada línea (el vacío toma lo que falta). */
  amounts: number[];
  onChange: (lines: DraftLine[]) => void;
  allowCheques: boolean;
  allowRetentions: boolean;
  transferAccounts: TransferAccount[];
}) {
  const methods: ReceiptPayMethod[] = allowCheques ? [...BASE_METHODS, "cheque", "echeq"] : BASE_METHODS;
  const patch = (key: string, p: Partial<DraftLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const remove = (key: string) => onChange(lines.filter((l) => l.key !== key));

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">Medios de cobro</p>
      <ul className="space-y-2">
        {lines.map((l, i) => {
          const isCheque = l.kind === "payment" && (l.method === "cheque" || l.method === "echeq");
          return (
            <li key={l.key} className="space-y-2 rounded-lg bg-muted/40 p-3">
              <div className="flex items-end gap-2">
                <label className="min-w-0 flex-1">
                  <span className={LABEL}>{l.kind === "retention" ? "Retención" : "Medio"}</span>
                  {l.kind === "retention" ? (
                    <select
                      className={SELECT}
                      value={l.tax}
                      onChange={(e) => patch(l.key, { tax: e.target.value as ReceiptRetentionTax })}
                    >
                      {(Object.keys(RETENTION_TAX_LABEL) as ReceiptRetentionTax[]).map((t) => (
                        <option key={t} value={t} className="bg-popover text-popover-foreground">
                          {RETENTION_TAX_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      className={SELECT}
                      value={l.method}
                      onChange={(e) => patch(l.key, { method: e.target.value as ReceiptPayMethod })}
                    >
                      {methods.map((m) => (
                        <option key={m} value={m} className="bg-popover text-popover-foreground">
                          {RECEIPT_METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <label className="w-32 shrink-0">
                  <span className={LABEL}>Monto</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    className={cn(FIELD, "text-right tabular-nums")}
                    value={l.amount}
                    placeholder={amounts[i] ? String(amounts[i]) : "0"}
                    onChange={(e) => patch(l.key, { amount: e.target.value })}
                    aria-label={`Monto de la línea ${i + 1}`}
                  />
                </label>
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remove(l.key)}
                    className="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Quitar línea"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>

              {l.kind === "payment" && l.method === "transfer" && transferAccounts.length > 0 && (
                <label className="block">
                  <span className={LABEL}>¿A qué cuenta te transfirió?</span>
                  <select
                    className={SELECT}
                    value={l.transferAccount}
                    onChange={(e) => patch(l.key, { transferAccount: e.target.value })}
                  >
                    <option value="" className="bg-popover text-popover-foreground">
                      No sé o no importa
                    </option>
                    {transferAccounts.map((t) => (
                      <option key={t.id} value={t.id} className="bg-popover text-popover-foreground">
                        {t.bank_name}
                        {t.alias ? ` · ${t.alias}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {isCheque && (
                <div className="grid grid-cols-2 gap-2">
                  <label>
                    <span className={LABEL}>Número</span>
                    <input
                      className={FIELD}
                      value={l.chequeNumber}
                      maxLength={30}
                      onChange={(e) => patch(l.key, { chequeNumber: e.target.value })}
                    />
                  </label>
                  <label>
                    <span className={LABEL}>Fecha de pago</span>
                    <input
                      type="date"
                      className={FIELD}
                      value={l.chequePaymentDate}
                      onChange={(e) => patch(l.key, { chequePaymentDate: e.target.value })}
                    />
                  </label>
                  <label>
                    <span className={LABEL}>Banco</span>
                    <input
                      className={FIELD}
                      value={l.chequeBank}
                      maxLength={80}
                      onChange={(e) => patch(l.key, { chequeBank: e.target.value })}
                    />
                  </label>
                  <label>
                    <span className={LABEL}>CUIT del librador</span>
                    <input
                      className={FIELD}
                      inputMode="numeric"
                      value={l.chequeCuit}
                      maxLength={13}
                      onChange={(e) => patch(l.key, { chequeCuit: e.target.value })}
                    />
                  </label>
                  <label className="col-span-2">
                    <span className={LABEL}>Librador (opcional)</span>
                    <input
                      className={FIELD}
                      value={l.chequeDrawer}
                      maxLength={120}
                      onChange={(e) => patch(l.key, { chequeDrawer: e.target.value })}
                    />
                  </label>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    Entra a la cartera de cheques de Tesorería.
                  </p>
                </div>
              )}

              {l.kind === "retention" && (
                <div className="grid grid-cols-2 gap-2">
                  {l.tax === "iibb" && (
                    <label className="col-span-2">
                      <span className={LABEL}>Jurisdicción</span>
                      <select
                        className={SELECT}
                        value={l.jurisdiction}
                        onChange={(e) => patch(l.key, { jurisdiction: e.target.value })}
                      >
                        <option value="" className="bg-popover text-popover-foreground">
                          Elegí la jurisdicción
                        </option>
                        {JURISDICTIONS.map((j) => (
                          <option key={j.code} value={j.code} className="bg-popover text-popover-foreground">
                            {j.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="col-span-2">
                    <span className={LABEL}>Número de certificado</span>
                    <input
                      className={FIELD}
                      value={l.certificate}
                      maxLength={40}
                      onChange={(e) => patch(l.key, { certificate: e.target.value })}
                    />
                  </label>
                  <p className="col-span-2 text-xs text-muted-foreground">
                    Cancela deuda y queda en Impuestos, retenciones sufridas.
                  </p>
                </div>
              )}

              {!l.amount && (amounts[i] ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground">Toma lo que falta: {formatCurrency(amounts[i] ?? 0)}.</p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...lines, newDraftLine()])}>
          <Plus size={14} /> Agregar medio
        </Button>
        {allowRetentions && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange([...lines, newDraftLine("retention")])}
          >
            <Plus size={14} /> Agregar retención
          </Button>
        )}
      </div>
    </div>
  );
}
