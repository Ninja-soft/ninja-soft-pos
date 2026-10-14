"use client";

// Configuración › Ticket › Diseño de facturas y comprobantes (ADR-112).
// Elegir modelo A4 y ticket, color de resalte, logo, sello de Ninja Soft,
// datos fiscales del emisor, leyendas y opciones, con vista previa en vivo de
// cada tipo (A, B, C, NC, no fiscal) con datos de ejemplo. Se guarda en
// tenant_branding (invoice_style, iibb, activity_start); la base exige el plan
// (trigger trg_assert_invoice_style_feature), acá sólo se muestra el candado.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Lock, ReceiptText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { Badge } from "@/components/ui/Badge";
import { choiceClass } from "@/components/ui/ChoiceCard";
import { useToast } from "@/components/ui/Toast";
import { useFeatureGate } from "@/components/saas/GatedAction";
import { cn } from "@/lib/utils/cn";
import { useTenantTicketBranding } from "@/modules/tickets/hooks";
import { INVOICE_SETTINGS_KEY, useInvoiceEntitlements, useInvoiceSettings } from "@/modules/invoices/hooks";
import { A4_MODELS, TICKET_MODELS, type ModelInfo } from "@/lib/invoices/models";
import {
  NINJA_POS_ACCENT,
  normalizeInvoiceStyle,
  resolveInvoiceStyle,
  type InvoiceStyleSettings,
} from "@/lib/invoices/style";
import { previewBrand, sampleInvoice, SAMPLE_KINDS, type SampleKind } from "@/lib/invoices/samples";
import { uploadTicketImage } from "@/lib/tickets/uploadTicketImage";
import { InvoiceDocument, type InvoiceFormat } from "@/components/invoices/InvoiceDocument";
import { InvoiceFit } from "@/components/invoices/InvoiceFit";

const HEX = /^#[0-9a-fA-F]{6}$/;

// Etiquetas cortas para que entren en el control segmentado.
const KIND_OPTIONS = SAMPLE_KINDS.map((k) => ({
  value: k.value,
  label: k.value === "X" ? "No fiscal" : k.value,
}));

type Ctx = { tenantId: string; canManage: boolean } | null;

function useManageCtx() {
  return useQuery<Ctx>({
    queryKey: ["invoice-style-ctx"],
    queryFn: async () => {
      const supabase = createClient();
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
      return { tenantId: mem.tenant_id, canManage: ["owner", "manager"].includes(mem.role) };
    },
  });
}

interface Form {
  style: InvoiceStyleSettings;
  iibb: string;
  activity_start: string;
}

