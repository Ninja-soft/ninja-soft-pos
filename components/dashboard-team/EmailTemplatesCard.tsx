"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  EMAIL_TEMPLATES,
  renderTemplate,
  sampleVars,
} from "@/lib/email/templates";
import { cn } from "@/lib/utils/cn";

type Ctx = { tenantId: string; canManage: boolean; negocio: string } | null;
type Saved = Record<string, { subject: string; html: string }>;

export function EmailTemplatesCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedKey, setSelectedKey] = useState(EMAIL_TEMPLATES[0]!.key);
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");

  const { data: ctx } = useQuery<Ctx>({
    queryKey: ["my-emails-ctx"],
    queryFn: async (): Promise<Ctx> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role, tenants(name)")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      const negocio =
        (mem.tenants as unknown as { name: string } | null)?.name ?? "tu negocio";
      return {
        tenantId: mem.tenant_id,
        canManage: ["owner", "manager"].includes(mem.role),
        negocio,
      };
    },
  });

  const { data: saved = {} } = useQuery<Saved>({
    queryKey: ["email-templates", ctx?.tenantId],
    enabled: !!ctx?.tenantId,
    queryFn: async (): Promise<Saved> => {
      const { data } = await supabase
        .from("email_templates")
        .select("key, subject, html")
        .eq("tenant_id", ctx!.tenantId);
      const map: Saved = {};
      (data ?? []).forEach((t) => (map[t.key] = { subject: t.subject, html: t.html }));
      return map;
    },
  });

  const def = EMAIL_TEMPLATES.find((t) => t.key === selectedKey)!;

  // Cargar el contenido del template elegido (override guardado o default).
  useEffect(() => {
    const ov = saved[selectedKey];
    setSubject(ov?.subject ?? def.defaultSubject);
    setHtml(ov?.html ?? def.defaultHtml);
  }, [selectedKey, saved, def.defaultSubject, def.defaultHtml]);

  const save = useMutation({
    mutationFn: async () => {
      if (!ctx) return;
      const { error } = await supabase.from("email_templates").upsert(
        { tenant_id: ctx.tenantId, key: selectedKey, subject, html },
        { onConflict: "tenant_id,key" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Plantilla guardada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["email-templates", ctx?.tenantId] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || !ctx.canManage) return null;
  const vars = sampleVars(ctx.negocio);

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
            <Mail size={18} />
          </span>
          <div>
            <Heading as="h3" className="text-base">Emails</Heading>
            <p className="text-sm text-muted-foreground">
              Editá los emails del sistema. El envío automático se activa al conectar
              el proveedor (Resend).
            </p>
          </div>
        </div>

        {/* Selector de plantilla */}
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {EMAIL_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSelectedKey(t.key)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-1.5 text-sm transition",
                selectedKey === t.key
                  ? "bg-ninja-flame/12 font-medium text-ninja-flameSoft"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">{def.description}</p>

        <Input
          label="Asunto"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />

        <div>
          <label className="mb-2 block text-sm font-medium text-muted-foreground">
            Contenido (HTML)
          </label>
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            rows={7}
            className="w-full rounded-lg border border-input bg-background p-3 font-mono text-xs text-foreground outline-none focus:border-ninja-flameSoft focus:ring-2 focus:ring-ninja-flameSoft/20"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Variables: {def.variables.map((v) => `{{${v}}}`).join("  ")}
          </p>
        </div>

        {/* Preview */}
        <div>
          <div className="mb-2 text-sm font-medium text-muted-foreground">
            Vista previa
          </div>
          <div className="rounded-lg border border-border bg-white p-4 text-sm text-neutral-900">
            <div className="mb-2 border-b border-neutral-200 pb-2 text-xs text-neutral-500">
              Asunto: {renderTemplate(subject, vars)}
            </div>
            <div
              // Contenido propio del dueño; solo preview.
              dangerouslySetInnerHTML={{ __html: renderTemplate(html, vars) }}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar plantilla"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
