"use client";

import { useRef, useState } from "react";
import { Download, Eye, FileText, Paperclip, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { useMyTenant } from "@/modules/tenants/hooks";
import {
  attachmentUrl,
  useCustomerAttachmentMutations,
  useCustomerAttachments,
  type CustomerAttachment,
} from "@/modules/customers/c360";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_TYPES,
  attachmentErrorMessage,
  checkAttachment,
  formatBytes,
} from "@/lib/customers/attachments";

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

// Adjuntos de la ficha (ADR-169): contratos, constancias, fotos del DNI.
// Bucket privado customer-files; se abren con un link temporal. Quitar es una
// baja lógica (queda en la línea de tiempo).
export function C360Attachments({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const { data: me } = useMyTenant();
  const q = useCustomerAttachments(customerId);
  const { upload, remove } = useCustomerAttachmentMutations(customerId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [toDelete, setToDelete] = useState<CustomerAttachment | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  function pick(f: File | null) {
    if (!f) return;
    const c = checkAttachment(f);
    if (!c.ok) {
      toast({ title: "No se puede adjuntar", description: c.reason, variant: "error" });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(f);
  }

  function save() {
    if (!file || !me?.tenantId) return;
    upload.mutate(
      { tenantId: me.tenantId, file, note },
      {
        onSuccess: () => {
          setFile(null);
          setNote("");
          if (inputRef.current) inputRef.current.value = "";
          toast({ title: "Archivo adjuntado", variant: "success" });
        },
        onError: (e) => toast({ title: "No se pudo adjuntar", description: attachmentErrorMessage(e), variant: "error" }),
      },
    );
  }

  async function open(a: CustomerAttachment, download: boolean) {
    setOpening(a.id);
    try {
      const url = await attachmentUrl(a.storage_path, download ? a.file_name : undefined);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast({ title: "No se pudo abrir el archivo", variant: "error" });
    } finally {
      setOpening(null);
    }
  }

  const items = q.data ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Paperclip size={15} className="text-muted-foreground" /> Adjuntos
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Contratos, constancias o fotos de documentos. Sólo los ve tu equipo. PDF, imagen, Word, Excel o texto, hasta 10 MB.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Archivo</span>
          <input
            ref={inputRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
          />
        </label>
        {file && (
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="Nota (opcional)"
            className="sm:w-56"
            aria-label="Nota del adjunto"
          />
        )}
        <Button onClick={save} disabled={!file || !me?.tenantId} loading={upload.isPending}>
          <Upload size={15} /> Adjuntar
        </Button>
      </div>

      <div className="mt-4">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando adjuntos...</p>
        ) : q.isError ? (
          <p className="text-sm text-danger">No se pudieron cargar los adjuntos.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay archivos adjuntos.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <FileText size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{a.file_name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {ATTACHMENT_TYPES[a.mime_type] ?? "Archivo"} · {formatBytes(a.size_bytes)} · {when(a.created_at)}
                    {a.note ? ` · ${a.note}` : ""}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  className="h-9 w-9 shrink-0 p-0"
                  aria-label={`Ver ${a.file_name}`}
                  loading={opening === a.id}
                  onClick={() => void open(a, false)}
                >
                  <Eye size={15} />
                </Button>
                <Button
                  variant="ghost"
                  className="hidden h-9 w-9 shrink-0 p-0 sm:inline-flex"
                  aria-label={`Descargar ${a.file_name}`}
                  onClick={() => void open(a, true)}
                >
                  <Download size={15} />
                </Button>
                <Button
                  variant="ghost"
                  className="h-9 w-9 shrink-0 p-0 text-muted-foreground hover:text-danger"
                  aria-label={`Quitar ${a.file_name}`}
                  onClick={() => setToDelete(a)}
                >
                  <Trash2 size={15} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Quitar el adjunto"
        description={
          toDelete
            ? `"${toDelete.file_name}" deja de verse en la ficha. Queda registrado en la línea de tiempo. Lo puede quitar quien lo subió o un encargado.`
            : undefined
        }
        confirmLabel="Quitar"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!toDelete) return;
          remove.mutate(toDelete.id, {
            onSuccess: () => {
              setToDelete(null);
              toast({ title: "Adjunto quitado", variant: "success" });
            },
            onError: (e) => toast({ title: "No se pudo quitar", description: attachmentErrorMessage(e), variant: "error" }),
          });
        }}
      />
    </section>
  );
}
