"use client";

// Bandeja de facturas de compra (F24 · H167, ADR-178): fotos (sacadas con el
// celular) o PDF que se suben ahora y se cargan después. Con el complemento
// Asistente IA, "Leer con IA" precarga el comprobante; nunca graba solo: el
// formulario queda abierto para revisar y guardar.

import { useState } from "react";
import { Camera, Eye, FileUp, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Segmented } from "@/components/ui/Segmented";
import { useToast } from "@/components/ui/Toast";
import { purchaseErrorMessage } from "@/lib/purchases/orders";
import {
  INBOX_MIME,
  purchasesProApi,
  useOcrStatus,
  usePurchaseInbox,
  usePurchasesProMutations,
  type InboxRow,
  type InboxStatus,
} from "@/modules/purchases/pro";
import type { OcrInvoice } from "@/supabase/functions/_shared/purchaseInvoiceOcr";
import { InvoiceFormModal } from "./InvoiceFormModal";
import { fmtDate } from "./shared";

const OCR_ERRORS: Record<string, string> = {
  addon_required: "Leer facturas con IA viene con el complemento Asistente IA.",
  not_configured: "La lectura con IA todavía no está configurada.",
  quota_exceeded: "Llegaste al tope de uso de IA del mes.",
  ai_unreadable: "No pudimos leer el comprobante. Probá con una foto más nítida o cargalo a mano.",
  ai_refused: "La IA no pudo procesar este archivo. Cargalo a mano.",
  ai_disabled: "La lectura con IA está desactivada por ahora.",
  forbidden: "No tenés permiso para cargar compras.",
  feature_not_in_plan: "Compras no está incluido en tu plan.",
};

const STATUS_LABEL: Record<InboxStatus, string> = {
  pending: "Pendiente",
  processed: "Cargada",
  discarded: "Descartada",
};

const sizeText = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(b / 1024)} kB`);

export function InvoiceInboxModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<InboxStatus>("pending");
  const { data: rows = [], isLoading } = usePurchaseInbox(status, open);
  const ocr = useOcrStatus(open);
  const m = usePurchasesProMutations();
  const [reading, setReading] = useState<string | null>(null);
  const [form, setForm] = useState<{ inboxId: string; prefill: OcrInvoice | null; warnings: string[] } | null>(null);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    let ok = 0;
    for (const f of Array.from(files)) {
      if (!INBOX_MIME.includes(f.type)) {
        toast({ title: `${f.name}: formato no admitido`, description: "Usá JPG, PNG, WEBP o PDF.", variant: "error" });
        continue;
      }
      try {
        await m.uploadToInbox.mutateAsync({ file: f });
        ok++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        toast({
          title: `No se pudo subir ${f.name}`,
          description: msg.includes("file_too_large") ? "El archivo pasa los 10 MB." : purchaseErrorMessage(e),
          variant: "error",
        });
      }
    }
    if (ok > 0) toast({ title: ok === 1 ? "Factura en la bandeja" : `${ok} facturas en la bandeja`, variant: "success" });
  }

  async function read(row: InboxRow) {
    setReading(row.id);
    try {
      const r = await m.ocrExtract.mutateAsync(row.id);
      if (!r.ok) {
        toast({ title: "No se pudo leer", description: r.detail ?? OCR_ERRORS[r.error] ?? r.error, variant: "error" });
        return;
      }
      setForm({ inboxId: row.id, prefill: r.data, warnings: r.warnings });
    } finally {
      setReading(null);
    }
  }

  async function view(row: InboxRow) {
    const url = await purchasesProApi.inboxFileUrl(row.storage_path);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else toast({ title: "No se pudo abrir el archivo", variant: "error" });
  }

  async function setRowStatus(row: InboxRow, s: InboxStatus) {
    try {
      await m.inboxSetStatus.mutateAsync({ id: row.id, status: s });
    } catch (e) {
      toast({ title: "No se pudo cambiar", description: purchaseErrorMessage(e), variant: "error" });
    }
  }

  const ocrAllowed = Boolean(ocr.data?.allowed && ocr.data.configured);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title="Bandeja de facturas"
        description="Sacá una foto o subí el PDF ahora y cargalo después."
        className="sm:max-w-3xl"
      >
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-3 rounded-md bg-muted px-4 py-3 text-sm hover:bg-muted/70">
              <Camera size={18} className="text-muted-foreground" />
              <span className="flex-1">Sacar foto</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-md bg-muted px-4 py-3 text-sm hover:bg-muted/70">
              <FileUp size={18} className="text-muted-foreground" />
              <span className="flex-1">Subir PDF o imagen</span>
              <input
                type="file"
                multiple
                accept="application/pdf,image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {m.uploadToInbox.isPending && <p className="text-sm text-muted-foreground">Subiendo...</p>}
          {ocr.data && !ocrAllowed && (
            <Callout tone="neutral">
              {ocr.data.addon
                ? "La lectura con IA no está disponible ahora: podés cargar las facturas a mano desde la bandeja."
                : "Con el complemento Asistente IA, NinjaSoft lee la factura y te la deja precargada para revisar."}
            </Callout>
          )}

          <Segmented<InboxStatus>
            aria-label="Estado"
            value={status}
            onChange={setStatus}
            size="sm"
            options={[
              { value: "pending", label: "Pendientes" },
              { value: "processed", label: "Cargadas" },
              { value: "discarded", label: "Descartadas" },
            ]}
          />

          {isLoading ? (
            <p className="py-4 text-sm text-muted-foreground">Cargando...</p>
          ) : rows.length === 0 ? (
            <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">
              {status === "pending" ? "No hay facturas pendientes." : "No hay facturas en esta lista."}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.file_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtDate(r.created_at.slice(0, 10))} · {sizeText(r.size_bytes)}
                      {r.extracted ? " · leída con IA" : ""}
                    </div>
                  </div>
                  <Badge tone={r.status === "processed" ? "success" : r.status === "discarded" ? "neutral" : "warning"}>
                    {STATUS_LABEL[r.status]}
                  </Badge>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" aria-label="Ver archivo" onClick={() => void view(r)}>
                      <Eye size={14} />
                    </Button>
                    {r.status === "pending" && (
                      <>
                        {ocrAllowed && (
                          <Button size="sm" loading={reading === r.id} onClick={() => void read(r)}>
                            <Sparkles size={14} /> {r.extracted ? "Volver a leer" : "Leer con IA"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setForm({ inboxId: r.id, prefill: r.extracted, warnings: [] })}
                        >
                          {r.extracted ? "Cargar con lo leído" : "Cargar a mano"}
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Descartar" onClick={() => void setRowStatus(r, "discarded")}>
                          <Trash2 size={14} />
                        </Button>
                      </>
                    )}
                    {r.status === "discarded" && (
                      <Button size="sm" variant="ghost" onClick={() => void setRowStatus(r, "pending")}>
                        <Undo2 size={14} /> Recuperar
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
      <InvoiceFormModal
        open={Boolean(form)}
        onOpenChange={(o) => !o && setForm(null)}
        prefill={form?.prefill ?? null}
        inboxId={form?.inboxId ?? null}
        prefillWarnings={form?.warnings ?? []}
      />
    </>
  );
}
