"use client";

import { useEffect, useMemo, useState } from "react";
import { History, Info } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Callout } from "@/components/ui/Callout";
import { CardBrandLogo } from "@/components/ui/ThemedLogo";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { KIND_LABEL, dayLabel, localTime, type CardRecRow } from "@/lib/reports/cardReconciliation";
import {
  VOUCHER_FIELDS,
  VOUCHER_FIELD_LABEL,
  buildVoucherPatch,
  voucherDraftFrom,
  voucherErrorMessage,
  type VoucherDraft,
  type VoucherEdit,
  type VoucherField,
} from "@/lib/reports/voucherEdit";
import { useUpdateVoucher } from "@/modules/reports/cardReconciliation";

const NUMERIC: Record<VoucherField, boolean> = {
  lote: true,
  cupon: true,
  autorizacion: false,
  ultimos4: true,
  comercio: true,
  cuotas: true,
};

const MAX_LENGTH: Record<VoucherField, number> = {
  lote: 10,
  cupon: 12,
  autorizacion: 20,
  ultimos4: 4,
  comercio: 20,
  cuotas: 2,
};

export function formatEditStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${localTime(iso)}`;
}

/**
 * Corrección de la numeración del cupón de un cobro con tarjeta. Hoja inferior
 * en mobile, diálogo compacto desde sm. La RPC decide permisos y valida; acá se
 * valida igual para avisar antes.
 */
export function VoucherEditModal({
  row,
  ticket,
  edits,
  asSupervisor,
  onOpenChange,
}: {
  row: CardRecRow | null;
  ticket: string | null;
  edits: VoucherEdit[];
  asSupervisor: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const mutation = useUpdateVoucher();
  const initial = useMemo<VoucherDraft | null>(() => (row ? voucherDraftFrom(row) : null), [row]);
  const [draft, setDraft] = useState<VoucherDraft | null>(initial);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState<Partial<Record<VoucherField, boolean>>>({});

  useEffect(() => {
    setDraft(initial);
    setReason("");
    setTouched({});
  }, [initial]);

  const result = useMemo(
    () => (initial && draft ? buildVoucherPatch(initial, draft) : null),
    [initial, draft],
  );
  const hasErrors = result ? Object.keys(result.errors).length > 0 : false;
  const canSave = Boolean(result && !hasErrors && result.changed.length > 0) && !mutation.isPending;

  async function save() {
    if (!row || !result || !canSave) {
      setTouched(Object.fromEntries(VOUCHER_FIELDS.map((f) => [f, true])));
      return;
    }
    try {
      await mutation.mutateAsync({ paymentId: row.id, patch: result.patch, reason: reason.trim() || null });
      toast({
        title: "Cupón actualizado",
        description:
          result.changed.length === 1
            ? `Se corrigió ${VOUCHER_FIELD_LABEL[result.changed[0]!].toLowerCase()}.`
            : `Se corrigieron ${result.changed.length} datos.`,
        variant: "success",
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "No se pudo guardar", description: voucherErrorMessage(e), variant: "error" });
    }
  }

  const last = edits[0];

  return (
    <Modal
      open={row !== null}
      onOpenChange={onOpenChange}
      title="Editar cupón"
      className="sm:max-w-md"
      header={
        row ? (
          <div className="min-w-0">
            <p className="text-lg font-bold tracking-tight">Editar cupón</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {row.brandKey ? <CardBrandLogo brand={row.brandKey} label={row.brandLabel} height={14} /> : null}
              <span className="text-foreground">{row.brandLabel || "Sin marca"}</span>
              <span aria-hidden>·</span>
              <span>{KIND_LABEL[row.kind]}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {dayLabel(row.day)} {localTime(row.createdAt)}
              </span>
              {ticket ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">Ticket {ticket}</span>
                </>
              ) : null}
            </div>
            <p className="mt-2 font-price text-xl font-bold tabular-nums">{formatCurrency(row.amount)}</p>
          </div>
        ) : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!canSave} loading={mutation.isPending}>
            Guardar cambios
          </Button>
        </>
      }
    >
      {row && draft ? (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {row.reconciledAt && asSupervisor ? (
            <Callout tone="warning" icon={Info}>
              Este cobro ya está conciliado. Si lo corregís sigue conciliado y queda marcado como editado para revisarlo.
            </Callout>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            {VOUCHER_FIELDS.map((f) => {
              const err = touched[f] ? result?.errors[f] : undefined;
              return (
                <Input
                  key={f}
                  variant="filled"
                  label={VOUCHER_FIELD_LABEL[f]}
                  value={draft[f]}
                  inputMode={NUMERIC[f] ? "numeric" : "text"}
                  autoComplete="off"
                  maxLength={MAX_LENGTH[f]}
                  placeholder="Sin cargar"
                  className="tabular-nums"
                  error={err}
                  onBlur={() => setTouched((t) => ({ ...t, [f]: true }))}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const v = f === "ultimos4" || f === "cuotas" ? raw.replace(/\D/g, "") : raw;
                    setDraft((d) => (d ? { ...d, [f]: v } : d));
                  }}
                />
              );
            })}
          </div>

          <Input
            variant="filled"
            label="Motivo (opcional)"
            value={reason}
            maxLength={300}
            placeholder="Ej.: el cajero cargó mal el lote"
            onChange={(e) => setReason(e.target.value)}
          />

          <div className="rounded-lg bg-muted/50 px-3.5 py-3 text-sm">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <History size={14} aria-hidden /> Historial
            </div>
            {last ? (
              <ul className="mt-2 space-y-2.5">
                {edits.slice(0, 4).map((e) => (
                  <li key={e.id} className="min-w-0">
                    <p className="text-foreground">
                      {e.editedBy}
                      <span className="text-muted-foreground"> · {formatEditStamp(e.editedAt)}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {e.changes
                        .map((c) => `${VOUCHER_FIELD_LABEL[c.field]}: de ${c.before || "vacío"} a ${c.after || "vacío"}`)
                        .join(", ")}
                      {e.wasReconciled ? ". Ya estaba conciliado" : ""}
                      {e.reason ? `. Motivo: ${e.reason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-muted-foreground">Sin ediciones. Los datos son los que cargó el cajero al cobrar.</p>
            )}
          </div>
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
      ) : null}
    </Modal>
  );
}
