"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Palette } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { resizeToWebp } from "@/lib/utils/image";
import { cn } from "@/lib/utils/cn";

const BUCKET = "tenant-assets";
// Acentos dentro de los límites de marca NinjaPos.
const ACCENTS = ["#EC3F17", "#FF6A1A", "#FFB020", "#7C4DFF", "#2DB8A3"];

type Branding = {
  logo_path: string | null;
  logo_url: string | null;
  accent: string | null;
  legal_name: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  ticket_footer: string | null;
};
const EMPTY: Branding = {
  logo_path: null,
  logo_url: null,
  accent: ACCENTS[0]!,
  legal_name: null,
  cuit: null,
  phone: null,
  address: null,
  ticket_footer: null,
};

export function BrandingCard({ tenantId }: { tenantId: string }) {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Branding | null>(null);
  const [busy, setBusy] = useState(false);

  useQuery({
    queryKey: ["tenant-branding", tenantId],
    queryFn: async () => {
      const { data } = await supabase
        .from("tenant_branding")
        .select("logo_path, logo_url, accent, legal_name, cuit, phone, address, ticket_footer")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      setForm({ ...EMPTY, ...(data ?? {}) });
      return data ?? EMPTY;
    },
  });

  function set<K extends keyof Branding>(k: K, v: Branding[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }

  async function onLogo(file: File | undefined) {
    if (!file || !form) return;
    setBusy(true);
    try {
      const webp = await resizeToWebp(file, 400, 0.9);
      const path = `${tenantId}/logo-${crypto.randomUUID()}.webp`;
      const up = await supabase.storage
        .from(BUCKET)
        .upload(path, webp, { contentType: "image/webp", upsert: false });
      if (up.error) throw up.error;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      setForm({ ...form, logo_path: path, logo_url: pub.publicUrl });
      toast({ title: "Logo cargado", variant: "success" });
    } catch (e) {
      toast({
        title: "No se pudo subir el logo",
        description: e instanceof Error ? e.message : undefined,
        variant: "error",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const { error } = await supabase
        .from("tenant_branding")
        .upsert({ tenant_id: tenantId, ...form }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Branding guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: ["tenant-branding", tenantId] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!form) return null;

  return (
    <section className="mt-8">
      <Heading as="h2" className="flex items-center gap-2">
        <Palette size={18} /> Marca del negocio
      </Heading>
      <Card className="mt-3">
        <CardContent className="space-y-5 p-5">
          {/* Logo */}
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">Logo</span>
            <div className="flex items-center gap-4">
              <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-lg border border-border bg-muted">
                {form.logo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.logo_url} alt="Logo" className="h-full w-full object-contain" />
                ) : (
                  <ImagePlus size={20} className="text-muted-foreground" />
                )}
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {form.logo_url ? "Cambiar logo" : "Subir logo"}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => onLogo(e.target.files?.[0])}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Se convierte a WebP. Se usa en tickets, catálogo y emails.
            </p>
          </div>

          {/* Acento */}
          <div>
            <span className="mb-2 block text-sm font-medium text-muted-foreground">
              Color de acento
            </span>
            <div className="flex flex-wrap gap-2">
              {ACCENTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("accent", c)}
                  className={cn(
                    "h-8 w-8 rounded-full ring-2 transition",
                    form.accent === c ? "ring-foreground" : "ring-transparent",
                  )}
                  style={{ background: c }}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* Datos comerciales */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Razón social"
              value={form.legal_name ?? ""}
              onChange={(e) => set("legal_name", e.target.value)}
            />
            <Input
              label="CUIT"
              value={form.cuit ?? ""}
              onChange={(e) => set("cuit", e.target.value)}
            />
            <Input
              label="Teléfono"
              value={form.phone ?? ""}
              onChange={(e) => set("phone", e.target.value)}
            />
            <Input
              label="Dirección"
              value={form.address ?? ""}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <Input
            label="Pie de ticket"
            placeholder="¡Gracias por su compra!"
            value={form.ticket_footer ?? ""}
            onChange={(e) => set("ticket_footer", e.target.value)}
          />

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Guardando…" : "Guardar marca"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
