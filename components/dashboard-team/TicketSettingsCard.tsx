"use client";

// Ajustes básicos del ticket (Configuración › Ticket). Antes vivían en
// "Marca del negocio"; se separaron para no mezclar marca con comprobante.
// Son campos BASE de tenant_branding (cualquier plan; el trigger de
// `personalizacion_marca` sólo mira logo y acento). Se guardan con UPDATE de
// estas columnas, sin tocar logo/acento.
//
// El QR es obligatorio: no hay toggle y `ticket_show_qr` se ignora en el
// render (lib/tickets/requiredQr.ts).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QrCode } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { fetchMyMembership } from "@/lib/tenant/myMembership";

type TicketForm = {
  ticket_width: string;
  ticket_title: string | null;
  ticket_legend: string | null;
  ticket_footer: string | null;
  ticket_show_logo: boolean;
};

type Ctx = { tenantId: string; canManage: boolean; exists: boolean; form: TicketForm } | null;

const COLUMNS = "ticket_width, ticket_title, ticket_legend, ticket_footer, ticket_show_logo";

export function TicketSettingsCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<TicketForm | null>(null);

  const { data: ctx } = useQuery<Ctx>({
    queryKey: ["my-ticket-settings-ctx"],
    queryFn: async (): Promise<Ctx> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const mem = await fetchMyMembership<{ tenant_id: string; role: string }>(supabase, user, "tenant_id, role");
      if (!mem) return null;
      const canManage = ["owner", "manager"].includes(mem.role);
      const empty: TicketForm = {
        ticket_width: "80",
        ticket_title: null,
        ticket_legend: null,
        ticket_footer: null,
        ticket_show_logo: true,
      };
      if (!canManage) return { tenantId: mem.tenant_id, canManage, exists: false, form: empty };
      const { data: b } = await supabase
        .from("tenant_branding")
        .select(COLUMNS)
        .eq("tenant_id", mem.tenant_id)
        .maybeSingle();
      return {
        tenantId: mem.tenant_id,
        canManage,
        exists: Boolean(b),
        form: {
          ticket_width: b?.ticket_width === "58" ? "58" : "80",
          ticket_title: b?.ticket_title ?? null,
          ticket_legend: b?.ticket_legend ?? null,
          ticket_footer: b?.ticket_footer ?? null,
          ticket_show_logo: b?.ticket_show_logo == null ? true : Boolean(b.ticket_show_logo),
        },
      };
    },
  });

  useEffect(() => {
    if (ctx?.canManage) setForm(ctx.form);
  }, [ctx]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form || !ctx) return;
      const patch = {
        ticket_width: form.ticket_width,
        ticket_title: form.ticket_title?.trim() || null,
        ticket_legend: form.ticket_legend?.trim() || null,
        ticket_footer: form.ticket_footer?.trim() || null,
        ticket_show_logo: form.ticket_show_logo,
      };
      // UPDATE (no upsert): un upsert dispararía el trigger de branding con el
      // acento por defecto y fallaría en planes sin personalización de marca.
      const { error } = ctx.exists
        ? await supabase.from("tenant_branding").update(patch).eq("tenant_id", ctx.tenantId)
        : await supabase.from("tenant_branding").insert({ tenant_id: ctx.tenantId, ...patch });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Ticket guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["my-ticket-settings-ctx"] });
      qc.invalidateQueries({ queryKey: ["my-branding-ctx"] });
      qc.invalidateQueries({ queryKey: ["ticket-branding"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || !ctx.canManage || !form) return null;

  function set<K extends keyof TicketForm>(k: K, v: TicketForm[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }

  return (
    <Card>
      <CardContent className="space-y-6 p-5 sm:p-6">
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">Ancho de ticket</span>
          <Segmented
            value={form.ticket_width}
            onChange={(v) => set("ticket_width", v)}
            options={[
              { value: "80", label: "80 mm" },
              { value: "58", label: "58 mm" },
            ]}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Título del comprobante"
            placeholder="Comprobante no fiscal"
            value={form.ticket_title ?? ""}
            onChange={(e) => set("ticket_title", e.target.value)}
          />
          <Input
            label="Leyenda extra (pie)"
            placeholder="Cambios dentro de 30 días con ticket"
            value={form.ticket_legend ?? ""}
            onChange={(e) => set("ticket_legend", e.target.value)}
          />
        </div>
        <Input
          label="Pie de ticket"
          placeholder="¡Gracias por su compra!"
          value={form.ticket_footer ?? ""}
          onChange={(e) => set("ticket_footer", e.target.value)}
        />

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="block text-sm font-medium text-foreground">Mostrar logo en el ticket</span>
            <span className="block text-xs text-muted-foreground">
              Si lo desactivás, el ticket no imprime el logo (ahorra tinta en térmica).
            </span>
          </div>
          <Switch
            checked={form.ticket_show_logo}
            onCheckedChange={(v) => set("ticket_show_logo", v)}
            label="Mostrar logo en el ticket"
          />
        </div>

        <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-background text-ninja-flameSoft">
            <QrCode size={16} aria-hidden />
          </span>
          <p className="text-xs text-muted-foreground">
            <span className="block text-sm font-medium text-foreground">El QR se imprime siempre</span>
            Todo ticket lleva un QR con los datos de la venta (negocio, número, total y fecha) o, si
            la venta tiene factura electrónica, el QR fiscal de ARCA.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Guardar ticket
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
