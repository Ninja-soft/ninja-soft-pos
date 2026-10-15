"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, ImagePlus, ReceiptText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { Card, CardContent } from "@/components/ui/Card";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { resizeToWebp } from "@/lib/utils/image";
import { cn } from "@/lib/utils/cn";
import { cleanTradeName, TRADE_NAME_MAX } from "@/lib/branding/businessName";
import { BUSINESS_NAME_QUERY_KEYS } from "@/modules/tenants/businessName";
import { BrandingPadron, type BrandingPadronValues } from "@/components/dashboard-team/BrandingPadron";
import { EMITTER_CONDITIONS, FISCAL_CONDITION_LABEL, JURISDICTIONS, isValidCuit } from "@/lib/tax/catalog";
import { useSaveTaxSettings, useTaxSettings } from "@/modules/tax/hooks";
import type { TaxSettings } from "@/modules/tax/api";

const BUCKET = "tenant-assets";
const selectCls =
  "h-11 w-full rounded-lg border border-input bg-background px-4 text-sm text-foreground outline-none focus:border-ninja-flameSoft focus:ring-4 focus:ring-ninja-flameSoft/15 disabled:opacity-60";

type LooseSelect = {
  from: (t: string) => {
    select: (c: string) => {
      eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
    };
  };
};
const PRESET_ACCENTS = [
  "#EC3F17", "#FF6A1A", "#FFB020", "#FFD21F", "#16A34A",
  "#2DB8A3", "#0EA5E9", "#3B82F6", "#7C4DFF", "#A855F7",
  "#E8456B", "#111827",
];

type Branding = {
  /** ADR-124: nombre de fantasía (el que se muestra en toda la app y al cliente). */
  trade_name: string | null;
  logo_path: string | null;
  logo_url: string | null;
  accent: string;
  legal_name: string | null;
  cuit: string | null;
  phone: string | null;
  address: string | null;
  // ADR-133: datos fiscales para la factura (el comprobante lee iibb y
  // activity_start de tenant_branding; la condición y la jurisdicción viven en
  // tax_settings).
  iibb: string | null;
  activity_start: string | null;
  iva_condition: string | null;
  iibb_jurisdiction: string | null;
  convenio_multilateral: boolean;
  fiscal_source: "padron" | "manual" | null;
  /** Se trajeron datos de ARCA en esta edición (pide verificar al servidor). */
  verify_now: boolean;
};
const EMPTY: Branding = {
  trade_name: null,
  logo_path: null,
  logo_url: null,
  accent: "#EC3F17",
  legal_name: null,
  cuit: null,
  phone: null,
  address: null,
  iibb: null,
  activity_start: null,
  iva_condition: null,
  iibb_jurisdiction: null,
  convenio_multilateral: false,
  fiscal_source: null,
  verify_now: false,
};

type BrandingRow = { [K in keyof Branding]?: string | boolean | null };
type Ctx = {
  tenantId: string;
  canManage: boolean;
  branding: BrandingRow;
  /** tenants.name: fallback del nombre de fantasía. */
  tenantName: string | null;
  /** false si la columna trade_name todavía no existe (migración sin aplicar). */
  tradeNameReady: boolean;
  /** false si fiscal_source todavía no existe (migración de ADR-133 sin aplicar). */
  fiscalReady: boolean;
  fiscalVerifiedAt: string | null;
} | null;