export function InvoiceStyleCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: ctx } = useManageCtx();
  const { data: brand } = useTenantTicketBranding(Boolean(ctx?.canManage));
  const settingsQ = useInvoiceSettings(Boolean(ctx?.canManage));
  const { pro, unbranded } = useInvoiceEntitlements();
  const ent = useMemo(() => ({ pro, unbranded }), [pro, unbranded]);
  const proGate = useFeatureGate("tickets_pro", "Personalización de comprobantes");
  const sealGate = useFeatureGate("comprobantes_sin_sello", "Comprobantes sin sello NinjaSoft");

  const [form, setForm] = useState<Form | null>(null);
  const [kind, setKind] = useState<SampleKind>("B");
  const [format, setFormat] = useState<InvoiceFormat>("a4");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settingsQ.isFetched || form) return;
    const s = settingsQ.data;
    setForm({
      style: normalizeInvoiceStyle(s?.invoice_style ?? {}),
      iibb: s?.iibb ?? "",
      activity_start: s?.activity_start ?? "",
    });
  }, [settingsQ.isFetched, settingsQ.data, form]);

  const preview = useMemo(() => {
    if (!form) return null;
    const b = previewBrand(
      brand ? { ...brand, iibb: form.iibb || null, activity_start: form.activity_start || null } : null,
      kind,
    );
    const style = resolveInvoiceStyle(form.style, b, ent);
    const doc = sampleInvoice(kind, b, {
      tradeName: style.tradeName,
      legends: style.legends,
      showPayments: style.showPayments,
      showInternalRef: style.showInternalRef,
    });
    return { style, doc };
  }, [form, brand, kind, ent]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form || !ctx) return;
      const sb = createClient() as unknown as {
        from: (t: string) => {
          update: (r: Record<string, unknown>) => { eq: (c: string, v: string) => PromiseLike<{ error: { message: string } | null }> };
          insert: (r: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
        };
      };
      const patch = {
        invoice_style: form.style,
        iibb: form.iibb.trim() || null,
        activity_start: form.activity_start || null,
      };
      // UPDATE (no upsert): no dispara el trigger de marca con el acento por defecto.
      const exists = settingsQ.data != null || brand != null;
      const { error } = exists
        ? await sb.from("tenant_branding").update(patch).eq("tenant_id", ctx.tenantId)
        : await sb.from("tenant_branding").insert({ tenant_id: ctx.tenantId, ...patch });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast({ title: "Diseño de comprobantes guardado", variant: "success" });
      qc.invalidateQueries({ queryKey: INVOICE_SETTINGS_KEY });
    },
    onError: (e: Error) =>
      toast({
        title: e.message.includes("feature_not_in_plan")
          ? "Tu plan no incluye una de las opciones elegidas"
          : "No se pudo guardar el diseño",
        variant: "error",
      }),
  });

  if (!ctx?.canManage || !form || !preview) return null;

  const setStyle = (patch: Partial<InvoiceStyleSettings>) => setForm((f) => (f ? { ...f, style: { ...f.style, ...patch } } : f));
  const s = form.style;
  const brandAccent = brand?.accent && HEX.test(brand.accent) ? brand.accent : null;

  function pickModel<K extends string>(m: ModelInfo<K>, apply: () => void) {
    if (m.pro) proGate.run(apply);
    else apply();
  }

  async function onUpload(file: File) {
    if (!ctx) return;
    setUploading(true);
    try {
      const url = await uploadTicketImage(file, ctx.tenantId);
      setStyle({ logo_mode: "custom", logo_custom_url: url });
    } catch {
      toast({ title: "No se pudo subir el logo", variant: "error" });
    } finally {
      setUploading(false);
    }
  }

  const proLocked = !ent.pro;

  return (
    <Card>
      <CardContent className="space-y-6 p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-ninja-flameSoft">
            <ReceiptText size={17} aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Diseño de facturas y comprobantes</h3>
            <p className="text-sm text-muted-foreground">
              Modelos A4 y de ticket con todo lo que pide ARCA: letra y código, CAE, QR, IVA y transparencia
              fiscal. Se usan cuando no tenés un modelo propio activo.
            </p>
          </div>
        </div>

        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="min-w-0 space-y-6">
            <Field title="Modelo A4" hint="Factura en hoja A4: PDF descargable, email e impresión en hoja.">
              <ModelGrid
                models={A4_MODELS}
                value={s.a4_model}
                locked={proLocked}
                onPick={(m) =>
                  pickModel(m, () => {
                    setStyle({ a4_model: m.key });
                    setFormat("a4");
                  })
                }
              />
            </Field>

            <Field title="Modelo de ticket" hint="Impresora térmica de 80 o 58 mm.">
              <ModelGrid
                models={TICKET_MODELS}
                value={s.ticket_model}
                locked={proLocked}
                onPick={(m) =>
                  pickModel(m, () => {
                    setStyle({ ticket_model: m.key });
                    if (m.key !== "simple") setFormat((f) => (f === "a4" ? "80" : f));
                  })
                }
              />
            </Field>

            <Field title="Color de resalte">
              <Segmented
                value={s.accent_mode}
                onChange={(v) =>
                  v === "custom"
                    ? proGate.run(() => setStyle({ accent_mode: "custom", accent_custom: s.accent_custom ?? brandAccent ?? NINJA_POS_ACCENT }))
                    : setStyle({ accent_mode: "brand" })
                }
                options={[
                  { value: "brand", label: "El de mi marca" },
                  { value: "custom", label: "Otro color" },
                ]}
                size="sm"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {s.accent_mode === "custom" ? (
                  <label className="flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border px-3" title="Elegir color">
                    <span className="h-4 w-4 rounded-full border border-black/10" style={{ background: s.accent_custom ?? NINJA_POS_ACCENT }} />
                    {s.accent_custom}
                    <input
                      type="color"
                      className="sr-only"
                      value={s.accent_custom && HEX.test(s.accent_custom) ? s.accent_custom : NINJA_POS_ACCENT}
                      onChange={(e) => setStyle({ accent_custom: e.target.value.toUpperCase() })}
                    />
                  </label>
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="h-4 w-4 rounded-full border border-black/10" style={{ background: brandAccent ?? NINJA_POS_ACCENT }} />
                    {brandAccent
                      ? `Color de tu marca (${brandAccent}).`
                      : "Tu marca no tiene color: se usa el de Ninja POS. Lo cambiás en Configuración › Marca."}
                  </span>
                )}
              </div>
            </Field>

            <Field title="Logo del comprobante">
              <Segmented
                value={s.logo_mode}
                onChange={(v) =>
                  v === "custom"
                    ? proGate.run(() => (s.logo_custom_url ? setStyle({ logo_mode: "custom" }) : fileRef.current?.click()))
                    : setStyle({ logo_mode: v })
                }
                options={[
                  { value: "brand", label: "El de mi marca" },
                  { value: "custom", label: "Otro logo" },
                  { value: "none", label: "Sin logo" },
                ]}
                size="sm"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUpload(f);
                  e.target.value = "";
                }}
              />
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {s.logo_mode === "custom" && s.logo_custom_url ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.logo_custom_url} alt="" className="h-9 max-w-[140px] rounded bg-white object-contain p-1" />
                    <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={uploading}>
                      <ImageUp size={15} /> Cambiar
                    </Button>
                  </>
                ) : s.logo_mode === "brand" ? (
                  <span>
                    {brand?.logo_url
                      ? "Se usa el logo de tu marca."
                      : "Tu marca no tiene logo: se usa el de Ninja POS."}
                  </span>
                ) : s.logo_mode === "none" ? (
                  <span>El comprobante sale sin logo.</span>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} loading={uploading}>
                    <ImageUp size={15} /> Subir logo
                  </Button>
                )}
              </div>
            </Field>

            <Row
              title="Sello “Un software de Ninja Soft”"
              hint={ent.unbranded ? "Con el logo de Ninja Soft al pie." : "Ocultarlo es parte de los planes Business y Enterprise."}
              locked={!ent.unbranded}
            >
              <Switch
                checked={s.show_ninja_seal}
                onCheckedChange={(v) => (v ? setStyle({ show_ninja_seal: true }) : sealGate.run(() => setStyle({ show_ninja_seal: false })))}
                label="Mostrar el sello de Ninja Soft"
              />
            </Row>

            <Field title="Datos fiscales del emisor" hint="La factura los exige (RG 1415). La razón social, el CUIT, el domicilio y la condición frente al IVA salen de Configuración › Marca.">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Ingresos Brutos"
                  placeholder="901-123456-7 o Convenio Multilateral"
                  value={form.iibb}
                  maxLength={60}
                  onChange={(e) => setForm({ ...form, iibb: e.target.value })}
                />
                <Input
                  label="Inicio de actividades"
                  type="date"
                  value={form.activity_start}
                  onChange={(e) => setForm({ ...form, activity_start: e.target.value })}
                />
                <Input
                  label="Nombre de fantasía (opcional)"
                  placeholder="Se muestra arriba de la razón social"
                  value={s.trade_name}
                  maxLength={120}
                  onChange={(e) => setStyle({ trade_name: e.target.value })}
                />
              </div>
            </Field>

            <Field title="Leyendas propias" hint="Una por línea. Se suman a las obligatorias." locked={proLocked}>
              <textarea
                value={s.legends}
                rows={3}
                maxLength={600}
                onFocus={() => proLocked && proGate.run(() => undefined)}
                readOnly={proLocked}
                onChange={(e) => setStyle({ legends: e.target.value })}
                placeholder="Cambios dentro de los 30 días con este comprobante."
                className="w-full rounded-xl border border-transparent bg-fg-6 p-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground/80 focus:bg-[var(--background)]"
              />
            </Field>

            <div className="space-y-4">
              <Row title="Mostrar medios de pago">
                <Switch checked={s.show_payments} onCheckedChange={(v) => setStyle({ show_payments: v })} label="Mostrar medios de pago" />
              </Row>
              <Row title="Mostrar el número interno de la venta" hint="Además del número fiscal.">
                <Switch checked={s.show_internal_ref} onCheckedChange={(v) => setStyle({ show_internal_ref: v })} label="Mostrar el número interno" />
              </Row>
              <Row title="Copias de la hoja A4">
                <Segmented
                  value={String(s.a4_copies) as "1" | "2"}
                  onChange={(v) => setStyle({ a4_copies: v === "2" ? 2 : 1 })}
                  options={[
                    { value: "1", label: "Original" },
                    { value: "2", label: "Original y duplicado" },
                  ]}
                  size="sm"
                />
              </Row>
              <Row title="PDF del email" hint="Qué se adjunta al mandar el comprobante por email.">
                <Segmented
                  value={s.email_format}
                  onChange={(v) => setStyle({ email_format: v })}
                  options={[
                    { value: "ticket", label: "Ticket" },
                    { value: "a4", label: "Hoja A4" },
                  ]}
                  size="sm"
                />
              </Row>
            </div>
          </div>

          <div className="order-first min-w-0 2xl:sticky 2xl:top-4 2xl:order-none 2xl:self-start">
            <div className="space-y-3 rounded-xl bg-muted/60 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">Vista previa</span>
                <Segmented
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: "a4", label: "A4" },
                    { value: "80", label: "80 mm" },
                    { value: "58", label: "58 mm" },
                  ]}
                  size="sm"
                />
              </div>
              <Segmented value={kind} onChange={setKind} options={KIND_OPTIONS} size="sm" fill aria-label="Tipo de comprobante" />
              <div className="overflow-hidden rounded-lg bg-white">
                {format === "a4" ? (
                  <div className="mx-auto max-w-[520px]">
                    <InvoiceFit>
                      <InvoiceDocument doc={preview.doc} style={preview.style} format="a4" />
                    </InvoiceFit>
                  </div>
                ) : s.ticket_model === "simple" ? (
                  <p className="p-6 text-center text-sm text-neutral-600">
                    El modelo Simple es el ticket de bloques de siempre: no cambia.
                  </p>
                ) : (
                  <div className="flex justify-center bg-neutral-100 py-4">
                    <InvoiceDocument doc={preview.doc} style={preview.style} format={format} />
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Datos de ejemplo. Lo que todavía no cargaste del negocio se completa con datos ficticios.
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Guardar diseño
          </Button>
        </div>
      </CardContent>
      {proGate.modal}
      {sealGate.modal}
    </Card>
  );
}

function Field({ title, hint, locked, children }: { title: string; hint?: string; locked?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {locked && (
          <Badge tone="brand">
            <Lock size={11} aria-hidden /> Pro
          </Badge>
        )}
      </div>
      {hint && <p className="-mt-1 mb-2 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function Row({ title, hint, locked, children }: { title: string; hint?: string; locked?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {locked && <Lock size={13} className="text-muted-foreground" aria-hidden />}
        </span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ModelGrid<K extends string>({
  models,
  value,
  locked,
  onPick,
}: {
  models: ModelInfo<K>[];
  value: K;
  locked: boolean;
  onPick: (m: ModelInfo<K>) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {models.map((m) => (
        <button key={m.key} type="button" aria-pressed={value === m.key} onClick={() => onPick(m)} className={choiceClass(value === m.key, "p-3")}>
          <span className="flex items-center gap-2 pr-6 text-sm font-semibold text-foreground">
            {m.name}
            {m.pro && locked && (
              <Badge tone="brand" className={cn("px-2 py-0 text-[10px]")}>
                <Lock size={10} aria-hidden /> Pro
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{m.description}</span>
        </button>
      ))}
    </div>
  );
}
