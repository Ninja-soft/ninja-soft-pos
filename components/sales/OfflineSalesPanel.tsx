"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudOff } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { useProductsByIds } from "@/modules/products/hooks";
import { useOpenShift } from "@/modules/pos/hooks";
import {
  offlineApi,
  offlineRowNeedsAttention,
  type OfflineResolveAction,
  type OfflineSaleRow,
} from "@/modules/pos/offline/api";
import { provisionalCode } from "@/lib/pos/offline/queue";
import { conflictLabel, offlineErrorLabel, reasonLabel } from "@/lib/pos/offline/sync";

// "Ventas offline con problemas" (ADR-077): lo que no se pudo registrar al
// sincronizar queda acá para el dueño o encargado; nunca se pierde. También
// las registradas con diferencias (precio cambiado, stock negativo) hasta que
// alguien las da por vistas.

const STATUS: Record<string, { label: string; dot: string }> = {
  needs_review: { label: "Requiere revisión", dot: "bg-warning" },
  synced: { label: "Registrada", dot: "bg-success" },
  resolved: { label: "Resuelta", dot: "bg-info" },
  discarded: { label: "Descartada", dot: "bg-muted-foreground" },
  processing: { label: "Procesando", dot: "bg-info" },
};

type NoteAction = Extract<OfflineResolveAction, "discard" | "resolve">;

export function OfflineSalesPanel({ storeId, canResolve }: { storeId: string | null; canResolve: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"problems" | "all">("problems");
  const { data: rows, isLoading } = useQuery({
    queryKey: ["offline-sales", filter, storeId],
    queryFn: () => offlineApi.list(filter, storeId),
  });
  const { data: myShift } = useOpenShift();
  const productIds = useMemo(
    () => [
      ...new Set(
        (rows ?? []).flatMap((r) => (r.conflicts ?? []).map((c) => c.product_id).filter((x): x is string => !!x)),
      ),
    ],
    [rows],
  );
  const { data: products } = useProductsByIds(productIds);
  const nameOf = (id?: string | null) => (id ? (products ?? []).find((p) => p.id === id)?.name ?? null : null);

  const [noteFor, setNoteFor] = useState<{ row: OfflineSaleRow; action: NoteAction } | null>(null);
  const [note, setNote] = useState("");

  const resolve = useMutation({
    mutationFn: (v: { id: string; action: OfflineResolveAction; note: string | null; shiftId: string | null }) =>
      offlineApi.resolve(v.id, v.action, v.note, v.shiftId),
    onSuccess: (res, v) => {
      void qc.invalidateQueries({ queryKey: ["offline-sales"] });
      void qc.invalidateQueries({ queryKey: ["sales"] });
      if (v.action === "retry") {
        toast(
          res.status === "synced"
            ? { title: `Venta #${res.sale_number} registrada`, variant: "success" }
            : {
                title: "Sigue sin poder registrarse",
                description: offlineErrorLabel(res.error) ?? undefined,
                variant: "error",
              },
        );
      } else {
        toast({ title: "Listo", variant: "success" });
      }
      setNoteFor(null);
      setNote("");
    },
    onError: (e) => toast({ title: "No se pudo", description: e instanceof Error ? e.message : undefined, variant: "error" }),
  });

  return (
    <div className="space-y-4">
      <Segmented
        aria-label="Filtro"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "problems", label: "Con problemas" },
          { value: "all", label: "Todas" },
        ]}
      />
      {isLoading ? (
        <div className="grid place-items-center py-12">
          <Spinner />
        </div>
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          icon={CloudOff}
          title={filter === "problems" ? "No hay ventas offline con problemas" : "Todavía no hay ventas offline"}
          description="Las ventas hechas sin conexión se registran solas cuando el POS vuelve a tener internet."
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card" data-testid="offline-sales-list">
          {rows.map((r) => {
            const st = STATUS[r.status] ?? STATUS.processing!;
            const total = r.sale_total ?? r.meta?.total ?? null;
            const attention = offlineRowNeedsAttention(r);
            return (
              <li key={r.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-sm font-semibold">{provisionalCode(r.client_sale_id)}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className={cn("h-2 w-2 rounded-full", st.dot)} />
                    {st.label}
                    {r.status === "synced" && r.sale_number ? ` · Venta #${r.sale_number}` : ""}
                  </span>
                  <span className="ml-auto text-sm font-semibold tabular-nums">
                    {total != null ? formatCurrency(Number(total)) : ""}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Vendida el {new Date(r.sold_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                  {r.attempts > 1 ? ` · ${r.attempts} intentos` : ""}
                </p>
                {(r.reasons ?? []).length > 0 && (
                  <ul className="space-y-0.5 text-sm">
                    {r.reasons.map((x) => (
                      <li key={x}>{x === "sale_rejected" ? offlineErrorLabel(r.error) ?? reasonLabel(x) : reasonLabel(x)}</li>
                    ))}
                  </ul>
                )}
                {(r.conflicts ?? []).length > 0 && (
                  <ul className="space-y-0.5 text-sm">
                    {r.conflicts.map((c, i) => (
                      <li key={i}>{conflictLabel(c, nameOf(c.product_id))}</li>
                    ))}
                  </ul>
                )}
                {r.resolution_note && <p className="text-xs text-muted-foreground">Nota: {r.resolution_note}</p>}
                {canResolve && attention && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {r.status === "needs_review" ? (
                      <>
                        <Button
                          size="sm"
                          disabled={resolve.isPending}
                          onClick={() =>
                            resolve.mutate({ id: r.id, action: "retry", note: null, shiftId: myShift?.id ?? null })
                          }
                        >
                          {myShift ? "Registrar en mi caja" : "Reintentar"}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setNoteFor({ row: r, action: "resolve" })}>
                          Marcar resuelta
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNoteFor({ row: r, action: "discard" })}>
                          Descartar
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={resolve.isPending}
                        onClick={() => resolve.mutate({ id: r.id, action: "acknowledge", note: null, shiftId: null })}
                      >
                        Dar por vista
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal
        open={noteFor !== null}
        onOpenChange={(o) => {
          if (!o) {
            setNoteFor(null);
            setNote("");
          }
        }}
        title={noteFor?.action === "discard" ? "Descartar venta offline" : "Marcar como resuelta"}
        description={
          noteFor?.action === "discard"
            ? "La venta no se registra. Queda guardada con el motivo para auditoría."
            : "Usalo si la registraste a mano o se resolvió por otro lado."
        }
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => setNoteFor(null)}>
              Cancelar
            </Button>
            <Button
              variant={noteFor?.action === "discard" ? "destructive" : "primary"}
              disabled={note.trim().length < 3 || resolve.isPending}
              onClick={() =>
                noteFor && resolve.mutate({ id: noteFor.row.id, action: noteFor.action, note: note.trim(), shiftId: null })
              }
            >
              Confirmar
            </Button>
          </div>
        }
      >
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">Motivo</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </Modal>
    </div>
  );
}