export function BrandingCard() {
  const supabase = createClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Branding | null>(null);
  const [busy, setBusy] = useState(false);
  const tax = useTaxSettings();
  const saveTax = useSaveTaxSettings();

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
      if (!canManage)
        return { tenantId: mem.tenant_id, canManage, branding: {}, tenantName: null, tradeNameReady: false, fiscalReady: false, fiscalVerifiedAt: null };
      // trade_name en consulta aparte: sin la migración aplicada la columna no
      // existe y el resto de la marca se tiene que poder editar igual.
      const [{ data: b }, trade, { data: t }, fiscal, invoice] = await Promise.all([
        supabase
          .from("tenant_branding")
          .select("logo_path, logo_url, accent, legal_name, cuit, phone, address")
          .eq("tenant_id", mem.tenant_id)
          .maybeSingle(),
        (supabase as unknown as LooseSelect)
          .from("tenant_branding")
          .select("trade_name")
          .eq("tenant_id", mem.tenant_id)
          .maybeSingle(),
        supabase.from("tenants").select("name").eq("id", mem.tenant_id).maybeSingle(),
        (supabase as unknown as LooseSelect)
          .from("tenant_branding")
          .select("fiscal_source, fiscal_verified_at")
          .eq("tenant_id", mem.tenant_id)
          .maybeSingle(),
        (supabase as unknown as LooseSelect)
          .from("tenant_branding")
          .select("iibb, activity_start")
          .eq("tenant_id", mem.tenant_id)
          .maybeSingle(),
      ]);
      const f = (fiscal.data as { fiscal_source?: string | null; fiscal_verified_at?: string | null } | null) ?? null;
      const inv = (invoice.data as { iibb?: string | null; activity_start?: string | null } | null) ?? null;
      const tradeName = (trade.data as { trade_name?: string | null } | null)?.trade_name ?? null;
      return {
        tenantId: mem.tenant_id,
        canManage,
        branding: {
          ...(b ?? {}),
          trade_name: tradeName,
          iibb: inv?.iibb ?? null,
          activity_start: inv?.activity_start ?? null,
          fiscal_source: f?.fiscal_source ?? null,
        },
        tenantName: t?.name ?? null,
        tradeNameReady: !trade.error,
        fiscalReady: !fiscal.error,
        fiscalVerifiedAt: f?.fiscal_verified_at ?? null,
      };
    },
  });

  // Sembrar el formulario desde los datos (arregla que desaparecía al volver).
  useEffect(() => {
    if (!ctx?.canManage) return;
    const b = ctx.branding;
    setForm({
      trade_name: (b.trade_name as string | null) ?? null,
      logo_path: (b.logo_path as string | null) ?? null,
      logo_url: (b.logo_url as string | null) ?? null,
      accent: (b.accent as string | null) ?? EMPTY.accent,
      legal_name: (b.legal_name as string | null) ?? null,
      cuit: (b.cuit as string | null) ?? null,
      phone: (b.phone as string | null) ?? null,
      address: (b.address as string | null) ?? null,
      iibb: (b.iibb as string | null) ?? tax.data?.iibb_number ?? null,
      activity_start: (b.activity_start as string | null) ?? tax.data?.activity_start ?? null,
      iva_condition: tax.data?.iva_condition ?? null,
      iibb_jurisdiction: tax.data?.iibb_jurisdiction ?? null,
      convenio_multilateral: tax.data?.convenio_multilateral ?? false,
      fiscal_source: (b.fiscal_source as "padron" | "manual" | null) ?? null,
      verify_now: false,
    });
  }, [ctx, tax.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form || !ctx) return;
      const {
        trade_name,
        iva_condition,
        iibb_jurisdiction,
        convenio_multilateral,
        fiscal_source,
        verify_now,
        iibb,
        activity_start,
        ...rest
      } = form;
      const row: Record<string, unknown> = {
        tenant_id: ctx.tenantId,
        ...rest,
        iibb: iibb?.trim() || null,
        activity_start: activity_start || null,
      };
      if (ctx.tradeNameReady) row.trade_name = cleanTradeName(trade_name);
      // ADR-133: "padron" lo valida el trigger con la consulta real.
      if (ctx.fiscalReady && fiscal_source) {
        row.fiscal_source = fiscal_source;
        if (fiscal_source === "padron" && verify_now) row.fiscal_verified_at = new Date().toISOString();
      }
      const { error } = await supabase
        .from("tenant_branding")
        .upsert(row as never, { onConflict: "tenant_id" });
      if (error) throw error;
      // Condición, IIBB e inicio también en Impuestos (la letra y ARCA los leen de ahí).
      const t = tax.data;
      if (t?.can_write && t.features.iva) {
        const cuitDigits = (form.cuit ?? "").replace(/\D/g, "");
        const patch: Partial<TaxSettings> = {};
        if ((iva_condition ?? null) !== (t.iva_condition ?? null)) patch.iva_condition = iva_condition as TaxSettings["iva_condition"];
        if (isValidCuit(cuitDigits) && cuitDigits !== (t.cuit ?? "")) patch.cuit = cuitDigits;
        if ((iibb?.trim() || null) !== (t.iibb_number ?? null)) patch.iibb_number = iibb?.trim() || null;
        if ((iibb_jurisdiction ?? null) !== (t.iibb_jurisdiction ?? null)) patch.iibb_jurisdiction = iibb_jurisdiction;
        if (convenio_multilateral !== t.convenio_multilateral) patch.convenio_multilateral = convenio_multilateral;
        if ((activity_start || null) !== (t.activity_start ?? null)) patch.activity_start = activity_start || null;
        if (Object.keys(patch).length > 0) await saveTax.mutateAsync(patch);
      }
    },
    onSuccess: () => {
      toast({ title: "Marca guardada", variant: "success" });
      // ADR-124: el nombre se ve en la barra lateral, el ticket, el login, etc.
      for (const queryKey of BUSINESS_NAME_QUERY_KEYS) qc.invalidateQueries({ queryKey: [...queryKey] });
      router.refresh();
    },
    onError: (e) =>
      toast({
        title: "No se pudo guardar",
        description: /padron_verification_missing/.test(String((e as { message?: string } | null)?.message ?? ""))
          ? "Volvé a consultar ARCA con ese CUIT antes de guardar."
          : undefined,
        variant: "error",
      }),
  });

  if (!ctx || !ctx.canManage || !form) return null;
  const tenantId = ctx.tenantId;

  function set<K extends keyof Branding>(k: K, v: Branding[K]) {
    setForm((f) => (f ? { ...f, [k]: v } : f));
  }
  // Editar a mano un dato que puede venir de ARCA lo marca "cargado a mano".
  function setFiscal<K extends keyof Branding>(k: K, v: Branding[K]) {
    setForm((f) => (f ? { ...f, [k]: v, fiscal_source: "manual", verify_now: false } : f));
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
    <Card>
      <CardContent className="space-y-6 p-5 sm:p-6">
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
              className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground"
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

        {/* Datos comerciales. ADR-124: el nombre de fantasía es el que se
            muestra en toda la app y al cliente; la razón social, en lo fiscal. */}
        <div className="grid gap-3 sm:grid-cols-2">
          {ctx.tradeNameReady && (
            <div className="sm:col-span-2">
              <Input
                label="Nombre de fantasía"
                placeholder={ctx.tenantName ?? "El nombre de tu negocio"}
                hint={`El que ven tu equipo y tus clientes: barra lateral, tickets, facturas, presupuestos, emails y catálogo. Vacío: ${ctx.tenantName ?? "el nombre de la cuenta"}.`}
                value={form.trade_name ?? ""}
                maxLength={TRADE_NAME_MAX}
                onChange={(e) => set("trade_name", e.target.value)}
              />
            </div>
          )}
          <Input
            label="CUIT"
            inputMode="numeric"
            value={form.cuit ?? ""}
            onChange={(e) => set("cuit", e.target.value)}
            error={(form.cuit ?? "").replace(/\D/g, "").length === 11 && !isValidCuit(form.cuit) ? "CUIT inválida: revisá los 11 números" : undefined}
            hint="Con el CUIT completo traemos tus datos de ARCA."
          />
          <Input label="Teléfono" value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
          {ctx.fiscalReady && (
            <div className="sm:col-span-2">
              <BrandingPadron
                cuit={form.cuit}
                current={{
                  legal_name: form.legal_name,
                  iva_condition: form.iva_condition,
                  address: form.address,
                  activity_start: form.activity_start,
                  iibb_jurisdiction: form.iibb_jurisdiction,
                }}
                source={form.fiscal_source}
                verifiedAt={form.verify_now ? null : ctx.fiscalVerifiedAt}
                onAccept={(v: Partial<BrandingPadronValues>) =>
                  setForm((f) => (f ? { ...f, ...v, fiscal_source: "padron", verify_now: true } : f))
                }
              />
            </div>
          )}
          <Input label="Razón social" value={form.legal_name ?? ""} onChange={(e) => setFiscal("legal_name", e.target.value)} />
          <Input label="Dirección" value={form.address ?? ""} onChange={(e) => setFiscal("address", e.target.value)} />
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">Condición frente al IVA</label>
            <select
              className={selectCls}
              value={form.iva_condition ?? ""}
              disabled={!tax.data?.can_write}
              onChange={(e) => setFiscal("iva_condition", e.target.value || null)}
            >
              <option value="">Sin definir</option>
              {EMITTER_CONDITIONS.map((c) => (
                <option key={c} value={c} className="bg-popover text-popover-foreground">
                  {FISCAL_CONDITION_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Inicio de actividades"
            type="date"
            value={form.activity_start ?? ""}
            onChange={(e) => setFiscal("activity_start", e.target.value || null)}
          />
          <Input
            label="N° de Ingresos Brutos"
            value={form.iibb ?? ""}
            maxLength={30}
            onChange={(e) => set("iibb", e.target.value)}
            hint="Sale en tus facturas. ARCA no lo informa: cargalo a mano."
          />
          <div>
            <label className="mb-2 block text-sm font-medium text-muted-foreground">Ingresos Brutos</label>
            <select
              className={selectCls}
              value={form.convenio_multilateral ? "cm" : "local"}
              disabled={!tax.data?.can_write}
              onChange={(e) => set("convenio_multilateral", e.target.value === "cm")}
            >
              <option value="local">Local (una sola provincia)</option>
              <option value="cm">Convenio Multilateral</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-2 block text-sm font-medium text-muted-foreground">
              {form.convenio_multilateral ? "Jurisdicción sede" : "Jurisdicción"}
            </label>
            <select
              className={selectCls}
              value={form.iibb_jurisdiction ?? ""}
              disabled={!tax.data?.can_write}
              onChange={(e) => set("iibb_jurisdiction", e.target.value || null)}
            >
              <option value="">Sin especificar</option>
              {JURISDICTIONS.map((j) => (
                <option key={j.code} value={j.code} className="bg-popover text-popover-foreground">
                  {j.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {/* Las opciones del ticket (ancho, textos, logo) viven en su propia
            sección: Configuración › Ticket. Acá sólo marca y datos. */}
        <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-ninja-flameSoft">
              <ReceiptText size={17} aria-hidden />
            </span>
            <div>
              <span className="block text-sm font-medium text-foreground">Ticket</span>
              <span className="block text-xs text-muted-foreground">
                Ancho del papel, título, leyenda, pie y logo del comprobante.
              </span>
            </div>
          </div>
          <Link
            href="/configuracion?seccion=tickets"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            Configurar ticket <ChevronRight size={15} aria-hidden />
          </Link>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Guardar marca
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
