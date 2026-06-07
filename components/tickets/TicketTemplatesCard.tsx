"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Mail, Pencil, Plus, Printer, Receipt, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  useClearActiveTemplate,
  useCreateTemplate,
  useRemoveTemplate,
  useSetActiveTemplate,
  useTenantSmtpStatus,
  useTicketTemplates,
} from "@/modules/tickets/hooks";
import { defaultSaleBlocks, type TemplateContent } from "@/lib/tickets/blocks";
import type {
  TemplateDestination,
  TemplateKind,
  TemplateMode,
  TicketTemplate,
} from "@/modules/tickets/api";
import { TicketTemplateEditor } from "@/components/tickets/TicketTemplateEditor";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

const KIND_LABELS: Record<TemplateKind, string> = {
  sale: "Venta",
  promo: "Promo",
  gift: "Gift",
};
const PAPER_LABELS: Record<string, string> = { "58": "58 mm", "80": "80 mm", a4: "A4" };
const MODE_LABELS: Record<TemplateMode, string> = {
  blocks: "Bloques",
  canvas: "Canvas",
  html: "HTML",
};

function useTenantId() {
  const supabase = createClient();
  return useQuery({
    queryKey: ["my-tenant-id"],
    queryFn: async (): Promise<string | null> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      return mem?.tenant_id ?? null;
    },
  });
}

export function TicketTemplatesCard() {
  const { toast } = useToast();
  const { data: tenantId } = useTenantId();
  const { data: templates } = useTicketTemplates();
  const create = useCreateTemplate();
  const setActive = useSetActiveTemplate();
  const clearActive = useClearActiveTemplate();
  const remove = useRemoveTemplate();
  const { data: smtp } = useTenantSmtpStatus();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TicketTemplate | null>(null);
  const [toDelete, setToDelete] = useState<TicketTemplate | null>(null);

  function openNew() {
    setEditing(null);
    setEditorOpen(true);
  }

  function openEdit(t: TicketTemplate) {
    setEditing(t);
    setEditorOpen(true);
  }

  function duplicate(t: TicketTemplate) {
    if (!tenantId) return;
    create.mutate(
      {
        tenantId,
        input: {
          name: `${t.name} (copia)`,
          kind: t.kind as TemplateKind,
          mode: (t.mode as TemplateMode) ?? "blocks",
          paper: t.paper as "58" | "80" | "a4",
          content: (t.content as unknown as TemplateContent) ?? { blocks: defaultSaleBlocks() },
          show_ninjasoft_logo: Boolean(t.show_ninjasoft_logo),
        },
      },
      {
        onSuccess: () => toast({ title: "Modelo duplicado", variant: "success" }),
        onError: () => toast({ title: "No se pudo duplicar", variant: "error" }),
      },
    );
  }

  const DEST_LABELS: Record<TemplateDestination, string> = {
    print: "impresión",
    email: "email",
  };

  // Click en un destino: si ya está activo en ese modelo → lo desactiva (fallback
  // al ticket clásico); si no, lo activa (y desactiva el anterior del destino).
  function toggleActive(t: TicketTemplate, destination: TemplateDestination) {
    const col = destination === "print" ? t.print_active : t.email_active;
    if (col) {
      clearActive.mutate(destination, {
        onSuccess: () =>
          toast({ title: `Sin modelo de ${DEST_LABELS[destination]}`, variant: "success" }),
        onError: () => toast({ title: "No se pudo desactivar", variant: "error" }),
      });
    } else {
      // Al activar Email sin SMTP configurado: igual se activa, pero avisamos
      // que falta configurar el email del negocio para poder enviar. Quien
      // gestiona plantillas es owner/manager → `configured` es confiable acá.
      const warnNoSmtp = destination === "email" && smtp != null && !smtp.configured;
      setActive.mutate(
        { id: t.id, destination },
        {
          onSuccess: () =>
            warnNoSmtp
              ? toast({
                  title:
                    "Activado. Falta configurar el email del negocio en Configuración → Email para poder enviar.",
                  variant: "info",
                })
              : toast({
                  title: `Activado para ${DEST_LABELS[destination]}`,
                  variant: "success",
                }),
          onError: () => toast({ title: "No se pudo activar", variant: "error" }),
        },
      );
    }
  }

  function del(t: TicketTemplate) {
    setToDelete(t);
  }

  function confirmDelete() {
    if (!toDelete) return;
    remove.mutate(toDelete.id, {
      onSuccess: () => {
        toast({ title: "Modelo eliminado", variant: "success" });
        setToDelete(null);
      },
      onError: () => toast({ title: "No se pudo eliminar", variant: "error" }),
    });
  }

  const list = templates ?? [];

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
              <Receipt size={18} />
            </span>
            <div>
              <Heading as="h3" className="text-base">
                Modelos de ticket
              </Heading>
              <p className="text-sm text-muted-foreground">
                Diseñá cómo se imprimen tus comprobantes con bloques arrastrables.
              </p>
            </div>
          </div>
          <Button onClick={openNew} disabled={!tenantId}>
            <Plus size={16} /> Nuevo modelo
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Un modelo activo para impresión y uno para email. Sin activo se usa el
          ticket clásico.
        </p>

        <div className="space-y-1.5">
          {list.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Sin modelos todavía. Creá el primero con “Nuevo modelo”.
            </p>
          )}
          {list.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{t.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {MODE_LABELS[t.mode as TemplateMode] ?? t.mode}
                </span>
                <span className="text-xs text-muted-foreground">
                  {KIND_LABELS[t.kind as TemplateKind] ?? t.kind} ·{" "}
                  {PAPER_LABELS[t.paper] ?? t.paper}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <DestChip
                  active={t.print_active}
                  icon={<Printer size={13} />}
                  label="Impresión"
                  title={
                    t.print_active
                      ? "Activo para impresión — clic para usar el ticket clásico"
                      : "Activar este modelo para impresión"
                  }
                  onClick={() => toggleActive(t, "print")}
                />
                <DestChip
                  active={t.email_active}
                  icon={<Mail size={13} />}
                  label="Email"
                  title={
                    t.email_active
                      ? "Activo para email — clic para usar el ticket clásico"
                      : "Activar este modelo para email"
                  }
                  onClick={() => toggleActive(t, "email")}
                />
                <RowBtn title="Editar" onClick={() => openEdit(t)}>
                  <Pencil size={15} />
                </RowBtn>
                <RowBtn title="Duplicar" onClick={() => duplicate(t)}>
                  <Copy size={15} />
                </RowBtn>
                <RowBtn title="Eliminar" danger onClick={() => del(t)}>
                  <Trash2 size={15} />
                </RowBtn>
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      {tenantId && (
        <TicketTemplateEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          template={editing}
          tenantId={tenantId}
        />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Eliminar modelo"
        description={toDelete ? `¿Eliminar el modelo "${toDelete.name}"? Es una baja lógica.` : undefined}
        confirmLabel="Eliminar"
        danger
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}

function DestChip({
  active,
  icon,
  label,
  title,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition",
        active
          ? "border-ninja-flameSoft/50 bg-ninja-flame/15 text-ninja-flameSoft"
          : "border-border text-muted-foreground hover:border-ninja-flameSoft/40 hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function RowBtn({
  children,
  title,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground",
        danger && "hover:text-destructive",
      )}
    >
      {children}
    </button>
  );
}
