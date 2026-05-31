"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Palette } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Heading } from "@/components/ui/Typography";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { resizeToWebp } from "@/lib/utils/image";
import { cn } from "@/lib/utils/cn";

const BUCKET = "tenant-assets";
const PRESET_ACCENTS = [
  "#EC3F17", "#FF6A1A", "#FFB020", "#FFD21F", "#16A34A",
  "#2DB8A3", "#0EA5E9", "#3B82F6", "#7C4DFF", "#A855F7",
  "#E8456B", "#111827",
];

type Branding = {
  logo_path: string | null;
  logo_url: string | null;
  accent: string;
  legal_name: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  ticket_footer: string | null;
  ticket_width: string;
};
const EMPTY: Branding = {
  logo_path: null,
  logo_url: null,
  accent: "#EC3F17",
  legal_name: null,
  cuit: null,
  phone: null,
  address: null,
  ticket_footer: null,
  ticket_width: "80",
};

type BrandingRow = { [K in keyof Branding]?: string | null };
type Ctx = { tenantId: string; canManage: boolean; branding: BrandingRow } | null;

export function BrandingCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Branding | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: ctx } = useQuery<Ctx>({
    queryKey: ["my-branding-ctx"],
    queryFn: async (): Promise<Ctx> => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return null;
      const { data: mem } = await supabase
        .from("tenant_users")
        .select("tenant_id, role")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (!mem) return null;
      const canManage = ["owner", "manager"].includes(mem.role);
      if (!canManage) return { tenantId: mem.tenant_id, canManage, branding: {} };
      const { data: b } = await supabase
        .from("tenant_branding")
        .select(
          "logo_path, logo_url, accent, legal_name, cuit, phone, address, ticket_footer, ticket_width",
        )
        .eq("tenant_id", mem.tenant_id)
        .maybeSingle();
      return { tenantId: mem.tenant_id, canManage, branding: b ?? {} };
    },
  });

  // Sembrar el formulario desde los datos (arregla que desaparecía al volver).
  useEffect(() => {
    if (!ctx?.canManage) return;
    const b = ctx.branding;
    setForm({
      logo_path: b.logo_path ?? null,
      logo_url: b.logo_url ?? null,
      accent: b.accent ?? EMPTY.accent,
      legal_name: b.legal_name ?? null,
      cuit: b.cuit ?? null,
      phone: b.phone ?? null,
      address: b.address ?? null,
      ticket_footer: b.ticket_footer ?? null,
      ticket_width: b.ticket_width ?? EMPTY.ticket_width,
    });
  }, [ctx]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form || !ctx) return;
      const { error } = await supabase
        .from("tenant_branding")
        .upsert({ tenant_id: ctx.tenantId, ...form }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Marca guardada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["my-branding-ctx"] });
    },
    onError: () => toast({ title: "No se pudo guardar", variant: "error" }),
  });

  if (!ctx || !ctx.canManage || !form) return null;
  const tenantId = ctx.tenantId;

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

  return (
    <Card className="mt-6">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-ninja-flame/12 text-ninja-flameSoft">
            <Palette size={18} />
          </span>
          <div>
            <Heading as="h3" className="text-base">Marca del negocio</Heading>
            <p className="text-sm text-muted-foreground">
              Logo, color y datos que se ven en tickets, comprobantes y catálogo.
            </p>
          </div>
        </div>

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
            {form.logo_url && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => set("logo_url", null)}
              >
                Quitar
              </Button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => onLogo(e.target.files?.[0])}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Se convierte a WebP.</p>
        </div>

        {/* Acento con presets + color libre */}
        <div>
          <span className="mb-2 block text-sm font-medium text-muted-foreground">
            Color de acento
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {PRESET_ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("accent", c)}
                className={cn(
                  "h-8 w-8 rounded-full ring-2 transition",
                  form.accent.toUpperCase() === c ? "ring-foreground" : "ring-transparent",
                )}
                style={{ background: c }}
                title={c}
              />
            ))}
            <label
              className="flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-xs text-muted-foreground"
              title="Color personalizado"
            >
              <span
                className="h-4 w-4 rounded-full border border-black/10"
                style={{ background: form.accent }}
              />
              {form.accent}
              <input
                type="color"
                className="sr-only"
                value={/^#[0-9a-fA-F]{6}$/.test(form.accent) ? form.accent : "#EC3F17"}
                onChange={(e) => set("accent", e.target.value.toUpperCase())}
              />
            </label>
          </div>
        </div>

        {/* Datos comerciales */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Razón social" value={form.legal_name ?? ""} onChange={(e) => set("legal_name", e.target.value)} />
          <Input label="CUIT" value={form.cuit ?? ""} onChange={(e) => set("cuit", e.target.value)} />
          <Input label="Teléfono" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
          <Input label="Dirección" value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} />
        </div>
        <Input
          label="Pie de ticket"
          placeholder="¡Gracias por su compra!"
          value={form.ticket_footer ?? ""}
          onChange={(e) => set("ticket_footer", e.target.value)}
        />

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

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Guardando…" : "Guardar marca"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
