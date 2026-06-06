"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Receipt, Star, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";
import {
  useCreateTemplate,
  useRemoveTemplate,
  useSetDefaultTemplate,
  useTicketTemplates,
} from "@/modules/tickets/hooks";
import { defaultSaleBlocks, type BlocksContent } from "@/lib/tickets/blocks";
import type { TemplateKind, TicketTemplate } from "@/modules/tickets/api";
import { TicketTemplateEditor } from "@/components/tickets/TicketTemplateEditor";

const KIND_LABELS: Record<TemplateKind, string> = {
  sale: "Venta",
  promo: "Promo",
  gift: "Gift",
};
const PAPER_LABELS: Record<string, string> = { "58": "58 mm", "80": "80 mm", a4: "A4" };

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
  const setDefault = useSetDefaultTemplate();
  const remove = useRemoveTemplate();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TicketTemplate | null>(null);

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
          mode: "blocks",
          paper: t.paper as "58" | "80" | "a4",
          content: (t.content as unknown as BlocksContent) ?? { blocks: defaultSaleBlocks() },
          show_ninjasoft_logo: Boolean(t.show_ninjasoft_logo),
        },
      },
      {
        onSuccess: () => toast({ title: "Modelo duplicado", variant: "success" }),
        onError: () => toast({ title: "No se pudo duplicar", variant: "error" }),
      },
    );
  }

  function makeDefault(t: TicketTemplate) {
    setDefault.mutate(
      { id: t.id, kind: t.kind as TemplateKind },
      {
        onSuccess: () => toast({ title: "Marcado como predeterminado", variant: "success" }),
        onError: () => toast({ title: "No se pudo marcar", variant: "error" }),
      },
    );
  }

  function del(t: TicketTemplate) {
    if (!window.confirm(`¿Eliminar el modelo "${t.name}"?`)) return;
    remove.mutate(t.id, {
      onSuccess: () => toast({ title: "Modelo eliminado", variant: "success" }),
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
                {t.is_default && (
                  <span className="rounded-full bg-ninja-flame/15 px-2 py-0.5 text-xs font-medium text-ninja-flameSoft">
                    Default
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {KIND_LABELS[t.kind as TemplateKind] ?? t.kind} ·{" "}
                  {PAPER_LABELS[t.paper] ?? t.paper}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <RowBtn title="Editar" onClick={() => openEdit(t)}>
                  <Pencil size={15} />
                </RowBtn>
                <RowBtn title="Duplicar" onClick={() => duplicate(t)}>
                  <Copy size={15} />
                </RowBtn>
                {!t.is_default && (
                  <RowBtn title="Marcar predeterminado" onClick={() => makeDefault(t)}>
                    <Star size={15} />
                  </RowBtn>
                )}
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
    </Card>
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
